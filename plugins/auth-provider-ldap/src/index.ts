/**
 * LDAP / Active Directory Auth Provider — implements the AuthProvider interface
 * for LDAP-based identity stores including Microsoft Active Directory, OpenLDAP,
 * and FreeIPA.
 *
 * Flow:
 *   1. initialize()          — validate config, resolve bind password, probe connection
 *   2. authenticate()        — bind as the user to verify credentials
 *   3. getUserAttributes()   — search for user entry and return LDAP attributes
 *   4. getGroupMembership()  — enumerate group DNs for the user
 *   5. mapGroupsToRoles()    — map LDAP group names → platform RBAC role names
 *   6. mapClaimsToRoles()    — convenience wrapper used by the auth flow
 *
 * Sandbox constraint: isolated-vm does not allow native Node.js modules (ldapjs,
 * node-ldapauth, etc.). All LDAP wire-protocol communication is delegated to the
 * platform's LDAP proxy service via FetchProxy. The plugin owns configuration
 * validation, filter construction, attribute mapping, and role mapping — it never
 * touches a TCP socket directly.
 *
 * LDAP proxy API contract (HTTP/JSON over FetchProxy):
 *   POST /ldap/bind   { url, baseDN, bindDN, bindPassword, useTLS, tlsOptions, timeoutMs }
 *                     → { success: bool, error?: string }
 *   POST /ldap/search { url, baseDN, bindDN, bindPassword, useTLS, tlsOptions, timeoutMs,
 *                       searchBase, filter, attributes, sizeLimit }
 *                     → { entries: LdapEntry[], error?: string }
 *
 * The proxy endpoint URL is provided by the platform as context.tenant.config["ldapProxyUrl"].
 * This is injected by the Auth Service and is not exposed to tenant admins.
 *
 * getAuthorizationUrl() / handleCallback() are not meaningful for direct LDAP bind
 * authentication (there is no browser redirect in this flow). They are implemented
 * to satisfy the AuthProvider interface: getAuthorizationUrl() returns the
 * platform's internal credential-entry URL, and handleCallback() performs the
 * full authenticate → getUserAttributes → mapClaimsToRoles sequence using the
 * credentials forwarded by the Auth Service in the callback code field.
 */

import type {
  AuthProvider,
  AuthProviderMetadata,
  AuthOptions,
  AuthContext,
  AuthResult,
  CallbackParams,
  TokenValidation,
  PluginContext,
  FetchProxy,
  PluginLogger,
} from "@oneplatform/plugin-sdk";
import {
  PluginAuthError,
  PluginConfigError,
  PluginTimeoutError,
} from "@oneplatform/plugin-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Configuration types
// ────────────────────────────────────────────────────────────────────────────

/** Validated, typed representation of the tenant-admin configuration. */
interface LdapConfig {
  url: string;
  baseDN: string;
  bindDN: string;
  /** Name of the credential holding the bind password. */
  bindCredentialKey: string;
  userSearchBase: string;
  userSearchFilter: string;
  userAttributes: string[];
  groupSearchBase: string | null;
  groupSearchFilter: string;
  groupNameAttribute: string;
  /** LDAP group name → OnePlatform role name. */
  groupMapping: Record<string, string>;
  useTLS: boolean;
  tlsOptions: LdapTlsOptions;
  searchSizeLimit: number;
  connectionTimeoutMs: number;
}

interface LdapTlsOptions {
  rejectUnauthorized: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// LDAP proxy response shapes (internal contract with the platform proxy)
// ────────────────────────────────────────────────────────────────────────────

interface LdapBindResponse {
  success: boolean;
  error?: string;
}

interface LdapEntry {
  dn: string;
  attributes: Record<string, string | string[]>;
}

interface LdapSearchResponse {
  entries: LdapEntry[];
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Config parsing
// ────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): LdapConfig {
  const url = raw["url"];
  if (typeof url !== "string" || url.trim() === "") {
    throw new PluginConfigError("url is required and must be a non-empty string", "url");
  }

  // LDAP URLs use ldap:// (plain or STARTTLS) or ldaps:// (implicit TLS).
  // We reject other schemes to prevent accidental plain-HTTP LDAP proxy calls.
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith("ldap://") && !trimmedUrl.startsWith("ldaps://")) {
    throw new PluginConfigError(
      `url must use ldap:// or ldaps:// scheme. Received: "${trimmedUrl}"`,
      "url",
    );
  }

  const baseDN = raw["baseDN"];
  if (typeof baseDN !== "string" || baseDN.trim() === "") {
    throw new PluginConfigError("baseDN is required and must be a non-empty string", "baseDN");
  }

  const bindDN = raw["bindDN"];
  if (typeof bindDN !== "string" || bindDN.trim() === "") {
    throw new PluginConfigError("bindDN is required and must be a non-empty string", "bindDN");
  }

  const bindCredentialKey = raw["bindCredentialKey"];
  const resolvedBindCredentialKey =
    typeof bindCredentialKey === "string" && bindCredentialKey.trim() !== ""
      ? bindCredentialKey.trim()
      : "ldap_bind_password";

