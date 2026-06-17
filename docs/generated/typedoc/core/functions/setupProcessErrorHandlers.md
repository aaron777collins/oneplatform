[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / setupProcessErrorHandlers

# Function: setupProcessErrorHandlers()

> **setupProcessErrorHandlers**(`logger?`): `void`

Defined in: [packages/core/src/app.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L38)

Registers global handlers for uncaught exceptions and unhandled rejections.

Call once per process at startup. The function is idempotent — subsequent
calls are no-ops so services can call it unconditionally during bootstrap.

All fatal errors are written to `process.stderr` as structured JSON before
the process exits, ensuring container runtimes capture them even when the
structured logger itself is unavailable.

## Parameters

### logger?

Optional structured logger; used in addition to stderr output.

#### error

## Returns

`void`
