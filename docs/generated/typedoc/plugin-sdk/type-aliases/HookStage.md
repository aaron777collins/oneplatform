[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / HookStage

# Type Alias: HookStage

> **HookStage** = `"before:ingestion.receive"` \| `"after:ingestion.receive"` \| `"before:ingestion.validate"` \| `"after:ingestion.validate"` \| `"before:ingestion.enrich"` \| `"after:ingestion.enrich"` \| `"before:ingestion.stage"` \| `"after:ingestion.stage"` \| `"before:ontology.map"` \| `"after:ontology.map"` \| `"before:ontology.normalize"` \| `"after:ontology.normalize"` \| `"before:pipeline.trigger"` \| `"after:pipeline.trigger"` \| `"before:pipeline.step"` \| `"after:pipeline.step"` \| `"before:pipeline.complete"` \| `"after:pipeline.complete"` \| `"before:execution.setup"` \| `"after:execution.setup"` \| `"before:execution.teardown"` \| `"after:execution.teardown"` \| `"before:auth.login"` \| `"after:auth.login"` \| `"after:auth.logout"` \| `"before:auth.token.issue"` \| `"after:auth.token.issue"` \| `"before:app.request"` \| `"after:app.request"` \| `"before:app.build"` \| `"after:app.build"` \| `` `before:pipeline.step:${string}` `` \| `` `after:pipeline.step:${string}` ``

Defined in: [packages/plugin-sdk/src/types/hooks.ts:15](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L15)

All valid hook stages. The pattern is "{timing}:{domain}.{event}" or
"{timing}:{domain}.{event}:{stepId}" for parameterized pipeline step hooks.

Timing: "before" = before the stage executes; "after" = after the stage executes.
