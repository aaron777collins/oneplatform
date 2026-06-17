**@oneplatform/sdk**

***

# @oneplatform/sdk

@oneplatform/sdk — TypeScript client for the OnePlatform API.

## Quick start
```ts
import { createClient } from '@oneplatform/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: { apiKey: 'op_live_...' },
});

const products = client.data.entity('Product').list();
for await (const page of products) {
  console.log(page.items);
}
```

Only types and values that external consumers need are re-exported here.
Transport internals, auth handler implementations, and platform-type
constructors are kept package-private.

## Classes

- [AuthError](classes/AuthError.md)
- [ClientError](classes/ClientError.md)
- [ConfigurationError](classes/ConfigurationError.md)
- [ConflictError](classes/ConflictError.md)
- [CursorExpiredError](classes/CursorExpiredError.md)
- [ForbiddenError](classes/ForbiddenError.md)
- [NetworkError](classes/NetworkError.md)
- [NotFoundError](classes/NotFoundError.md)
- [OnePlatformError](classes/OnePlatformError.md)
- [PaginationLimitError](classes/PaginationLimitError.md)
- [RateLimitError](classes/RateLimitError.md)
- [ServerError](classes/ServerError.md)
- [ValidationError](classes/ValidationError.md)

## Interfaces

- [AccessTokenAuthConfig](interfaces/AccessTokenAuthConfig.md)
- [ApiKey](interfaces/ApiKey.md)
- [ApiKeyAuthConfig](interfaces/ApiKeyAuthConfig.md)
- [App](interfaces/App.md)
- [AuditEntry](interfaces/AuditEntry.md)
- [AuditQueryOptions](interfaces/AuditQueryOptions.md)
- [BrowserAuthConfig](interfaces/BrowserAuthConfig.md)
- [BulkOperation](interfaces/BulkOperation.md)
- [BulkResult](interfaces/BulkResult.md)
- [ClientOptions](interfaces/ClientOptions.md)
- [ConnectorInstance](interfaces/ConnectorInstance.md)
- [ConnectorTestResult](interfaces/ConnectorTestResult.md)
- [CreateApiKeyRequest](interfaces/CreateApiKeyRequest.md)
- [CreateAppRequest](interfaces/CreateAppRequest.md)
- [CreateConnectorRequest](interfaces/CreateConnectorRequest.md)
- [CreatedApiKey](interfaces/CreatedApiKey.md)
- [CreateOntologyRequest](interfaces/CreateOntologyRequest.md)
- [CreatePipelineRequest](interfaces/CreatePipelineRequest.md)
- [CreatePluginRequest](interfaces/CreatePluginRequest.md)
- [CreateUserRequest](interfaces/CreateUserRequest.md)
- [CursorResult](interfaces/CursorResult.md)
- [FieldConditionBuilder](interfaces/FieldConditionBuilder.md)
- [FilterBuilder](interfaces/FilterBuilder.md)
- [GetOptions](interfaces/GetOptions.md)
- [ListOptions](interfaces/ListOptions.md)
- [LogEntry](interfaces/LogEntry.md)
- [LogQueryOptions](interfaces/LogQueryOptions.md)
- [MigrationStatus](interfaces/MigrationStatus.md)
- [MutationOptions](interfaces/MutationOptions.md)
- [OnePlatformClient](interfaces/OnePlatformClient.md)
- [OntologyDiff](interfaces/OntologyDiff.md)
- [OntologyField](interfaces/OntologyField.md)
- [OntologyRelationship](interfaces/OntologyRelationship.md)
- [OntologySchema](interfaces/OntologySchema.md)
- [Page](interfaces/Page.md)
- [PaginatedIterable](interfaces/PaginatedIterable.md)
- [PaginationOptions](interfaces/PaginationOptions.md)
- [Pipeline](interfaces/Pipeline.md)
- [PipelineDefinition](interfaces/PipelineDefinition.md)
- [PipelineRun](interfaces/PipelineRun.md)
- [PipelineStep](interfaces/PipelineStep.md)
- [PlatformEvent](interfaces/PlatformEvent.md)
- [Plugin](interfaces/Plugin.md)
- [ResolvedClientConfig](interfaces/ResolvedClientConfig.md)
- [RetryPolicy](interfaces/RetryPolicy.md)
- [Subscription](interfaces/Subscription.md)
- [SubscriptionOptions](interfaces/SubscriptionOptions.md)
- [TailOptions](interfaces/TailOptions.md)
- [UpdateAppRequest](interfaces/UpdateAppRequest.md)
- [UpdateConnectorRequest](interfaces/UpdateConnectorRequest.md)
- [UpdateOntologyRequest](interfaces/UpdateOntologyRequest.md)
- [UpdatePipelineRequest](interfaces/UpdatePipelineRequest.md)
- [UpdatePluginRequest](interfaces/UpdatePluginRequest.md)
- [UpdateUserRequest](interfaces/UpdateUserRequest.md)
- [User](interfaces/User.md)
- [ValidateOntologyRequest](interfaces/ValidateOntologyRequest.md)
- [ValidationResult](interfaces/ValidationResult.md)
- [WhoAmIResponse](interfaces/WhoAmIResponse.md)

## Type Aliases

- [AuthConfig](type-aliases/AuthConfig.md)
- [BulkResultItem](type-aliases/BulkResultItem.md)
- [PageFetcher](type-aliases/PageFetcher.md)
- [PipelineInputSource](type-aliases/PipelineInputSource.md)
- [PipelineTrigger](type-aliases/PipelineTrigger.md)
- [SortSpec](type-aliases/SortSpec.md)

## Functions

- [createClient](functions/createClient.md)
- [filter](functions/filter.md)
