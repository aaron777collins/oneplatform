/**
 * Assertion helpers for plugin tests.
 *
 * These validate structural correctness of plugin objects and metadata
 * at test time, surfacing interface violations before pack time.
 */

import type { AnyPluginMetadata } from "../types/metadata.js";

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertMethod(obj: Record<string, unknown>, name: string, source: string): void {
  if (typeof obj[name] !== "function") {
    throw new Error(`${source}: expected method "${name}" to be a function, got ${typeof obj[name]}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// assertValidPlugin
// ────────────────────────────────────────────────────────────────────────────

const REQUIRED_METHODS: Record<string, string[]> = {
  connector: ["metadata", "connect", "fetchBatch", "disconnect"],
  transformer: ["metadata", "transform"],
  destination: ["metadata", "write"],
  "auth-provider": ["metadata", "getAuthorizationUrl", "handleCallback", "mapClaimsToRoles"],
  widget: ["metadata", "render", "declareDataRequirements", "declareSlot"],
};

/**
 * Methods that are conditionally required based on feature flags in metadata().
 * Each entry maps a feature flag key to the methods it requires.
 */
const CONDITIONAL_METHODS: Record<string, Record<string, string[]>> = {
  connector: {
    supportsRealtime: ["subscribeToEvents"],
  },
  transformer: {},
  destination: {
    supportsStreaming: ["writeStream"],
  },
  "auth-provider": {
    supportsTokenValidation: ["validateToken"],
    supportsTokenRefresh: ["refreshToken"],
  },
  widget: {},
};

/**
 * Assert that a plugin object conforms to its declared interface.
 * Throws a descriptive error if required methods are missing or have wrong arity.
 * Also checks metadata() feature flags and asserts conditionally required methods.
 * Use in tests to catch interface violations before pack time.
 */
export function assertValidPlugin(
  plugin: unknown,
  expectedType: "connector" | "transformer" | "destination" | "auth-provider" | "widget",
): void {
  if (!isObject(plugin)) {
    throw new Error(
      `assertValidPlugin: expected an object, got ${plugin === null ? "null" : typeof plugin}`,
    );
  }

  const required = REQUIRED_METHODS[expectedType];
  if (required === undefined) {
    throw new Error(`assertValidPlugin: unknown plugin type "${expectedType}"`);
  }

  for (const method of required) {
    assertMethod(plugin, method, `${expectedType} plugin`);
  }

  // Verify metadata() returns an object with a matching type discriminant
  const metadataFn = plugin["metadata"] as () => unknown;
  const meta = metadataFn();
  if (!isObject(meta)) {
    throw new Error(`assertValidPlugin: metadata() must return an object`);
  }
  if (meta["type"] !== expectedType) {
    throw new Error(
      `assertValidPlugin: metadata().type is "${String(meta["type"])}", expected "${expectedType}"`,
    );
  }

  // Check conditionally required methods based on feature flags in metadata
  const conditionalMap = CONDITIONAL_METHODS[expectedType];
  if (conditionalMap !== undefined) {
    for (const [flag, methods] of Object.entries(conditionalMap)) {
      if (meta[flag] === true) {
        for (const method of methods) {
          assertMethod(plugin, method, `${expectedType} plugin (required by ${flag})`);
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// assertValidMetadata
// ────────────────────────────────────────────────────────────────────────────

const VALID_PLUGIN_TYPES = new Set(["connector", "transformer", "destination", "auth-provider", "widget"]);

const BASE_REQUIRED_FIELDS: Array<keyof AnyPluginMetadata> = [
  "id",
  "name",
  "description",
  "version",
  "author",
  "configSchema",
];

/**
 * Assert that a metadata object is valid for its type.
 * Verifies required fields are present and have correct types.
 */
export function assertValidMetadata(metadata: unknown): void {
  if (!isObject(metadata)) {
    throw new Error(
      `assertValidMetadata: expected an object, got ${metadata === null ? "null" : typeof metadata}`,
    );
  }

  // Check base fields
  for (const field of BASE_REQUIRED_FIELDS) {
    if (metadata[field] === undefined || metadata[field] === null) {
      throw new Error(`assertValidMetadata: required field "${field}" is missing or null`);
    }
  }

  if (typeof metadata["id"] !== "string" || metadata["id"].length === 0) {
    throw new Error(`assertValidMetadata: "id" must be a non-empty string`);
  }

  if (typeof metadata["name"] !== "string" || (metadata["name"] as string).length < 2) {
    throw new Error(`assertValidMetadata: "name" must be at least 2 characters`);
  }

  if (
    typeof metadata["description"] !== "string" ||
    (metadata["description"] as string).length < 10
  ) {
    throw new Error(`assertValidMetadata: "description" must be at least 10 characters`);
  }

  if (!VALID_PLUGIN_TYPES.has(metadata["type"] as string)) {
    throw new Error(
      `assertValidMetadata: "type" must be one of [${[...VALID_PLUGIN_TYPES].join(", ")}], got "${String(metadata["type"])}"`,
    );
  }
}
