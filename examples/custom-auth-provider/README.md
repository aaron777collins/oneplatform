# Custom Auth Provider Plugin (SAML 2.0)

This example demonstrates how to build a custom authentication provider plugin for OnePlatform using the `@oneplatform/plugin-sdk`. The plugin implements SAML 2.0 Web Browser SSO Profile, allowing users to authenticate against any SAML 2.0-compliant Identity Provider (Okta, Azure AD, PingFederate, Shibboleth, ADFS, OneLogin, etc.).

## What You Will Learn

- How to implement the `AuthProvider` interface from `@oneplatform/plugin-sdk`
- How SAML 2.0 authentication flows work within OnePlatform
- How to parse and validate SAML assertions
- How to map IdP group attributes to OnePlatform RBAC roles
- How to test auth provider plugins using `createMockAuthContext`
- How to package and publish plugins to the OnePlatform marketplace

## Prerequisites

- **Node.js 18+** with npm or pnpm
- **OnePlatform CLI** (`npm install -g @oneplatform/cli`)
- Basic understanding of **SAML 2.0** (helpful but not required -- this guide explains everything you need)
- A **SAML 2.0 Identity Provider** for testing (Okta developer account, Azure AD tenant, or any SAML IdP)

## Project Structure

```
custom-auth-provider/
  src/
    index.ts                        # SAML auth provider plugin (AuthProvider interface)
    saml-parser.ts                  # SAML XML parsing and validation utilities
    types.ts                        # TypeScript types for SAML 2.0 entities
    __tests__/
      saml-auth-provider.test.ts    # Unit tests using createMockAuthContext
  manifest.json                     # Plugin manifest (validated by the Plugin Service)
  package.json                      # Dependencies and build scripts
  tsconfig.json                     # TypeScript configuration
  README.md                         # This file
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Tests

```bash
npm test
```

The tests use `createMockAuthContext` from `@oneplatform/plugin-sdk/testing` to run entirely in-process without needing a running platform instance or a real IdP.

### 3. Build

```bash
npm run build
```

### 4. Validate the Manifest

```bash
# Pack the plugin first, then validate the resulting .oppkg
op plugin pack
op plugin validate ./dist/com.example.saml-auth-provider-1.0.0.oppkg
```

This checks that `plugin.manifest.json` conforms to the platform's manifest schema and that the entrypoint matches the bundle's exports.

### 5. Package for Installation

```bash
op plugin pack
```

This creates a `.oppkg` file in `dist/` that can be installed into a running OnePlatform instance.

### 6. Install the Plugin

```bash
op plugin install ./dist/com.example.saml-auth-provider-1.0.0.oppkg
```

### 7. Enable for a Tenant

After installing the plugin, enable it for a specific tenant via the CLI:

```bash
op plugin enable com.example.saml-auth-provider --tenant acme-corp
```

Then configure the plugin's instance settings (IdP entity ID, SSO URL, certificate, etc.)
through the platform UI under **Settings > Plugins > SAML Auth Provider > Configure**, or
via the REST API:

```bash
curl -X PUT "$OP_PLATFORM_URL/api/v1/plugins/com.example.saml-auth-provider/config" \
  -H "Authorization: Bearer $OP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "idpEntityId": "https://idp.example.com/saml/metadata",
    "idpSsoUrl": "https://idp.example.com/saml/sso",
    "idpCertificate": "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
    "spEntityId": "https://app.example.com/saml/metadata",
    "emailAttributeName": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "groupAttributeName": "http://schemas.xmlsoap.org/claims/Group",
    "roleMapping": {
      "Platform Admins": "platform-admin",
      "Data Engineers": "data-engineer",
      "Analysts": "business-analyst",
      "Everyone": "viewer"
    },
    "clockSkewToleranceSeconds": 120
  }'
```

## Plugin Architecture

### AuthProvider Interface

The plugin implements the `AuthProvider` interface from `@oneplatform/plugin-sdk`. Here is the full interface with all methods:

```typescript
interface AuthProvider {
  // Required: return plugin metadata (type, protocol, capabilities, config schema)
  metadata(): AuthProviderMetadata;

  // Optional: one-time setup (parse config, verify credentials, cache discovery data)
  initialize?(config: Record<string, unknown>, context: PluginContext): Promise<void>;

  // Required: build the URL that redirects the browser to the IdP login page
  getAuthorizationUrl(state: string, options: AuthOptions): string;

  // Required: process the IdP callback and return the user's identity
  handleCallback(params: CallbackParams, context: AuthContext): Promise<AuthResult>;

