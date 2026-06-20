# Enterprise Authentication Setup

This example provides production-ready configuration files and setup scripts for
enterprise authentication in OnePlatform. It covers single sign-on (SSO) with
OIDC and LDAP providers, role-based access control (RBAC), multi-tenant
management, API key administration, and audit logging.

Use this as a reference or starting point when deploying OnePlatform in an
enterprise environment with existing identity infrastructure.

## Directory structure

```
enterprise-auth/
  configs/
    oidc-provider.json    OIDC provider config (Keycloak example)
    ldap-provider.json    LDAP/Active Directory provider config
    rbac-roles.json       Role definitions with scopes and permissions
    tenant-config.json    Multi-tenant setup with branding and security
    api-keys.json         Service-to-service API key configurations
    audit-policy.json     Audit logging, export, and alerting policy
  scripts/
    setup-oidc.sh         CLI script to register the OIDC provider
    setup-ldap.sh         CLI script to register the LDAP provider
    create-tenant.sh      CLI script to create and configure a tenant
  README.md               This file
```

## Prerequisites

Before you begin, ensure you have:

- A running OnePlatform instance (local via Docker Compose or hosted)
- The `op` CLI installed: `npm install -g @oneplatform/cli`
- A platform admin account (created during initial bootstrap)
- `curl`, `jq`, and `openssl` on your PATH
- For LDAP testing: `ldapsearch` (`ldap-utils` on Debian/Ubuntu, `openldap-clients` on RHEL)

Set these environment variables to avoid passing them to every command:

```bash
export OP_PLATFORM_URL="https://your-instance.example.com"
export OP_API_KEY="op_live_..."
```

## Quick start

The fastest way to set up a fully configured tenant with enterprise SSO:

```bash
# 1. Create a tenant with an admin user, import roles, and configure OIDC + LDAP
./scripts/create-tenant.sh \
  --tenant-name "Acme Corporation" \
  --tenant-slug "acme-corp" \
  --admin-email "admin@acme-corp.com" \
  --setup-oidc \
  --setup-ldap

# 2. Verify the setup
op auth login --tenant <tenant-id> --email admin@acme-corp.com
op auth whoami
op auth roles list
```

If you prefer to configure each piece individually, follow the step-by-step
sections below.

---

## 1. OIDC setup (Keycloak)

OpenID Connect (OIDC) is the recommended authentication method for web-based SSO.
This example uses Keycloak, but the configuration works with any OIDC-compliant
provider including Okta, Azure AD, Auth0, and Google Workspace.

### How it works

OnePlatform's OIDC auth provider plugin follows the standard authorization code
flow:

1. The user clicks "Sign in with SSO" and is redirected to the Keycloak login page.
2. After authentication, Keycloak redirects back to OnePlatform with an
   authorization code.
3. OnePlatform exchanges the code for access and ID tokens at Keycloak's token
   endpoint.
4. The ID token's claims are mapped to OnePlatform RBAC roles using the
   configured `roleClaimPath` and `roleMapping`.
5. OnePlatform creates a session and issues its own access/refresh token pair.

### Keycloak prerequisites

Before registering the OIDC provider with OnePlatform, configure Keycloak:

1. **Create a realm** named `oneplatform` (or your preferred name).
2. **Create a client** with these settings:
   - Client ID: `oneplatform-app`
   - Client Protocol: `openid-connect`
   - Access Type: `confidential`
   - Standard Flow Enabled: `ON`
   - Direct Access Grants: `OFF`
   - Valid Redirect URIs: `https://your-instance.example.com/auth/callback`
3. **Create realm roles** that match your desired mapping (e.g., `platform_admin`,
   `org_admin`, `data_engineer`, `analyst`, `read_only`).
4. **Add a protocol mapper** to include roles in the token:
   - Mapper type: `User Realm Role`
   - Token Claim Name: `resource_access.oneplatform-app.roles`
   - Claim JSON Type: `String`
   - Multivalued: `ON`
   - Add to ID token: `ON`
   - Add to access token: `ON`

### Configuration file

The configuration is in [`configs/oidc-provider.json`](configs/oidc-provider.json).
Key fields:

| Field | Description |
|-------|-------------|
| `config.issuerUrl` | The Keycloak realm URL. Must use HTTPS in production. |
| `config.clientId` | The client ID registered in Keycloak. |
| `config.scopes` | OAuth scopes to request. Always includes `openid`. |
| `config.roleClaimPath` | Dot-path to the roles array in the ID token. Keycloak uses `resource_access.<clientId>.roles`. |
| `config.roleMapping` | Maps Keycloak role names to OnePlatform role names. |
| `config.jwksCacheTtlSeconds` | How long to cache Keycloak's signing keys (default: 3600s). |

