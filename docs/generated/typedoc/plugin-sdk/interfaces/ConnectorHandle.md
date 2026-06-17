[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / ConnectorHandle

# Interface: ConnectorHandle

Defined in: [packages/plugin-sdk/src/types/connector.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L16)

## Properties

### connectionId

> **connectionId**: `string`

Defined in: [packages/plugin-sdk/src/types/connector.ts:23](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L23)

Opaque identifier for this active connection, assigned by the plugin.
Used to correlate fetchBatch and disconnect calls to the same connection.
Must be a string. The platform stores this between fetchBatch calls to
support resumable ingestion.

***

### metadata

> **metadata**: `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/connector.ts:30](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/connector.ts#L30)

Plugin-managed connection state. May include auth tokens, base URLs,
or other values needed by fetchBatch and disconnect.
Must be JSON-serializable (the platform may checkpoint this between calls).
