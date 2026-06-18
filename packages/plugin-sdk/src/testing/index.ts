/**
 * @oneplatform/plugin-sdk/testing — testing utilities re-export.
 *
 * Import from this path in plugin test suites only.
 * Never import in production plugin code.
 */

export { createMockContext } from "./mock-context.js";
export type {
  MockContextOptions,
  MockContext,
  MockCredentialAccessor,
  MockFetchProxy,
  MockLogger,
  MockCredentialCall,
  MockFetchCall,
  MockLogEntry,
  MockSpan,
  MockSpanAttributeCall,
} from "./mock-context.js";

export {
  createConnectorMockContext,
  createAuthProviderMockContext,
  createDestinationMockContext,
  createTransformerMockContext,
  CONNECTOR_SAMPLE_RECORDS,
  AUTH_SAMPLE_TOKEN_RESPONSE,
  AUTH_SAMPLE_USERINFO,
  TRANSFORMER_SAMPLE_INPUT_RECORDS,
} from "./mock-factories.js";
export type {
  MockConnectorContext,
  MockConnectorContextOptions,
  ConnectorFetchResponse,
  MockAuthProviderContext,
  MockAuthProviderContextOptions,
  TokenResponse,
  UserinfoResponse,
  MockDestinationContext,
  MockDestinationContextOptions,
  MockDestinationWriteCall,
  MockTransformerFactoryContext,
  MockTransformerContextOptions,
} from "./mock-factories.js";

export { assertValidPlugin, assertValidMetadata } from "./assertions.js";

export { simulateHook } from "./simulate-hook.js";
export type { SimulateHookOptions, SimulateHookResult } from "./simulate-hook.js";