The `credentials.clientSecret` field specifies where the Keycloak client secret
is stored. In this example it reads from the `KEYCLOAK_CLIENT_SECRET` environment
variable. In production, use a secrets manager.

### Register the provider

```bash
# Set the client secret
export KEYCLOAK_CLIENT_SECRET="your-keycloak-client-secret"

# Validate the configuration without making changes
./scripts/setup-oidc.sh --dry-run --tenant-id <tenant-id>

# Register the provider
./scripts/setup-oidc.sh --tenant-id <tenant-id>
```

The script will:
1. Parse and validate the configuration file.
2. Fetch the OIDC discovery document to verify connectivity.
3. Validate that the issuer URL matches the discovery document.
4. Register the provider with the OnePlatform Auth Service.
5. Verify the registration.

### Adapting for other OIDC providers

To use a different OIDC provider, update these fields in `oidc-provider.json`:

**Okta:**
```json
{
  "config": {
    "issuerUrl": "https://your-org.okta.com/oauth2/default",
    "roleClaimPath": "groups",
    "scopes": ["openid", "profile", "email", "groups"]
  }
}
```

**Azure AD:**
```json
{
  "config": {
    "issuerUrl": "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "roleClaimPath": "roles",
    "scopes": ["openid", "profile", "email"]
  }
}
```

**Auth0:**
```json
{
  "config": {
    "issuerUrl": "https://your-domain.auth0.com/",
    "roleClaimPath": "https://your-domain.auth0.com/roles",
    "scopes": ["openid", "profile", "email"]
  }
}
```

---

## 2. LDAP setup (Active Directory)

LDAP authentication is used for organizations that rely on Active Directory or
other LDAP-based directory services for identity management. Unlike OIDC, LDAP
uses direct credential verification (bind) rather than browser redirects.

### How it works

OnePlatform's LDAP auth provider plugin communicates with the directory through
a platform-hosted LDAP proxy (the plugin runs in an isolated sandbox and cannot
open TCP connections directly):

1. The user enters their username and password on the OnePlatform login page.
2. The plugin searches for the user's Distinguished Name (DN) using the service
   account.
3. The plugin binds as the user with the entered password to verify credentials.
4. On success, it searches for user attributes (email, name, department).
5. Group memberships are resolved via the `memberOf` attribute or an explicit
   group search.
6. LDAP groups are mapped to OnePlatform RBAC roles using `groupMapping`.

### Active Directory prerequisites

1. **Create a service account** in AD for OnePlatform:
   - Example: `CN=OnePlatform Service,OU=Service Accounts,DC=corp,DC=example,DC=com`
   - Grant read access to the Users and Groups OUs.
   - Set the password to never expire (or manage rotation externally).

2. **Create AD security groups** for OnePlatform roles:
   - `OnePlatform Admins` (maps to `platform-admin`)
   - `OnePlatform Tenant Admins` (maps to `tenant-admin`)
   - `Data Engineering` (maps to `data-engineer`)
   - `Business Analytics` (maps to `business-analyst`)
   - `OnePlatform Users` (maps to `viewer`)

3. **Assign users to groups** based on their required access level.

4. **Enable LDAPS** (LDAP over TLS on port 636) on your domain controllers.
   Plain LDAP (port 389) should not be used in production.

### Configuration file

The configuration is in [`configs/ldap-provider.json`](configs/ldap-provider.json).
Key fields:

| Field | Description |
|-------|-------------|
| `config.url` | LDAP server URL. Use `ldaps://` for TLS. |
| `config.baseDN` | The root DN for all searches. |
| `config.bindDN` | DN of the service account for searching. |
| `config.userSearchBase` | OU where user accounts are located (relative to baseDN). |
| `config.userSearchFilter` | LDAP filter to find a user by username. `{{username}}` is replaced at runtime. |
| `config.groupSearchBase` | OU where groups are located. Set to `null` to use memberOf attribute. |
| `config.groupMapping` | Maps AD group names to OnePlatform role names. |
| `config.useTLS` | Enable STARTTLS for plain LDAP connections (always true for ldaps://). |
| `config.tlsOptions.rejectUnauthorized` | Verify the server's TLS certificate. Always `true` in production. |
| `config.connectionTimeoutMs` | LDAP connection timeout (default: 5000ms). |

### Register the provider

```bash
# Set the bind password
export LDAP_BIND_PASSWORD="your-service-account-password"

# Validate and test LDAP connectivity (requires ldapsearch)
./scripts/setup-ldap.sh --dry-run --tenant-id <tenant-id>

# Register the provider
./scripts/setup-ldap.sh --tenant-id <tenant-id>
```

### User search filter reference

The `userSearchFilter` uses LDAP filter syntax with the `{{username}}` template
variable. The plugin escapes the username value to prevent LDAP injection.

**Active Directory (sAMAccountName):**
```
(&(objectClass=user)(sAMAccountName={{username}})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))
```
The `userAccountControl` filter excludes disabled accounts (bit 2 = `ACCOUNTDISABLE`).

**OpenLDAP (uid):**
```
(&(objectClass=inetOrgPerson)(uid={{username}}))
```

**Email-based login:**
```
(&(objectClass=user)(mail={{username}}))
```

---

## 3. RBAC roles

OnePlatform uses role-based access control (RBAC) with scoped permissions. Roles
are assigned to users either manually or automatically through identity provider
mapping (OIDC `roleMapping` or LDAP `groupMapping`).

### Predefined roles

These roles exist by default and cannot be deleted:

| Role | Scopes | Description |
|------|--------|-------------|
| `platform-admin` | `admin` (all) | Full access across all tenants. Platform-level operations. |
| `tenant-admin` | All except `admin` | Full access within a single tenant. User and role management. |

### Custom roles

These roles are defined in [`configs/rbac-roles.json`](configs/rbac-roles.json)
and are created per-tenant:

| Role | Key scopes | Description |
|------|-----------|-------------|
| `data-engineer` | `data:*`, `ontology:*`, `pipelines:*`, `plugins:*`, `execution:*` | Build and manage data pipelines and entity types. |
| `business-analyst` | `data:read`, `ontology:read`, `apps:*`, `execution:*` | Build dashboards and apps with read-only data access. |
| `viewer` | `*:read` | View data, apps, and logs. Cannot modify anything. |

### Available scopes

Each scope grants access to a specific domain of the platform:

| Scope | Description |
|-------|-------------|
| `data:read` | Read entity data (records, objects, time series) |
| `data:write` | Create, update, and delete entity data |
| `ontology:read` | View entity type definitions and relationships |
| `ontology:write` | Create and modify entity type definitions |
| `pipelines:read` | View pipeline definitions and run history |
| `pipelines:trigger` | Manually trigger pipeline runs |
| `pipelines:manage` | Create, edit, and delete pipelines |
| `apps:read` | View published applications and dashboards |
| `apps:deploy` | Deploy and publish applications |
| `apps:manage` | Create, edit, and delete applications |
| `plugins:read` | View installed plugins |
| `plugins:manage` | Install, configure, and remove plugins |
| `users:read` | View user accounts and role assignments |
| `users:manage` | Create, update, and deactivate users |
| `logs:read` | View application and pipeline logs |
| `logs:export` | Export log data |
| `audit:read` | View audit trail entries |
| `webhooks:manage` | Create and manage webhook subscriptions |
| `execution:read` | View sandbox execution results |
| `execution:run` | Execute code in the sandbox runtime |
| `admin` | Unrestricted access (platform-admin only) |

### Entity-level permissions

Beyond scopes, roles can define fine-grained permissions on specific entity types:

- **Actions:** `read`, `write`, `delete`, `admin` per entity type.
- **Field restrictions:** Deny read or write access to specific fields (e.g.,
  hide `_salary_band` from viewers).
- **Row filters:** Restrict which rows a role can see based on field values
  (e.g., `department = "Engineering"`).

See the `entityPermissions` section in `rbac-roles.json` for examples.

### Importing roles

```bash
# Roles are imported automatically by create-tenant.sh, or manually:
op auth roles import --config configs/rbac-roles.json --tenant <tenant-id>

# Verify roles
op auth roles list --tenant <tenant-id>
```

---

## 4. Tenant management

OnePlatform supports multi-tenancy. Each tenant is an isolated environment with
its own users, roles, data, and configuration. Tenants are managed by
platform admins.

### Creating a tenant

```bash
./scripts/create-tenant.sh \
  --tenant-name "Acme Corporation" \
  --tenant-slug "acme-corp" \
  --admin-email "admin@acme-corp.com"
```

Or via the API:

```bash
curl -X POST "$OP_PLATFORM_URL/api/v1/tenants" \
  -H "Authorization: Bearer $OP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corporation",
    "slug": "acme-corp",
    "settings": {
      "selfRegistration": false,
      "requireEmailVerification": true,
      "defaultRoles": ["viewer"]
    }
  }'
```

### Tenant configuration

The tenant configuration in [`configs/tenant-config.json`](configs/tenant-config.json)
includes:

**Authentication settings:**
- `authProviders` -- Which SSO providers are available for this tenant.
- `defaultAuthProvider` -- The provider used when the user clicks "Sign in with SSO."
- `selfRegistration` -- Whether users can register themselves (disabled for enterprise).
- `allowedEmailDomains` -- Restrict registration to specific email domains.

**Session settings:**
- `accessTokenTtlSeconds` -- Access token lifetime (default: 900 seconds / 15 minutes).
- `refreshTokenTtlSeconds` -- Refresh token lifetime (default: 604800 seconds / 7 days).
- `maxConcurrentSessions` -- Limit simultaneous sessions per user.
- `idleTimeoutSeconds` -- Revoke sessions after inactivity.

**Security settings:**
- `passwordPolicy` -- Minimum length, complexity, reuse prevention, and max age.
- `ipAllowlist` -- Restrict access to specific IP ranges (CIDR notation).
- `mfaRequired` -- Enforce multi-factor authentication for all users.
- `mfaMethods` -- Allowed MFA methods (`totp`, `webauthn`).

**Branding:**
- `appName` -- Custom application name shown in the UI.
- `logoUrl` / `faviconUrl` -- Custom logo and favicon.
- `primaryColor` / `accentColor` -- Theme colors (hex values).
- `supportEmail` -- Contact email shown in error pages and help dialogs.

### Tenant slug rules

The tenant slug is used in URLs and subdomain routing. It is **immutable** after
creation because external systems (DNS records, OAuth redirect URIs) depend on it.

- Lowercase alphanumeric characters and hyphens only.
- Must start and end with a letter or number.
- Examples: `acme-corp`, `globex`, `engineering-team`

---

## 5. API keys

API keys provide service-to-service authentication for programmatic access.
They are used by CI/CD pipelines, ETL jobs, monitoring dashboards, and partner
integrations.

### Key format

OnePlatform API keys use this format:

```
op_live_<43 random base64url characters>
```

The first 8 characters of the random portion are stored as a lookup prefix for
fast database queries. The full key is bcrypt-hashed and never stored in plain
text.

### Creating API keys

```bash
# Via the CLI
op auth api-keys create \
  --name "ETL Pipeline Service" \
  --scopes "data:read,data:write,pipelines:trigger" \
  --expires "2027-01-01T00:00:00Z"
```

Or via the API:

```bash
curl -X POST "$OP_PLATFORM_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $OP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ETL Pipeline Service",
    "scopes": ["data:read", "data:write", "pipelines:trigger"],
    "expiresAt": "2027-01-01T00:00:00Z"
  }'
```

The API key is returned **once** in the response. Store it securely immediately.

### Scope subsetting

A user cannot create an API key with scopes they do not possess. If you have
`data:read` and `data:write` scopes, you can only create keys with those scopes
or a subset. This prevents privilege escalation through key creation.

### Key rotation

Rotate a key atomically (the old key is revoked and a new key is created in a
single transaction, so there is no window where neither key works):

```bash
op auth api-keys rotate <key-id>
```

### Key lifecycle management

See [`configs/api-keys.json`](configs/api-keys.json) for example configurations
including rotation policies and notification settings. Key management best
practices:

1. Use the minimum required scopes for each key (principle of least privilege).
2. Set an expiration date on every key.
3. Rotate keys regularly (every 30--90 days depending on sensitivity).
4. Revoke keys immediately when a service is decommissioned.
5. Monitor `lastUsedAt` to detect unused keys for cleanup.
6. Never embed keys in source code or commit them to version control.
7. Store keys in a secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.).