  const userSearchBase = raw["userSearchBase"];
  if (typeof userSearchBase !== "string" || userSearchBase.trim() === "") {
    throw new PluginConfigError(
      "userSearchBase is required and must be a non-empty string",
      "userSearchBase",
    );
  }

  const rawUserSearchFilter = raw["userSearchFilter"];
  const userSearchFilter =
    typeof rawUserSearchFilter === "string" && rawUserSearchFilter.trim() !== ""
      ? rawUserSearchFilter.trim()
      : "(uid={{username}})";

  const rawUserAttributes = raw["userAttributes"];
  const userAttributes: string[] =
    Array.isArray(rawUserAttributes) && rawUserAttributes.length > 0
      ? rawUserAttributes.map(String)
      : ["dn", "uid", "cn", "mail", "givenName", "sn", "memberOf"];

  // dn is always required — the group search filter substitutes it.
  if (!userAttributes.includes("dn")) {
    userAttributes.unshift("dn");
  }

  const rawGroupSearchBase = raw["groupSearchBase"];
  const groupSearchBase =
    typeof rawGroupSearchBase === "string" && rawGroupSearchBase.trim() !== ""
      ? rawGroupSearchBase.trim()
      : null;

  const rawGroupSearchFilter = raw["groupSearchFilter"];
  const groupSearchFilter =
    typeof rawGroupSearchFilter === "string" && rawGroupSearchFilter.trim() !== ""
      ? rawGroupSearchFilter.trim()
      : "(member={{dn}})";

  const rawGroupNameAttribute = raw["groupNameAttribute"];
  const groupNameAttribute =
    typeof rawGroupNameAttribute === "string" && rawGroupNameAttribute.trim() !== ""
      ? rawGroupNameAttribute.trim()
      : "cn";

  const rawGroupMapping = raw["groupMapping"];
  const groupMapping: Record<string, string> =
    rawGroupMapping !== null &&
    rawGroupMapping !== undefined &&
    typeof rawGroupMapping === "object" &&
    !Array.isArray(rawGroupMapping)
      ? Object.fromEntries(
          Object.entries(rawGroupMapping as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string",
          ),
        )
      : {};

  // useTLS defaults to true — operators must explicitly opt out.
  // ldaps:// connections always use TLS regardless of this flag.
  const rawUseTLS = raw["useTLS"];
  const useTLS = rawUseTLS === false ? false : true;

  const rawTlsOptions = raw["tlsOptions"];
  const tlsOptions: LdapTlsOptions =
    rawTlsOptions !== null &&
    rawTlsOptions !== undefined &&
    typeof rawTlsOptions === "object" &&
    !Array.isArray(rawTlsOptions)
      ? {
          rejectUnauthorized:
            (rawTlsOptions as Record<string, unknown>)["rejectUnauthorized"] !== false,
        }
      : { rejectUnauthorized: true };

  const rawSizeLimit = raw["searchSizeLimit"];
  const searchSizeLimit =
    typeof rawSizeLimit === "number" && rawSizeLimit >= 1 && rawSizeLimit <= 1000
      ? Math.floor(rawSizeLimit)
      : 200;

  const rawTimeout = raw["connectionTimeoutMs"];
  const connectionTimeoutMs =
    typeof rawTimeout === "number" && rawTimeout >= 1000 && rawTimeout <= 30000
      ? Math.floor(rawTimeout)
      : 5000;

