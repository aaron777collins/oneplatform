[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / ClientOptions

# Interface: ClientOptions

Defined in: [packages/sdk/src/types/client-options.ts:83](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L83)

## Properties

### auth?

> `readonly` `optional` **auth?**: [`AuthConfig`](../type-aliases/AuthConfig.md)

Defined in: [packages/sdk/src/types/client-options.ts:94](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L94)

Authentication configuration.
Omit to auto-detect (browser → PKCE, Node.js → throws ConfigurationError).

***

### baseUrl

> `readonly` **baseUrl**: `string`

Defined in: [packages/sdk/src/types/client-options.ts:88](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L88)

Base URL of the OnePlatform instance.
Must NOT have a trailing slash.

***

### fetch?

> `readonly` `optional` **fetch?**: \{(`input`, `init?`): `Promise`\<`Response`\>; (`input`, `init?`): `Promise`\<`Response`\>; \}

Defined in: [packages/sdk/src/types/client-options.ts:112](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L112)

Custom fetch implementation. Defaults to globalThis.fetch.
Inject a mock here for testing.

#### Call Signature

> (`input`, `init?`): `Promise`\<`Response`\>

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

##### Parameters

###### input

`URL` \| `RequestInfo`

###### init?

`RequestInit`

##### Returns

`Promise`\<`Response`\>

#### Call Signature

> (`input`, `init?`): `Promise`\<`Response`\>

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

##### Parameters

###### input

`string` \| `URL` \| `Request`

###### init?

`RequestInit`

##### Returns

`Promise`\<`Response`\>

***

### headers?

> `readonly` `optional` **headers?**: `Record`\<`string`, `string`\>

Defined in: [packages/sdk/src/types/client-options.ts:115](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L115)

Custom headers merged onto every request. Lower precedence than SDK-managed headers.

***

### logLevel?

> `readonly` `optional` **logLevel?**: `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"silent"`

Defined in: [packages/sdk/src/types/client-options.ts:118](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L118)

SDK diagnostic log level. Default: 'warn'

***

### retry?

> `readonly` `optional` **retry?**: `false` \| [`RetryPolicy`](RetryPolicy.md)

Defined in: [packages/sdk/src/types/client-options.ts:100](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L100)

Retry policy. Set to false to disable all retry logic.
Defaults to sensible values when omitted.

***

### timeout?

> `readonly` `optional` **timeout?**: `number`

Defined in: [packages/sdk/src/types/client-options.ts:106](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/client-options.ts#L106)

Per-request timeout in milliseconds. Default: 30000.
Set to 0 to disable (not recommended).