---

## 6. Audit logging

OnePlatform records all security-relevant events in an immutable audit log. The
audit policy in [`configs/audit-policy.json`](configs/audit-policy.json)
configures what is captured, how long it is retained, and where it is exported.

### Captured events

The audit system tracks events across these categories:

| Category | Example events |
|----------|---------------|
| Authentication | Login success/failure, logout, token refresh, MFA enrollment |
| API Keys | Key created, revoked, rotated, expired, used |
| User Management | User created, updated, deactivated, roles changed |
| Role Management | Role created, updated, deleted, permissions changed |
| Tenant Management | Tenant created, updated, deleted, settings changed |
| Data Access | Entity read, created, updated, deleted, exports |
| System Admin | Plugin installed/removed, pipeline created/deleted |

### Retention

The default retention period is 365 days. Audit records are immutable once
written and cannot be modified or deleted before the retention period expires.
Enable `compressionEnabled` and `encryptionAtRest` for storage efficiency and
security.

### Export

Audit logs can be exported to external systems in real time:

**SIEM (Syslog/CEF):**
```json
{
  "type": "syslog",
  "endpoint": "syslog+tls://siem.corp.example.com:6514",
  "format": "CEF"
}
```

**Object Storage (S3):**
```json
{
  "type": "s3",
  "bucket": "audit-logs",
  "partitionBy": "day",
  "format": "json-lines",
  "compression": "gzip"
}
```

