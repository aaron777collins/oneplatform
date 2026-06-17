[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / RateLimitError

# Class: RateLimitError

Defined in: [packages/sdk/src/errors/rate-limit-error.ts:15](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/rate-limit-error.ts#L15)

## Extends

- [`OnePlatformError`](OnePlatformError.md)

## Constructors

### Constructor

> **new RateLimitError**(`options`): `RateLimitError`

Defined in: [packages/sdk/src/errors/rate-limit-error.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/rate-limit-error.ts#L25)

#### Parameters

##### options

`RateLimitErrorOptions`

#### Returns

`RateLimitError`

#### Overrides

[`OnePlatformError`](OnePlatformError.md).[`constructor`](OnePlatformError.md#constructor)

## Properties

### cause?

> `optional` **cause?**: `unknown`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es2022.error.d.ts:26

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`cause`](OnePlatformError.md#cause)

***

### code

> `readonly` **code**: `string`

Defined in: [packages/sdk/src/errors/base.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/base.ts#L22)

Platform error code (SCREAMING_SNAKE_CASE). "SDK_ERROR" for pre-flight errors.

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`code`](OnePlatformError.md#code)

***

### details

> `readonly` **details**: `Record`\<`string`, `unknown`\> \| `undefined`

Defined in: [packages/sdk/src/errors/base.ts:31](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/base.ts#L31)

Structured details from the server error body.

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`details`](OnePlatformError.md#details)

***

### message

> **message**: `string`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es5.d.ts:1077

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`message`](OnePlatformError.md#message)

***

### name

> **name**: `string`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es5.d.ts:1076

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`name`](OnePlatformError.md#name)

***

### requestId

> `readonly` **requestId**: `string` \| `undefined`

Defined in: [packages/sdk/src/errors/base.ts:28](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/base.ts#L28)

Platform request ID for log correlation with support.

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`requestId`](OnePlatformError.md#requestid)

***

### response

> `readonly` **response**: `Response` \| `undefined`

Defined in: [packages/sdk/src/errors/base.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/base.ts#L41)

Original response object, if the error originated from an HTTP response.
Useful for reading custom headers such as X-RateLimit-Reset.
Not included in JSON serialization.

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`response`](OnePlatformError.md#response)

***

### retryable

> `readonly` **retryable**: `true`

Defined in: [packages/sdk/src/errors/rate-limit-error.ts:17](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/rate-limit-error.ts#L17)

Whether this error type is safe to retry.

#### Overrides

[`OnePlatformError`](OnePlatformError.md).[`retryable`](OnePlatformError.md#retryable)

***

### retryAfterSeconds

> `readonly` **retryAfterSeconds**: `number` \| `null`

Defined in: [packages/sdk/src/errors/rate-limit-error.ts:23](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/rate-limit-error.ts#L23)

Seconds until the rate limit window resets.
null when the server did not include a Retry-After header.

***

### stack?

> `optional` **stack?**: `string`

Defined in: node\_modules/.pnpm/typescript@5.9.3/node\_modules/typescript/lib/lib.es5.d.ts:1078

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`stack`](OnePlatformError.md#stack)

***

### statusCode

> `readonly` **statusCode**: `429`

Defined in: [packages/sdk/src/errors/rate-limit-error.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/rate-limit-error.ts#L16)

HTTP status code. Undefined for NetworkError and ConfigurationError.

#### Overrides

[`OnePlatformError`](OnePlatformError.md).[`statusCode`](OnePlatformError.md#statuscode)

***

### stackTraceLimit

> `static` **stackTraceLimit**: `number`

Defined in: node\_modules/.pnpm/@types+node@20.19.42/node\_modules/@types/node/globals.d.ts:68

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`stackTraceLimit`](OnePlatformError.md#stacktracelimit)

## Methods

### toJSON()

> **toJSON**(): `Record`\<`string`, `unknown`\>

Defined in: [packages/sdk/src/errors/base.ts:57](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/errors/base.ts#L57)

#### Returns

`Record`\<`string`, `unknown`\>

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`toJSON`](OnePlatformError.md#tojson)

***

### captureStackTrace()

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Defined in: node\_modules/.pnpm/@types+node@20.19.42/node\_modules/@types/node/globals.d.ts:52

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

#### Parameters

##### targetObject

`object`

##### constructorOpt?

`Function`

#### Returns

`void`

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`captureStackTrace`](OnePlatformError.md#capturestacktrace)

***

### prepareStackTrace()

> `static` **prepareStackTrace**(`err`, `stackTraces`): `any`

Defined in: node\_modules/.pnpm/@types+node@20.19.42/node\_modules/@types/node/globals.d.ts:56

#### Parameters

##### err

`Error`

##### stackTraces

`CallSite`[]

#### Returns

`any`

#### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

[`OnePlatformError`](OnePlatformError.md).[`prepareStackTrace`](OnePlatformError.md#preparestacktrace)
