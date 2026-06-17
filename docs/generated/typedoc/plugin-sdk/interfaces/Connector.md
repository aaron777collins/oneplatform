[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / Connector

# Interface: Connector

Defined in: [packages/plugin-sdk/src/types/connector.ts:65](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L65)

## Methods

### connect()

> **connect**(`config`, `context`): `Promise`\<[`ConnectorHandle`](ConnectorHandle.md)\>

Defined in: [packages/plugin-sdk/src/types/connector.ts:84](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L84)

Validate the plugin configuration and credentials, and establish a connection.
Called once per ingestion job before the first fetchBatch call.

This method should be fast (< 5 seconds). If the external service requires
a round-trip for auth (e.g., OAuth token refresh), do it here and cache the
token in the context.cache.

#### Parameters

##### config

`Record`\<`string`, `unknown`\>

##### context

[`PluginContext`](PluginContext.md)

#### Returns

`Promise`\<[`ConnectorHandle`](ConnectorHandle.md)\>

#### Throws

PluginConfigError if config is invalid or missing required fields.

#### Throws

PluginAuthError if credential validation fails.

***

### disconnect()

> **disconnect**(`handle`, `context`): `Promise`\<`void`\>

Defined in: [packages/plugin-sdk/src/types/connector.ts:132](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L132)

Clean up the connection. Called after the ingestion job completes or on error.
Must not throw. If cleanup fails, log the error and return.

Resources to release: HTTP connections, open file handles, WebSocket connections.
Do NOT revoke OAuth tokens here — they may be reused by the next ingestion run.

#### Parameters

##### handle

[`ConnectorHandle`](ConnectorHandle.md)

##### context

[`PluginContext`](PluginContext.md)

#### Returns

`Promise`\<`void`\>

***

### fetchBatch()

> **fetchBatch**(`handle`, `cursor`, `context`): `Promise`\<[`BatchResult`](BatchResult.md)\>

Defined in: [packages/plugin-sdk/src/types/connector.ts:101](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L101)

Fetch the next batch of records from the external system.

cursor=null signals the first call (fetch from the beginning of available data).
For incremental syncs, the cursor is the value returned by the previous fetchBatch.
The platform stores the last successful cursor and resumes from it on retry.

Batch size should be controlled by the connector, typically 100-1000 records.
Avoid batches larger than 10,000 records — the platform's ingestion queue has
per-message limits.

#### Parameters

##### handle

[`ConnectorHandle`](ConnectorHandle.md)

##### cursor

`string` \| `null`

##### context

[`PluginContext`](PluginContext.md)

#### Returns

`Promise`\<[`BatchResult`](BatchResult.md)\>

#### Throws

PluginRateLimitError if the external API returns 429.

#### Throws

PluginTimeoutError if a network call exceeds the configured timeout.

#### Throws

PluginAuthError if the connection credentials have expired.

***

### metadata()

> **metadata**(): [`ConnectorMetadata`](ConnectorMetadata.md)

Defined in: [packages/plugin-sdk/src/types/connector.ts:71](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L71)

Return the connector's metadata. Called by the Plugin Service at install time
to verify the entrypoint is valid, and by the Ingestion Service to display
connector details in the data source catalog.

#### Returns

[`ConnectorMetadata`](ConnectorMetadata.md)

***

### subscribeToEvents()?

> `optional` **subscribeToEvents**(`handle`, `callback`, `context`): `Promise`\<[`Subscription`](Subscription.md)\>

Defined in: [packages/plugin-sdk/src/types/connector.ts:119](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L119)

Subscribe to real-time change events from the external system.
Only implement if ConnectorMetadata.supportsRealtime is true.

The platform calls this method once when a real-time data source is activated.
The callback receives individual change events as they arrive. Each callback
invocation is an async operation — the connector must await it before processing
the next event to maintain ordering.

The returned Subscription must remain active until unsubscribe() is called,
which happens when the tenant disables real-time on the data source.

#### Parameters

##### handle

[`ConnectorHandle`](ConnectorHandle.md)

##### callback

[`EventCallback`](EventCallback.md)

##### context

[`PluginContext`](PluginContext.md)

#### Returns

`Promise`\<[`Subscription`](Subscription.md)\>
