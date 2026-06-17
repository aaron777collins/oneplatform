[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / OnePlatformClient

# Interface: OnePlatformClient

Defined in: [packages/sdk/src/client.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L63)

The fully-initialised OnePlatform API client.

Obtain an instance via [createClient](../functions/createClient.md). Each namespace corresponds to a
top-level resource group in the REST API (e.g. `client.apps` maps to
`GET /api/v1/apps`).

## Properties

### apiKeys

> `readonly` **apiKeys**: `ApiKeyNamespace`

Defined in: [packages/sdk/src/client.ts:91](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L91)

API key management — create and revoke API keys.

***

### apps

> `readonly` **apps**: `AppNamespace`

Defined in: [packages/sdk/src/client.ts:85](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L85)

Application management — CRUD, build, and deploy hosted apps.

***

### connectors

> `readonly` **connectors**: `ConnectorNamespace`

Defined in: [packages/sdk/src/client.ts:76](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L76)

Connector lifecycle management — register, test, and trigger syncs.

***

### data

> `readonly` **data**: `DataNamespace`

Defined in: [packages/sdk/src/client.ts:70](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L70)

Ontology-typed entity CRUD.

Access a resource with `client.data.entity('Product')` or, with generated
typed clients, `client.data.Product`.

***

### events

> `readonly` **events**: `EventNamespace`

Defined in: [packages/sdk/src/client.ts:82](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L82)

Real-time entity event subscriptions via Server-Sent Events.

***

### logs

> `readonly` **logs**: `LogNamespace`

Defined in: [packages/sdk/src/client.ts:97](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L97)

Log and audit trail queries — stream logs and fetch audit entries.

***

### ontologies

> `readonly` **ontologies**: `OntologyNamespace`

Defined in: [packages/sdk/src/client.ts:79](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L79)

Ontology schema management — define, validate, and migrate schemas.

***

### pipelines

> `readonly` **pipelines**: `PipelineNamespace`

Defined in: [packages/sdk/src/client.ts:73](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L73)

Pipeline management — create, trigger, and monitor runs.

***

### plugins

> `readonly` **plugins**: `PluginNamespace`

Defined in: [packages/sdk/src/client.ts:88](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L88)

Plugin lifecycle management — install and configure plugins.

***

### users

> `readonly` **users**: `UserNamespace`

Defined in: [packages/sdk/src/client.ts:94](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L94)

User management (admin-only) — provision and update user accounts.

## Methods

### destroy()

> **destroy**(): `void`

Defined in: [packages/sdk/src/client.ts:119](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L119)

Terminates all active SSE subscriptions and aborts in-flight requests.

The client must not be reused after calling `destroy()`. Create a new
client instance if you need to make further requests.

#### Returns

`void`

***

### getConfig()

> **getConfig**(): `Readonly`\<[`ResolvedClientConfig`](ResolvedClientConfig.md)\>

Defined in: [packages/sdk/src/client.ts:103](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L103)

Returns the resolved options this client was constructed with.
Auth tokens are redacted from the returned object.

#### Returns

`Readonly`\<[`ResolvedClientConfig`](ResolvedClientConfig.md)\>

***

### ping()

> **ping**(): `Promise`\<[`WhoAmIResponse`](WhoAmIResponse.md)\>

Defined in: [packages/sdk/src/client.ts:111](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/client.ts#L111)

Verifies connectivity and authentication.

Calls `GET /api/v1/auth/whoami` and resolves with the current user
identity, or throws an [AuthError](../classes/AuthError.md) if the credentials are invalid.

#### Returns

`Promise`\<[`WhoAmIResponse`](WhoAmIResponse.md)\>
