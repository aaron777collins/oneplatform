[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / FetchProxy

# Interface: FetchProxy

Defined in: [packages/plugin-sdk/src/types/context.ts:76](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L76)

## Methods

### fetch()

> **fetch**(`url`, `init?`): `Promise`\<`Response`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:89](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L89)

Proxied HTTP fetch. Only URLs declared in manifest.requiredExternalUrls are
permitted. All internal OnePlatform service URLs are blocked unconditionally,
even if declared.

URL matching is performed per-component on the parsed WHATWG URL:
- Protocol must match exactly (https:// required; http:// is blocked)
- Hostname must match exactly — no prefix/substring matching
- Path matching uses glob patterns on path segments only

#### Parameters

##### url

`string`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>

#### Throws

PluginAuthError if the URL is not in the approved allowlist.