  // Optional: validate a previously issued token (check session, verify signature)
  validateToken?(token: string, context: AuthContext): Promise<TokenValidation>;

  // Optional: exchange a refresh token for a new access token
  refreshToken?(refreshToken: string, context: AuthContext): Promise<TokenPair>;

  // Required: map external IdP claims to OnePlatform RBAC role names
  mapClaimsToRoles(claims: Record<string, unknown>): string[];
}
```

### SAML SSO Flow

Here is how a user login works end-to-end:

```
1. User clicks "Sign in with SAML" in the OnePlatform UI
       |
2. Auth Service calls getAuthorizationUrl(state, options)
   --> Plugin builds a SAML AuthnRequest XML and returns the IdP SSO URL
       |
3. Browser redirects to the IdP login page
   --> User authenticates (password, MFA, etc.)
       |
4. IdP POSTs a SAML Response to the platform's Assertion Consumer Service URL
       |
5. Auth Service base64-decodes the SAML Response,
   verifies the XML signature using the IdP certificate,
   then calls handleCallback(params, context)
       |
6. Plugin parses the SAML assertion, validates conditions (time, audience, issuer),
   extracts user attributes, and maps groups to platform roles
       |
7. Auth Service issues a platform session token and redirects to the app
```

### Key Design Decisions

- **No XML signature verification in the plugin.** The Auth Service verifies the IdP's XML signature using the certificate from the plugin configuration *before* calling `handleCallback()`. The plugin only validates assertion-level conditions (time, audience, issuer).
- **Stateless authorization URLs.** The plugin encodes the relay state and request ID in the SAML AuthnRequest rather than caching them. This avoids distributed state management across plugin instances.
- **Clock skew tolerance.** Enterprise IdP deployments often have clock drift. The plugin accepts a configurable tolerance (default 120 seconds) for assertion time validation.
- **Session-based token validation.** SAML assertions are one-time-use, so the plugin caches session data in `context.cache` and validates tokens against the cache rather than re-contacting the IdP.

## Configuration Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `idpEntityId` | string | Yes | -- | The Identity Provider's entity ID. Found in the IdP's SAML metadata XML. |
| `idpSsoUrl` | string (HTTPS URL) | Yes | -- | The IdP's Single Sign-On URL for the HTTP-POST binding. |
| `idpCertificate` | string | Yes | -- | The IdP's X.509 signing certificate in PEM format. |
| `spEntityId` | string | Yes | -- | This Service Provider's entity ID (your app's unique identifier). |
| `emailAttributeName` | string | Yes | -- | SAML attribute name containing the user's email address. |
| `groupAttributeName` | string | Yes | -- | SAML attribute name containing group memberships for role mapping. |
| `roleMapping` | object | Yes | -- | Map of IdP group names to OnePlatform role names. |
| `clockSkewToleranceSeconds` | number | No | `120` | Acceptable clock drift in seconds between the IdP and OnePlatform. |

### Finding Your IdP Configuration Values

Most SAML Identity Providers publish a metadata XML document that contains all the values you need. Here is where to find them for common IdPs:

**Okta:**
- Go to Applications > Your App > Sign On tab > SAML Signing Certificates
- Download the IdP metadata XML from: `https://your-org.okta.com/app/{app-id}/sso/saml/metadata`
- `idpEntityId` = the `entityID` attribute on `<EntityDescriptor>`
- `idpSsoUrl` = the `Location` attribute on `<SingleSignOnService>`

**Azure AD:**
- Go to Azure Portal > Enterprise Applications > Your App > Single Sign-On
- Download the Federation Metadata XML
- `idpEntityId` = `https://sts.windows.net/{tenant-id}/`
- `idpSsoUrl` = `https://login.microsoftonline.com/{tenant-id}/saml2`

**PingFederate / Shibboleth:**
- Access the IdP metadata at `https://your-idp.example.com/idp/shibboleth`
- The entity ID and SSO URL are in the `<EntityDescriptor>` and `<SingleSignOnService>` elements.

## Testing

