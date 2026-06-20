# Custom Auth Provider Plugin (SAML 2.0)

This example demonstrates how to build a custom authentication provider plugin for OnePlatform using the `@oneplatform/plugin-sdk`. The plugin implements SAML 2.0 Web Browser SSO Profile, allowing users to authenticate against any SAML 2.0-compliant Identity Provider (Okta, Azure AD, PingFederate, etc.).

## Overview

OnePlatform's authentication system is extensible through the `AuthProvider` plugin interface. This example implements a complete SAML 2.0 Service Provider (SP) that:

- Generates SAML AuthnRequest URLs for browser redirection to the Identity Provider
- Parses and validates SAML Responses from the IdP callback
- Verifies assertion conditions (time window, audience restriction, issuer)
- Extracts user attributes (email, name, groups) from the SAML assertion
- Maps IdP group memberships to OnePlatform RBAC roles
- Supports token validation and refresh via session management

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
```

## Prerequisites

- **Node.js 18+** with npm or pnpm
- **OnePlatform CLI** (`npm install -g @oneplatform/cli`)
- A **SAML 2.0 Identity Provider** (Okta, Azure AD, PingFederate, Shibboleth, etc.)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Tests

```bash
npm test
```

The tests use `createMockAuthContext` from `@oneplatform/plugin-sdk/testing` to run entirely in-process without needing a running platform instance.

### 3. Build

```bash
npm run build
```

### 4. Validate the Manifest

```bash
op plugin validate
```

### 5. Package for Installation

```bash
op plugin pack
```

This creates a `.oppkg` file that can be installed into a running OnePlatform instance.

### 6. Install the Plugin

```bash
op plugin install ./dist/com.example.saml-auth-provider-1.0.0.oppkg
```

### 7. Configure for a Tenant

After installing the plugin, enable it for a tenant through the platform UI or CLI:

```bash
op plugin enable com.example.saml-auth-provider \
  --tenant acme-corp \
  --config '{
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

The plugin implements the `AuthProvider` interface from `@oneplatform/plugin-sdk`:

```typescript
interface AuthProvider {
  metadata(): AuthProviderMetadata;
  initialize?(config: Record<string, unknown>, context: PluginContext): Promise<void>;
  getAuthorizationUrl(state: string, options: AuthOptions): string;
  handleCallback(params: CallbackParams, context: AuthContext): Promise<AuthResult>;
  validateToken?(token: string, context: AuthContext): Promise<TokenValidation>;
  refreshToken?(refreshToken: string, context: AuthContext): Promise<TokenPair>;
  mapClaimsToRoles(claims: Record<string, unknown>): string[];
}
```

### Flow

1. **Login initiation**: The Auth Service calls `getAuthorizationUrl()` with a CSRF state token. The plugin builds a SAML AuthnRequest URL that redirects the browser to the IdP.
2. **IdP authentication**: The user authenticates at the IdP (password, MFA, etc.).
3. **Callback handling**: The IdP POSTs a SAML Response to the platform's Assertion Consumer Service URL. The Auth Service base64-decodes the response and passes it to `handleCallback()`.
4. **Assertion validation**: The plugin parses the SAML XML, validates the signature, checks time conditions and audience restriction, and extracts user attributes.
5. **Role mapping**: `mapClaimsToRoles()` converts IdP group attributes to OnePlatform RBAC role names using the configured mapping.

### Key Design Decisions

- **No XML signature verification in the plugin.** The Auth Service verifies the IdP's XML signature using the certificate from the plugin configuration before calling `handleCallback()`. The plugin only validates assertion-level conditions (time, audience, issuer).
- **Stateless authorization URLs.** The plugin encodes the relay state and request ID in the SAML AuthnRequest rather than caching them. This avoids distributed state management across plugin instances.
- **Clock skew tolerance.** Enterprise IdP deployments often have clock drift. The plugin accepts a configurable tolerance (default 120 seconds) for assertion time validation.

## Configuration Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `idpEntityId` | string | Yes | The Identity Provider's entity ID (matches the Issuer in SAML responses) |
| `idpSsoUrl` | string | Yes | The IdP's Single Sign-On URL |
| `idpCertificate` | string | Yes | The IdP's X.509 signing certificate in PEM format |
| `spEntityId` | string | Yes | This Service Provider's entity ID |
| `emailAttributeName` | string | Yes | SAML attribute name containing the user's email address |
| `groupAttributeName` | string | Yes | SAML attribute name containing group memberships |
| `roleMapping` | object | Yes | Map of IdP group names to OnePlatform role names |
| `clockSkewToleranceSeconds` | number | No | Acceptable clock drift in seconds (default: 120) |

## Testing

The test suite uses `createMockAuthContext` to simulate the platform's plugin runtime:

```bash
# Run all tests
npm test

# Run tests in watch mode during development
npm run test:watch
```

Tests cover:
- Metadata validation
- Authorization URL generation with proper SAML AuthnRequest encoding
- Successful callback handling with valid SAML assertions
- Rejection of expired assertions
- Rejection of incorrect audience restrictions
- Role mapping from IdP groups to platform roles
- Error handling for malformed SAML responses

## Development

### Plugin Dev Server

Run the plugin in development mode with hot reload:

```bash
npx op plugin dev
```

This starts a local dev server that simulates the platform's plugin runtime and provides a test UI for triggering auth flows.

### Debugging

Enable debug logging by setting `LOG_LEVEL=debug` in the plugin instance configuration. Debug logs appear in the plugin execution log view (Admin > Plugins > SAML Auth Provider > Logs).

## Security Considerations

- **Never log SAML assertions.** They contain PII (names, emails, group memberships). The plugin uses `context.logger` which automatically redacts assertion content at the platform level.
- **Validate the IdP certificate.** Ensure the `idpCertificate` in the configuration matches the IdP's actual signing certificate. Certificate rotation requires updating the plugin configuration.
- **Use HTTPS everywhere.** The Assertion Consumer Service URL and IdP SSO URL must use HTTPS. The manifest declares `requiredExternalUrls` to restrict outbound traffic.
- **Clock skew tolerance.** Set this as low as your infrastructure allows. The default of 120 seconds is conservative for enterprise deployments with NTP.
