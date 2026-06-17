[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / loadConfig

# Function: loadConfig()

> **loadConfig**\<`S`\>(`serviceSchema`): `TypeOf`\<`S`\>

Defined in: [packages/core/src/config.ts:140](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/config.ts#L140)

Loads and validates environment variables against the provided service-specific schema.

Each service passes its own schema so startup fails only when THAT service's
required vars are absent, not vars belonging to other services.

## Type Parameters

### S

`S` *extends* `ZodTypeAny`

## Parameters

### serviceSchema

`S`

## Returns

`TypeOf`\<`S`\>

## Throws

`Error` with a human-readable list of all validation failures when
  any required variable is missing or malformed. The error message is
  designed to be read directly from container logs.

## Example

```ts
import { loadConfig, gatewayConfigSchema } from "@oneplatform/core";
  const config = loadConfig(gatewayConfigSchema);
```