### Alerts

Configure real-time alerts for security-critical events:

- **Repeated login failures:** 5+ failures in 10 minutes from the same IP.
- **Privileged role assignment:** platform-admin or tenant-admin assigned.
- **Admin API key created:** API key with the `admin` scope.
- **Tenant deletion:** Any tenant deleted from the platform.
- **Bulk data export:** Export exceeding 10,000 records.

Alerts are delivered via webhook (Slack, PagerDuty, etc.). See the `alerts`
section in `audit-policy.json` for the full configuration.

### Applying the audit policy

```bash
op audit policy apply --config configs/audit-policy.json
op audit policy show
```

---

## Troubleshooting

### OIDC: "issuer mismatch" error

The issuer URL in `oidc-provider.json` must exactly match the `issuer` field in
the provider's discovery document. Common issues:

- Trailing slash mismatch: `https://keycloak.example.com/realms/oneplatform` vs.
  `https://keycloak.example.com/realms/oneplatform/`
- HTTP vs. HTTPS: OnePlatform requires HTTPS for the issuer URL.
- Wrong realm name: verify the realm exists in Keycloak.

Run the setup script with `--dry-run` to validate without making changes.

### OIDC: Users have no roles after login

Check these in order:

1. Verify `roleClaimPath` points to the correct claim in the ID token. Decode a
   Keycloak token at [jwt.io](https://jwt.io) to find the roles array.
2. Verify the protocol mapper in Keycloak is configured to include roles in the
   ID token (not just the access token).
3. Verify `roleMapping` maps the exact Keycloak role names (case-sensitive) to
   valid OnePlatform role names.
4. Check `op auth whoami` to see what roles were assigned.

### LDAP: "LDAP bind failed" error

1. Verify the LDAP URL and port are reachable from the OnePlatform host.
2. Check the bind DN is correct (use the full DN, not just the username).
3. Verify the bind password is correct.
4. For LDAPS, ensure the server's TLS certificate is trusted by the host.

Test connectivity directly:

```bash
ldapsearch -H ldaps://dc01.corp.example.com:636 \
  -D "CN=OnePlatform Service,OU=Service Accounts,DC=corp,DC=example,DC=com" \
  -W -b "DC=corp,DC=example,DC=com" "(objectClass=*)" dn -s base
```

### LDAP: Users authenticate but have no roles

1. Verify the AD groups exist and the user is a member.
2. Check `groupMapping` maps the exact AD group names (case-sensitive).
3. If using `memberOf`, verify the user's LDAP entry has the `memberOf` attribute
   populated. Run: `ldapsearch ... "(sAMAccountName=jsmith)" memberOf`
4. If using explicit group search, verify `groupSearchBase` and
   `groupSearchFilter` are correct.

### API keys: "Cannot create API key with scope" error

This error means you are trying to create a key with scopes you do not have.
Your API key can only have a subset of your own scopes. Log in with a more
privileged account or request additional scopes from your admin.

---

## Related documentation

- [Architecture Decisions](../../docs/decisions/001-architecture-decisions.md) -- Platform design rationale
- [Auth Service Design](../../docs/designs/) -- Detailed auth service specifications
- [Plugin SDK Types](../../packages/plugin-sdk/src/types/auth-provider.ts) -- AuthProvider interface
- [OIDC Plugin Source](../../plugins/auth-provider-oidc/src/index.ts) -- OIDC implementation
- [LDAP Plugin Source](../../plugins/auth-provider-ldap/src/index.ts) -- LDAP implementation
- [Auth Schemas](../../services/auth/src/schemas/index.ts) -- API request/response schemas
