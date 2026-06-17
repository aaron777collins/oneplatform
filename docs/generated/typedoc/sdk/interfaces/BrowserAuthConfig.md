[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / BrowserAuthConfig

# Interface: BrowserAuthConfig

Defined in: [packages/sdk/src/types/client-options.ts:57](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L57)

Browser PKCE auth wrapper. The `browser` key discriminates this type from the
server-side auth configs and carries the PKCE configuration.

Usage: auth: { browser: { clientId: 'app:my-app:tenant-id' } }

## Properties

### browser

> `readonly` **browser**: `BrowserPkceConfig`

Defined in: [packages/sdk/src/types/client-options.ts:58](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L58)
