---
title: "@oneplatform/plugin-sdk"
description: SDK for building OnePlatform plugins with hook handlers and test utilities.
sidebar:
  order: 1
---

`@oneplatform/plugin-sdk` provides the `definePlugin` factory and supporting types for
building platform plugins. It also ships a testing subpath (`@oneplatform/plugin-sdk/testing`)
with `createMockContext` for writing isolated unit tests without a running platform.

## Installation

```sh
npm install @oneplatform/plugin-sdk
```

## Quick start

```ts
import { definePlugin } from "@oneplatform/plugin-sdk";

export default definePlugin({
  hooks: {
    "before:ingestion.receive": async (event, ctx) => {
      if (typeof event.data.email === "string") {
        event.data.email = event.data.email.toLowerCase();
      }
      ctx.log.info("Email normalized", { email: event.data.email });
      return event;
    },
  },
});
```

## Testing

```ts
import { createMockContext } from "@oneplatform/plugin-sdk/testing";

test("normalizes email to lowercase", async () => {
  const ctx = createMockContext();
  const result = await myPlugin.hooks["before:ingestion.receive"](
    { data: { email: "USER@EXAMPLE.COM" } },
    ctx,
  );
  expect(result.data.email).toBe("user@example.com");
});
```

## Hook points

| Hook | Trigger |
|------|---------|
| `before:ingestion.receive` | Before a connector record is stored |
| `after:ingestion.receive` | After a connector record is stored |
| `before:pipeline.step` | Before each pipeline step |
| `after:pipeline.step` | After each pipeline step |
| `before:app.request` | Before a BFF request is forwarded |

## Resources

- [Plugin Developer Quickstart](/getting-started/plugin-developer)
- [Plugin Service API](/api/plugin)
