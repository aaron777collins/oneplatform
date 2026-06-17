[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / TracingContext

# Interface: TracingContext

Defined in: [packages/plugin-sdk/src/types/context.ts:194](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L194)

## Methods

### injectHeaders()

> **injectHeaders**(`headers`): `Record`\<`string`, `string`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:205](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L205)

Inject the current trace context into an outbound request headers object.
Use this with FetchProxy to propagate distributed traces into external service
calls. The returned object is a new object containing the original headers
plus the injected trace headers (W3C traceparent/tracestate).

Example:
  const headers = ctx.tracing.injectHeaders({ "Content-Type": "application/json" });
  const response = await ctx.fetch(url, { headers });

#### Parameters

##### headers

`Record`\<`string`, `string`\>

#### Returns

`Record`\<`string`, `string`\>

***

### startSpan()

> **startSpan**(`name`): [`SpanHandle`](SpanHandle.md)

Defined in: [packages/plugin-sdk/src/types/context.ts:221](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L221)

Create a child span for a named operation. The span is automatically parented
to the current execution trace. Call setAttribute() to add context, and always
call end() in a finally block.

Example:
  const span = ctx.tracing.startSpan("fetchOrders");
  try {
    // ... do work ...
    span.setAttribute("order.count", records.length);
  } finally {
    span.end();
  }

#### Parameters

##### name

`string`

#### Returns

[`SpanHandle`](SpanHandle.md)
