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

export { assertValidPlugin, assertValidMetadata } from "./assertions.js";

export { simulateHook } from "./simulate-hook.js";
export type { SimulateHookOptions, SimulateHookResult } from "./simulate-hook.js";
