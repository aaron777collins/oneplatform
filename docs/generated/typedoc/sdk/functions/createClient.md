[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / createClient

# Function: createClient()

> **createClient**(`options`): [`OnePlatformClient`](../interfaces/OnePlatformClient.md)

Defined in: [packages/sdk/src/client.ts:149](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L149)

Creates a new OnePlatform API client.

Construction is synchronous and performs no I/O — connection errors surface
on the first API call. Multiple independent client instances can coexist in
the same process (zero global state).

## Parameters

### options

[`ClientOptions`](../interfaces/ClientOptions.md)

Client configuration including `baseUrl` and `auth`.

## Returns

[`OnePlatformClient`](../interfaces/OnePlatformClient.md)

A fully-initialised [OnePlatformClient](../interfaces/OnePlatformClient.md).

## Throws

[ConfigurationError](../classes/ConfigurationError.md) when required options are missing or invalid.

## Examples

**Node.js with API key**

```ts
const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: { apiKey: 'op_live_...' },
});
```

**Browser with PKCE**

```ts
const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: { browser: { clientId: 'my-app' } },
});
```