  return {
    url: trimmedUrl,
    baseDN: baseDN.trim(),
    bindDN: bindDN.trim(),
    bindCredentialKey: resolvedBindCredentialKey,
    userSearchBase: userSearchBase.trim(),
    userSearchFilter,
    userAttributes,
    groupSearchBase,
    groupSearchFilter,
    groupNameAttribute,
    groupMapping,
    useTLS,
    tlsOptions,
    searchSizeLimit,
    connectionTimeoutMs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// LDAP filter construction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a search base DN by combining the OU prefix with baseDN.
 *
 * When userSearchBase is already a full DN (contains baseDN), return it as-is.
 * Otherwise append baseDN: "ou=users" + "dc=example,dc=com" → "ou=users,dc=example,dc=com".
 */
function buildSearchBase(searchBase: string, baseDN: string): string {
  // Match dc=, o=, or c= only when they appear as RDN components (at start or after a comma),
  // preventing false positives from OU names containing these substrings (e.g., "ou=production").
  if (/(?:^|,)\s*(dc|o|c)\s*=/i.test(searchBase)) {
    // Looks like a full DN — use as-is
    return searchBase;
  }
  return `${searchBase},${baseDN}`;
}

/**
 * Substitute a template variable in an LDAP filter string.
 *
 * The LDAP filter syntax uses parentheses and special characters.
 * Values are LDAP-escaped before substitution to prevent filter injection.
 * RFC 4515 defines the escaping rules: *, (, ), \, and NUL must be escaped.
 */
function buildFilter(template: string, variable: string, value: string): string {
  const escaped = escapeLdapFilterValue(value);
  return template.replace(new RegExp(`\\{\\{${variable}\\}\\}`, "g"), escaped);
}

/**
 * Escape a value for inclusion in an LDAP search filter per RFC 4515.
 *
 * Characters that must be escaped in a filter assertion value:
 *   *  → \2a
 *   (  → \28
 *   )  → \29
 *   \  → \5c
 *   \0 → \00 (NUL — unusual but possible in binary attributes)
 */
function escapeLdapFilterValue(value: string): string {
  return value
    .replace(/\\/g, "\\5c")
    .replace(/\*/g, "\\2a")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\0/g, "\\00");
}

// ────────────────────────────────────────────────────────────────────────────
// LDAP proxy client
//
// Wraps HTTP calls to the platform's LDAP proxy. The proxy handles the actual
// TCP/TLS connection so the plugin sandbox never opens network sockets directly.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Common connection parameters forwarded to the LDAP proxy with every request.
 * The proxy uses these to establish (or reuse from its pool) an LDAP connection.
 */
interface LdapConnectionParams {
  url: string;
  baseDN: string;
  bindDN: string;
  bindPassword: string;
  useTLS: boolean;
  tlsOptions: LdapTlsOptions;
  timeoutMs: number;
}

/**
 * Attempt a bind operation via the LDAP proxy.
 *
 * A successful bind proves that the given DN and password are valid.
 * Used both for the service-account bind during search and for user
 * credential verification during authentication.
 */
async function proxyBind(
  proxyUrl: string,
  params: LdapConnectionParams,
  fetchProxy: FetchProxy,
  logger: PluginLogger,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchProxy.fetch(`${proxyUrl}/ldap/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PluginTimeoutError(`LDAP proxy bind request failed: ${message}`);
  }

  let body: LdapBindResponse;
  try {
    body = (await response.json()) as LdapBindResponse;
  } catch {
    throw new PluginAuthError(
      `LDAP proxy returned non-JSON response from /ldap/bind (HTTP ${response.status})`,
      { status: response.status, proxyUrl },
    );
  }

  if (!response.ok || !body.success) {
    const reason = body.error ?? `HTTP ${response.status}`;
    logger.debug("LDAP bind failed", { bindDN: params.bindDN, reason });
    throw new PluginAuthError("LDAP bind failed", { reason });
  }

  logger.debug("LDAP bind successful", { bindDN: params.bindDN });
}

/**
 * Execute an LDAP search via the proxy.
 *
 * The proxy performs the search using the service account credentials (bindDN)
 * so the search itself is authenticated even when the user's own credentials
 * are not used here.
 */
async function proxySearch(
  proxyUrl: string,
  connection: LdapConnectionParams,
  searchBase: string,
  filter: string,
  attributes: string[],
  sizeLimit: number,
  fetchProxy: FetchProxy,
  logger: PluginLogger,
  scope?: "base" | "one" | "sub",
): Promise<LdapEntry[]> {
  let response: Response;
  try {
    response = await fetchProxy.fetch(`${proxyUrl}/ldap/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...connection,
        searchBase,
        filter,
        attributes,
        sizeLimit,
        ...(scope !== undefined ? { scope } : {}),
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PluginTimeoutError(`LDAP proxy search request failed: ${message}`);
  }

  let body: LdapSearchResponse;
  try {
    body = (await response.json()) as LdapSearchResponse;
  } catch {
    throw new PluginAuthError(
      `LDAP proxy returned non-JSON response from /ldap/search (HTTP ${response.status})`,
      { status: response.status, proxyUrl, searchBase, filter },
    );
  }

  if (!response.ok || body.error !== undefined) {
    const reason = body.error ?? `HTTP ${response.status}`;
    throw new PluginAuthError(`LDAP search failed: ${reason}`, {
      searchBase,
      filter,
      reason,
    });
  }

  logger.debug("LDAP search completed", {
    searchBase,
    filter,
    entryCount: body.entries.length,
  });

  return body.entries;
}

// ────────────────────────────────────────────────────────────────────────────
// Credential encoding helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Encode username and password into the callback "code" field.
 *
 * The AuthProvider interface is designed around OAuth2's code-flow. For LDAP,
 * the Auth Service collects credentials from the user via a login form and
 * forwards them to the plugin as a JSON-encoded base64 value in the "code" field.
 * This matches the convention used by SAML plugins (base64 assertion in "code").
 *
 * Format: base64(JSON({ username, password }))
 */
function encodeCredentials(username: string, password: string): string {
  const payload = JSON.stringify({ username, password });
  return typeof Buffer !== "undefined"
    ? Buffer.from(payload).toString("base64")
    : btoa(payload);
}

/**
 * Decode the credentials from the callback "code" field.
 *
 * Returns null if the code is not a valid base64-JSON credential pair — the
 * caller treats this as an invalid-code error.
 */
function decodeCredentials(code: string): { username: string; password: string } | null {
  try {
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(code, "base64").toString("utf8")
        : atob(code);
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["username"] === "string" &&
      typeof (parsed as Record<string, unknown>)["password"] === "string"
    ) {
      return {
        username: (parsed as Record<string, unknown>)["username"] as string,
        password: (parsed as Record<string, unknown>)["password"] as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cache keys
// ────────────────────────────────────────────────────────────────────────────

// The bind password is resolved by initialize() and cached so handleCallback()
// (which receives AuthContext without credential access) can use it for searches.
// TTL of 3600s — rotated at plugin re-enable time via a new initialize() call.
const BIND_PASSWORD_CACHE_KEY = "ldap:bindPassword";

// The platform LDAP proxy URL is injected by the Auth Service into
// tenant.config["ldapProxyUrl"]. We cache it at initialize() time.
const PROXY_URL_CACHE_KEY = "ldap:proxyUrl";

// ────────────────────────────────────────────────────────────────────────────
// Main provider class
// ────────────────────────────────────────────────────────────────────────────

class LdapAuthProvider implements AuthProvider {
  /** Parsed configuration set by initialize(). */
  private config: LdapConfig | null = null;

  /**
   * FetchProxy captured at initialize() time.
   *
   * AuthProvider interface methods receive AuthContext, which deliberately omits
   * FetchProxy. We capture it once here so LDAP proxy calls (which need FetchProxy)
   * work correctly from handleCallback() and validateToken() without threading
   * PluginContext through the entire call graph.
   */
  private fetchProxy: FetchProxy | null = null;

  /**
   * Platform LDAP proxy URL, set at initialize() time.
   *
   * Injected by the Auth Service via context.tenant.config["ldapProxyUrl"].
   * Not a tenant-admin config field — operators cannot override it.
   */
  private proxyUrl: string | null = null;

  metadata(): AuthProviderMetadata {
    return {
      type: "auth-provider",
      id: "com.oneplatform.auth-provider-ldap",
      name: "LDAP / Active Directory Auth Provider",
      description:
        "LDAP and Active Directory authentication. Authenticates users via LDAP bind, searches user attributes and group memberships, and maps LDAP groups to OnePlatform RBAC roles.",
      version: "1.0.0",
      author: "OnePlatform",
      protocol: "ldap",
      supportsTokenValidation: true,
      supportsTokenRefresh: false,
      tags: ["ldap", "active-directory", "ad", "sso", "enterprise", "directory"],
      configSchema: {
        type: "object",
        // bindCredentialKey is omitted from required: parseConfig applies a default
        // of 'ldap_bind_password' when the field is absent, making it optional.
        required: ["url", "baseDN", "bindDN", "userSearchBase"],
        properties: {
          url: { type: "string", format: "uri" },
          baseDN: { type: "string" },
          bindDN: { type: "string" },
          bindCredentialKey: { type: "string" },
          userSearchBase: { type: "string" },
          userSearchFilter: { type: "string" },
          userAttributes: { type: "array", items: { type: "string" } },
          groupSearchBase: { type: "string" },
          groupSearchFilter: { type: "string" },
          groupNameAttribute: { type: "string" },
          groupMapping: { type: "object", additionalProperties: { type: "string" } },
          useTLS: { type: "boolean" },
          tlsOptions: { type: "object" },
          searchSizeLimit: { type: "number", minimum: 1, maximum: 1000 },
          connectionTimeoutMs: { type: "number", minimum: 1000, maximum: 30000 },
        },
        additionalProperties: false,
      },
    };
  }

  /**
   * Initialize the provider with the tenant configuration.
   *
   * Called once by the platform after loading the plugin bundle with the full
   * PluginContext. We use this opportunity to:
   *   1. Parse and validate the configuration.
   *   2. Capture the FetchProxy and platform LDAP proxy URL.
   *   3. Resolve the bind password from CredentialAccessor and store in cache.
   *   4. Probe the LDAP connection so misconfiguration is caught immediately.
   */
  async initialize(config: Record<string, unknown>, context: PluginContext): Promise<void> {
    const span = context.tracing.startSpan("LdapAuthProvider.initialize");

    try {
      this.config = parseConfig(config);
      this.fetchProxy = context.fetch;

      // The LDAP proxy URL is injected by the platform — not a tenant-admin field.
      const rawProxyUrl = context.tenant.config["ldapProxyUrl"];
      if (typeof rawProxyUrl !== "string" || rawProxyUrl.trim() === "") {
        throw new PluginConfigError(
          "ldapProxyUrl is not configured in tenant context — ensure the Auth Service version supports LDAP plugins",
          "ldapProxyUrl",
        );
      }
      this.proxyUrl = rawProxyUrl.trim();

      // Resolve the bind password now so AuthContext-scoped methods can read it
      // from cache. Credentials are not accessible from AuthContext.
      const bindPassword = await context.credentials.get(this.config.bindCredentialKey);
      await context.cache.set(BIND_PASSWORD_CACHE_KEY, bindPassword, 3600);
      await context.cache.set(PROXY_URL_CACHE_KEY, this.proxyUrl, 3600);

      // Probe the LDAP connection with the service-account bind to surface
      // misconfiguration (wrong URL, bad credentials, TLS issues) at enable time
      // rather than on first user login.
      const connectionParams = this.buildConnectionParams(bindPassword);
      await proxyBind(this.proxyUrl, connectionParams, context.fetch, context.logger);

      context.logger.info("LDAP provider initialized", {
        url: this.config.url,
        baseDN: this.config.baseDN,
        bindDN: this.config.bindDN,
        useTLS: this.config.useTLS,
      });

      span.setAttribute("ldap.url", this.config.url);
      span.setAttribute("ldap.baseDN", this.config.baseDN);
    } finally {
      span.end();
    }
  }

  /**
   * Build the URL that the Auth Service shows to the user for LDAP credential entry.
   *
   * LDAP is not a redirect-based protocol — there is no external IdP URL to
   * navigate to. The Auth Service uses a platform-hosted credential-entry page
   * (/auth/ldap/login) where the user enters username and password. The state
   * parameter is embedded in the page's form so it survives the POST to handleCallback.
   *
   * This is synchronous and makes no network calls, matching the AuthProvider contract.
   */
  getAuthorizationUrl(state: string, options: AuthOptions): string {
    const cfg = this.requireConfig();

    // Build the platform's credential-entry page URL. The Auth Service routes
    // POST /auth/ldap/callback to handleCallback() after the user submits.
    const params = new URLSearchParams();

    if (options.additionalParams !== undefined) {
      for (const [key, value] of Object.entries(options.additionalParams)) {
        params.set(key, value);
      }
    }

    params.set("state", state);
    params.set("redirect_uri", options.redirectUri);
    params.set("provider", cfg.url);

    // Use the platform's internal LDAP login page. This URL is not external —
    // the Auth Service hosts it to collect username/password before calling back.
    return `/auth/ldap/login?${params.toString()}`;
  }

  /**
   * Handle the LDAP authentication callback.
   *
   * The Auth Service encodes { username, password } as base64-JSON in params.code
   * after the user submits the credential-entry form. We:
   *   1. Decode the credentials from the code field.
   *   2. Bind as the user to verify the password.
   *   3. Re-bind as the service account and search for the user's attributes.
   *   4. Resolve group memberships.
   *   5. Map groups to platform roles.
   *
   * Sensitive values (passwords) are never logged or returned in error details.
   */
  async handleCallback(params: CallbackParams, context: AuthContext): Promise<AuthResult> {
    const cfg = this.requireConfig();
    const fetchProxy = this.requireFetch();

    if (params.error !== undefined) {
      throw new PluginAuthError(
        `LDAP callback error: ${params.errorDescription ?? params.error}`,
        { error: params.error, errorDescription: params.errorDescription },
      );
    }

    if (params.code.trim() === "") {
      throw new PluginAuthError("LDAP callback received an empty code — expected base64-encoded credentials");
    }

    const creds = decodeCredentials(params.code);
    if (creds === null) {
      throw new PluginAuthError(
        "LDAP callback code could not be decoded as base64-JSON credentials",
      );
    }

    const { username, password } = creds;

    if (username.trim() === "") {
      throw new PluginAuthError("LDAP login requires a non-empty username");
    }

    if (password.trim() === "") {
      // Many LDAP servers treat whitespace-only passwords identically to empty
      // passwords, performing an anonymous bind that succeeds without credential
      // verification. Trim before checking to close this bypass.
      throw new PluginAuthError("LDAP login requires a non-empty password");
    }

    const proxyUrl = await this.requireProxyUrl(context);
    const bindPassword = await this.requireBindPassword(context);

    // Step 1: Find the user's DN by searching with the service account.
    // We must know the DN before we can bind as the user.
    const userDN = await this.findUserDN(
      proxyUrl,
      cfg,
      username,
      bindPassword,
      fetchProxy,
      context.logger,
    );

    // Step 2: Bind as the user to verify their password.
    // This is the definitive credential check — a successful bind proves the password is correct.
    const userConnectionParams: LdapConnectionParams = {
      url: cfg.url,
      baseDN: cfg.baseDN,
      bindDN: userDN,
      bindPassword: password,
      useTLS: cfg.useTLS,
      tlsOptions: cfg.tlsOptions,
      timeoutMs: cfg.connectionTimeoutMs,
    };

    try {
      await proxyBind(proxyUrl, userConnectionParams, fetchProxy, context.logger);
    } catch (err) {
      if (err instanceof PluginAuthError) {
        // Preserve the auth error type but sanitize the message — we do not want
        // the bind DN (containing the username) leaking into generic error displays.
        throw new PluginAuthError("LDAP authentication failed: invalid username or password");
      }
      throw err;
    }

    // Step 3: Fetch user attributes using the service account (post-auth search).
    const userEntry = await this.fetchUserEntry(
      proxyUrl,
      cfg,
      username,
      bindPassword,
      fetchProxy,
      context.logger,
    );

    // Step 4: Resolve group memberships.
    const groups = await this.getGroupMembership(
      proxyUrl,
      cfg,
      userDN,
      userEntry,
      bindPassword,
      fetchProxy,
      context.logger,
    );

    // Step 5: Map groups to platform roles.
    const platformRoles = this.mapGroupsToRoles(groups, cfg.groupMapping);

    // Build the claims object from LDAP attributes so mapClaimsToRoles() can
    // operate uniformly across auth providers.
    const claims = this.buildClaims(userDN, userEntry.attributes, groups);

    context.logger.info("LDAP login successful", {
      username,
      groupCount: groups.length,
      roleCount: platformRoles.length,
    });

    // LDAP does not issue tokens — the platform's Auth Service creates a session
    // token after successful authentication. We return the user DN as the access
    // token placeholder; the Auth Service ignores this value for LDAP providers.
    return {
      accessToken: userDN,
      claims,
      platformRoles,
      providerUserId: userDN,
    };
  }

  /**
   * Validate a session token for LDAP-authenticated users.
   *
   * LDAP does not have a token introspection endpoint. We validate the token
   * by verifying the user still exists in the directory (the account has not been
   * deleted or disabled since the last login). Group memberships are re-checked
   * so role changes take effect on the next request.
   *
   * Returns valid=false rather than throwing for "user not found" or "account disabled" —
   * these are expected states that should revoke the session, not cause 500 errors.
   */
  async validateToken(token: string, context: AuthContext): Promise<TokenValidation> {
    const cfg = this.requireConfig();
    const fetchProxy = this.requireFetch();

    if (token.trim() === "") {
      return { valid: false, error: "Empty token" };
    }

    // For LDAP, the "token" is the user's DN (set by handleCallback).
    // Verify the DN still exists by searching for it.
    const proxyUrl = await this.requireProxyUrl(context);
    const bindPassword = await this.requireBindPassword(context);
    const connection = this.buildConnectionParams(bindPassword);

    // Search for the DN directly — a DN-scoped search with scope=base is the
    // most efficient way to check existence. We use a general object search filter
    // and scope='base' to avoid an expensive subtree scan.
    const searchBase = token.trim();
    const filter = "(objectClass=*)";

    let entries: LdapEntry[];
    try {
      entries = await proxySearch(
        proxyUrl,
        connection,
        searchBase,
        filter,
        cfg.userAttributes,
        1,
        fetchProxy,
        context.logger,
        "base",
      );
    } catch (err) {
      if (err instanceof PluginAuthError || err instanceof PluginTimeoutError) {
        return { valid: false, error: err.message };
      }
      throw err;
    }

    if (entries.length === 0) {
      return { valid: false, error: "User DN no longer exists in directory" };
    }

    const userEntry = entries[0];
    if (userEntry === undefined) {
      return { valid: false, error: "User DN no longer exists in directory" };
    }

    let groups: string[];
    try {
      groups = await this.getGroupMembership(
        proxyUrl,
        cfg,
        token.trim(),
        userEntry,
        bindPassword,
        fetchProxy,
        context.logger,
      );
    } catch (err) {
      if (err instanceof PluginAuthError || err instanceof PluginTimeoutError) {
        return { valid: false, error: err.message };
      }
      throw err;
    }

    const claims = this.buildClaims(token.trim(), userEntry.attributes, groups);

    context.logger.debug("LDAP token validation successful", {
      dn: token.trim(),
      groupCount: groups.length,
    });

    return { valid: true, claims };
  }

  /**
   * Map external identity provider claims to OnePlatform RBAC role names.
   *
   * Reads the "groups" claim (populated by handleCallback from LDAP group search)
   * and applies the groupMapping dictionary. This satisfies the AuthProvider
   * interface contract — it is the synchronous entry point the platform calls
   * on every token validation to refresh role assignments.
   *
   * Synchronous and must not make network calls per the AuthProvider interface contract.
   */
  mapClaimsToRoles(claims: Record<string, unknown>): string[] {
    const cfg = this.config;
    if (cfg === null) {
      return [];
    }

    const rawGroups = claims["groups"];
    if (!Array.isArray(rawGroups)) {
      return [];
    }

    const groups = rawGroups.filter((g): g is string => typeof g === "string");
    return this.mapGroupsToRoles(groups, cfg.groupMapping);
  }

  // ── Public helpers (used by tests to exercise the mapping logic directly) ──

  /**
   * Map LDAP group names to OnePlatform RBAC role names.
   *
   * Groups absent from the mapping are dropped silently. This is intentional —
   * not every LDAP group is relevant to the platform. Operators configure only
   * the groups that grant platform access.
   *
   * Synchronous and must not make network calls.
   */
  mapGroupsToRoles(groups: string[], groupMapping: Record<string, string>): string[] {
    const platformRoles: string[] = [];

    for (const group of groups) {
      const role = groupMapping[group];
      if (role !== undefined) {
        platformRoles.push(role);
      }
    }

    return platformRoles;
  }

  /**
   * Build the LDAP search filter for user lookup by substituting the username.
   *
   * Exposed for testing so filter injection prevention can be verified directly.
   */
  buildUserSearchFilter(filterTemplate: string, username: string): string {
    return buildFilter(filterTemplate, "username", username);
  }

  /**
   * Build the LDAP search filter for group membership by substituting the user DN.
   *
   * Exposed for testing so filter construction can be verified directly.
   */
  buildGroupSearchFilter(filterTemplate: string, userDN: string): string {
    return buildFilter(filterTemplate, "dn", userDN);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Find a user's DN by searching the directory with the service account.
   *
   * This is a separate step from fetching attributes because we need the DN
   * before binding as the user. The search uses the configured userSearchFilter.
   */
  private async findUserDN(
    proxyUrl: string,
    cfg: LdapConfig,
    username: string,
    bindPassword: string,
    fetchProxy: FetchProxy,
    logger: PluginLogger,
  ): Promise<string> {
    const connection = this.buildConnectionParamsFrom(cfg, bindPassword);
    const searchBase = buildSearchBase(cfg.userSearchBase, cfg.baseDN);
    const filter = buildFilter(cfg.userSearchFilter, "username", username);

    const entries = await proxySearch(
      proxyUrl,
      connection,
      searchBase,
      filter,
      // Only request dn for the initial DN-lookup search — reduces data transfer.
      ["dn"],
      1,
      fetchProxy,
      logger,
    );

    if (entries.length === 0) {
      throw new PluginAuthError(
        "LDAP authentication failed: invalid username or password",
      );
    }

    const entry = entries[0];
    if (entry === undefined || entry.dn.trim() === "") {
      throw new PluginAuthError(
        "LDAP search returned an entry without a DN — directory may be misconfigured",
      );
    }

    return entry.dn;
  }

  /**
   * Fetch the full user entry (all configured attributes) by username.
   *
   * Called after the user bind has already verified credentials, so we know
   * the user exists. Uses the service account to search (more reliable than
   * re-using the user's own bind for searches after auth).
   */
  private async fetchUserEntry(
    proxyUrl: string,
    cfg: LdapConfig,
    username: string,
    bindPassword: string,
    fetchProxy: FetchProxy,
    logger: PluginLogger,
  ): Promise<LdapEntry> {
    const connection = this.buildConnectionParamsFrom(cfg, bindPassword);
    const searchBase = buildSearchBase(cfg.userSearchBase, cfg.baseDN);
    const filter = buildFilter(cfg.userSearchFilter, "username", username);

    const entries = await proxySearch(
      proxyUrl,
      connection,
      searchBase,
      filter,
      cfg.userAttributes,
      1,
      fetchProxy,
      logger,
    );

    if (entries.length === 0 || entries[0] === undefined) {
      throw new PluginAuthError(
        "LDAP user entry not found after successful bind — directory inconsistency detected",
        { username },
      );
    }

    return entries[0];
  }

  /**
   * Resolve group memberships for a user.
   *
   * Two strategies are supported:
   *   1. memberOf attribute on the user entry (Active Directory, many LDAP servers).
   *      Used when groupSearchBase is null.
   *   2. Explicit group search with groupSearchFilter (OpenLDAP posixGroup style).
   *      Used when groupSearchBase is configured.
   *
   * Strategy 2 takes precedence when groupSearchBase is set.
   * Strategy 1 falls back to memberOf when groupSearchBase is null.
   *
   * Returns group *names* (the groupNameAttribute value), not DNs.
   */
  private async getGroupMembership(
    proxyUrl: string,
    cfg: LdapConfig,
    userDN: string,
    userEntry: LdapEntry,
    bindPassword: string,
    fetchProxy: FetchProxy,
    logger: PluginLogger,
  ): Promise<string[]> {
    if (cfg.groupSearchBase !== null) {
      return this.searchGroupsExplicitly(
        proxyUrl,
        cfg,
        userDN,
        bindPassword,
        fetchProxy,
        logger,
      );
    }

    // Fall back to memberOf attribute on the user object.
    return this.extractMemberOfGroups(userEntry.attributes, cfg.groupNameAttribute, logger);
  }

  /**
   * Search the directory for groups that the user is a member of.
   *
   * Used when groupSearchBase is configured. The groupSearchFilter template
   * has {{dn}} substituted with the user's DN.
   */
  private async searchGroupsExplicitly(
    proxyUrl: string,
    cfg: LdapConfig,
    userDN: string,
    bindPassword: string,
    fetchProxy: FetchProxy,
    logger: PluginLogger,
  ): Promise<string[]> {
    // groupSearchBase is non-null at this call site (checked by caller)
    const groupSearchBase = cfg.groupSearchBase as string;
    const connection = this.buildConnectionParamsFrom(cfg, bindPassword);
    const searchBase = buildSearchBase(groupSearchBase, cfg.baseDN);
    const filter = buildFilter(cfg.groupSearchFilter, "dn", userDN);

    const entries = await proxySearch(
      proxyUrl,
      connection,
      searchBase,
      filter,
      [cfg.groupNameAttribute],
      cfg.searchSizeLimit,
      fetchProxy,
      logger,
    );

    const groupNames: string[] = [];
    for (const entry of entries) {
      const nameAttr = entry.attributes[cfg.groupNameAttribute];
      if (typeof nameAttr === "string" && nameAttr.trim() !== "") {
        groupNames.push(nameAttr.trim());
      } else if (Array.isArray(nameAttr) && nameAttr.length > 0) {
        const first = nameAttr[0];
        if (typeof first === "string" && first.trim() !== "") {
          groupNames.push(first.trim());
        }
      }
    }

    logger.debug("Resolved group memberships via group search", {
      userDN,
      groupCount: groupNames.length,
    });

    return groupNames;
  }

  /**
   * Extract group names from the memberOf attribute on the user's LDAP entry.
   *
   * Each memberOf value is a full DN (e.g., "cn=Domain Admins,ou=groups,dc=example,dc=com").
   * We extract the first RDN component value (the cn) as the group name.
   * This avoids a second round-trip to search for group entries.
   */
  private extractMemberOfGroups(
    attributes: Record<string, string | string[]>,
    groupNameAttribute: string,
    logger: PluginLogger,
  ): string[] {
    const memberOf = attributes["memberOf"];
    if (memberOf === undefined) {
      logger.debug("No memberOf attribute on user entry — user has no LDAP group memberships");
      return [];
    }

    const memberDNs = typeof memberOf === "string" ? [memberOf] : memberOf;
    const groupNames: string[] = [];

    for (const dn of memberDNs) {
      // The memberOf DN's first RDN attribute is fixed by the directory schema (typically "cn=").
      // Always extract the value of the first RDN regardless of groupNameAttribute, since
      // groupNameAttribute refers to the attribute fetched from group entries during explicit
      // group search and is not applicable to DN parsing here.
      const firstRDN = dn.split(",")[0] ?? "";
      const eqIndex = firstRDN.indexOf("=");
      if (eqIndex !== -1) {
        const name = firstRDN.slice(eqIndex + 1).trim();
        if (name !== "") {
          groupNames.push(name);
        }
      }
    }

    logger.debug("Resolved group memberships via memberOf attribute", {
      groupCount: groupNames.length,
    });

    return groupNames;
  }

  /**
   * Build the claims object from LDAP attributes.
   *
   * The claims object mirrors the shape expected by mapClaimsToRoles() and
   * matches what the platform stores in the session for RBAC decisions.
   */
  private buildClaims(
    userDN: string,
    attributes: Record<string, string | string[]>,
    groups: string[],
  ): Record<string, unknown> {
    // Flatten multi-valued attributes to their first value for scalar fields.
    // Preserve arrays for multi-valued fields (groups, memberOf).
    const flattenAttr = (value: string | string[] | undefined): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === "string") return value;
      return value[0];
    };

    return {
      sub: userDN,
      dn: userDN,
      uid: flattenAttr(attributes["uid"]),
      cn: flattenAttr(attributes["cn"]),
      mail: flattenAttr(attributes["mail"]),
      givenName: flattenAttr(attributes["givenName"]),
      sn: flattenAttr(attributes["sn"]),
      groups,
      // Include raw memberOf DNs for auditing — callers interested in the full
      // path can read this, while mapClaimsToRoles uses the resolved names in "groups".
      memberOf: attributes["memberOf"] ?? [],
    };
  }

  private buildConnectionParams(bindPassword: string): LdapConnectionParams {
    return this.buildConnectionParamsFrom(this.requireConfig(), bindPassword);
  }

  private buildConnectionParamsFrom(cfg: LdapConfig, bindPassword: string): LdapConnectionParams {
    return {
      url: cfg.url,
      baseDN: cfg.baseDN,
      bindDN: cfg.bindDN,
      bindPassword,
      useTLS: cfg.useTLS,
      tlsOptions: cfg.tlsOptions,
      timeoutMs: cfg.connectionTimeoutMs,
    };
  }

  private requireConfig(): LdapConfig {
    if (this.config === null) {
      throw new PluginConfigError(
        "LDAP provider not initialized — initialize() must be called before any auth methods",
        "url",
      );
    }
    return this.config;
  }

  private requireFetch(): FetchProxy {
    if (this.fetchProxy === null) {
      throw new PluginConfigError(
        "LDAP provider FetchProxy not set — initialize() must be called before any auth methods",
        "url",
      );
    }
    return this.fetchProxy;
  }

  private async requireBindPassword(context: AuthContext): Promise<string> {
    const cached = await context.cache.get<string>(BIND_PASSWORD_CACHE_KEY);
    if (cached === null) {
      throw new PluginAuthError(
        "LDAP bind password not available — ensure initialize() completed before the first login",
      );
    }
    return cached;
  }

  private async requireProxyUrl(context: AuthContext): Promise<string> {
    // Prefer the in-memory value (set by initialize()) when available.
    if (this.proxyUrl !== null) {
      return this.proxyUrl;
    }
    // Fall back to cache on warm restart where this.proxyUrl may have been cleared.
    const cached = await context.cache.get<string>(PROXY_URL_CACHE_KEY);
    if (cached === null) {
      throw new PluginAuthError(
        "LDAP proxy URL not available — ensure initialize() completed before the first login",
      );
    }
    this.proxyUrl = cached;
    return cached;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Module entrypoint
//
// The manifest declares `"entrypoint": "authProvider"` so the Execution Service
// looks for a named export called `authProvider` on the bundle's module namespace.
// ────────────────────────────────────────────────────────────────────────────

export const authProvider: AuthProvider & {
  initialize(config: Record<string, unknown>, context: PluginContext): Promise<void>;
  mapGroupsToRoles(groups: string[], groupMapping: Record<string, string>): string[];
  buildUserSearchFilter(filterTemplate: string, username: string): string;
  buildGroupSearchFilter(filterTemplate: string, userDN: string): string;
} = new LdapAuthProvider();