The test suite uses `createMockAuthContext` from `@oneplatform/plugin-sdk/testing` to simulate the platform's plugin runtime without needing a real platform instance or IdP.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Type-check without emitting
npm run typecheck
```

### Test Coverage

The tests cover the full `AuthProvider` interface:

- **metadata()** -- validates the plugin metadata structure, protocol declaration, and config schema
- **getAuthorizationUrl()** -- verifies SAML AuthnRequest generation, base64 encoding, RelayState (CSRF) pass-through, and additional parameter forwarding
- **handleCallback()** -- tests successful SAML response parsing, attribute extraction, role mapping, and error handling for invalid assertions (wrong issuer, expired, wrong audience)
- **validateToken()** -- verifies session cache lookup, expiry handling, and invalid token rejection
- **refreshToken()** -- tests session extension, old token invalidation, and error cases
- **mapClaimsToRoles()** -- verifies group-to-role mapping, unknown group handling, duplicate deduplication, and edge cases

### Writing Your Own Tests

The key testing utility is `createMockAuthContext()`:

```typescript
import { createMockAuthContext } from "@oneplatform/plugin-sdk/testing";

// Create a mock context with test credentials
const ctx = createMockAuthContext({
  config: myConfig,
  authCredentials: { privateKey: "test-key" },
});

// Initialize the provider
await provider.initialize(myConfig, ctx);

// Test the callback with a mock SAML response
const result = await provider.handleCallback({ code: encodedSamlResponse }, ctx);

// Assert on the result
expect(result.providerUserId).toBe("alice@example.com");

// Inspect internal calls (credential access, fetch calls, logs)
expect(ctx.credentialCalls).toHaveLength(1);
expect(ctx.logger.__logs).toContainEqual(
  expect.objectContaining({ level: "info", message: expect.stringContaining("successful") })
);
```

## Development

### Plugin Dev Server

Run the plugin in development mode with hot reload:

```bash
npx op plugin dev
```

This starts a local dev server that simulates the platform's plugin runtime and provides a test UI for triggering auth flows.

### Debugging

Enable debug logging by setting `LOG_LEVEL=debug` in the plugin instance configuration. Debug logs appear in the plugin execution log view (Admin > Plugins > SAML Auth Provider > Logs).

### Code Style

This example follows the same code style as the built-in OnePlatform plugins:

- TypeScript strict mode
- ES2022 target with ESM modules
- Imports use `.js` extensions (required for Node.js ESM resolution)
- All plugin methods use `context.logger` for logging (never `console.log`)

## Marketplace Publishing

Once your plugin is tested and ready for production:

### 1. Update the Manifest

Edit `manifest.json` with your organization's details:
- Change `id` to your reverse-domain namespace (e.g., `com.yourcompany.saml-provider`)
- Update `author`, `supportUrl`, and `homepageUrl`
- Set the correct `requiredExternalUrls` to match your IdP's domain

### 2. Build and Pack

```bash
npm run build
op plugin pack
```

### 3. Publish

Run from the plugin project root (the directory containing `plugin.manifest.json`):

```bash
# Pack the plugin (creates dist/<id>-<version>.oppkg) and publish to the marketplace
op plugin publish --category authentication --tags "saml,sso,enterprise"
```

The `publish` command reads `plugin.manifest.json` from the current directory,
packs the bundle automatically, and uploads it to the marketplace. You will be
prompted to select a category and confirm the publish if you do not pass `--category`.

### 4. Marketplace Listing

The marketplace uses these fields from your manifest and metadata for the listing page:
- `name` and `description` are shown on the card
- `tags` are used for search and filtering
- `configSchema` generates the admin configuration form
- `author` and `supportUrl` are shown in the plugin details

## Security Considerations

- **Never log SAML assertions.** They contain PII (names, emails, group memberships). Use `context.logger` which automatically redacts assertion content at the platform level.
- **Validate the IdP certificate.** Ensure the `idpCertificate` in the configuration matches the IdP's actual signing certificate. Certificate rotation requires updating the plugin configuration.
- **Use HTTPS everywhere.** The Assertion Consumer Service URL and IdP SSO URL must use HTTPS. The manifest declares `requiredExternalUrls` to restrict outbound traffic.
- **Clock skew tolerance.** Set this as low as your infrastructure allows. The default of 120 seconds is conservative for enterprise deployments with NTP.
- **Credential handling.** Never cache or log credential values. Use `context.credentials.get()` to access secrets on demand -- the platform manages rotation automatically.

## See Also

- [OIDC Auth Provider Plugin](../../plugins/auth-provider-oidc/) -- built-in reference implementation for OpenID Connect
- [Plugin SDK Documentation](../../packages/plugin-sdk/) -- full API reference
- [Custom Connector Example](../custom-connector/) -- example of building a different plugin type
- [Plugin SDK Testing Utilities](../../packages/plugin-sdk/src/testing/) -- mock context factories and assertions
