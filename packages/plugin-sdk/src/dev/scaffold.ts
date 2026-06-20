/**
 * op plugin create — interactive scaffold generator.
 *
 * Templates are embedded as string constants (not read from disk) so the scaffold
 * works correctly from a compiled binary where no template files exist on the filesystem.
 * See D6 in the design decision log.
 *
 * This module is imported by the @oneplatform/cli package and is not part of the
 * plugin SDK's public API surface.
 */

import type { PluginManifest } from "../manifest/schema.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type PluginType = PluginManifest["type"];

export interface ScaffoldOptions {
  type: PluginType;
  id: string;
  name: string;
  author: string;
  outputDir: string;
}

export interface ScaffoldedFile {
  relativePath: string;
  content: string;
}

export interface ScaffoldResult {
  outputDir: string;
  files: ScaffoldedFile[];
}

// ────────────────────────────────────────────────────────────────────────────
// Manifest template
// ────────────────────────────────────────────────────────────────────────────

function buildManifest(opts: ScaffoldOptions, entrypoint: string): string {

  const typeSpecific: Record<PluginType, object> = {
    connector: {
      configSchema: {
        type: "object",
        required: ["baseUrl"],
        properties: {
          baseUrl: {
            type: "string",
            description: "Base URL of the external API",
          },
        },
      },
      requiredExternalUrls: ["https://api.example.com/**"],
      requiredApis: ["credentials", "fetch", "cache"],
      requiredCredentials: [
        {
          name: "apiKey",
          description: "API key for authentication",
          type: "token",
          required: true,
        },
      ],
    },
    transformer: {
      configSchema: { type: "object", properties: {} },
      requiredExternalUrls: [],
      requiredApis: ["cache"],
      requiredCredentials: [],
    },
    destination: {
      configSchema: {
        type: "object",
        required: ["endpointUrl"],
        properties: {
          endpointUrl: { type: "string", description: "Destination endpoint URL" },
        },
      },
      requiredExternalUrls: ["https://api.example.com/**"],
      requiredApis: ["credentials", "fetch"],
      requiredCredentials: [
        {
          name: "apiKey",
          description: "API key for authentication",
          type: "token",
          required: true,
        },
      ],
    },
    "auth-provider": {
      configSchema: {
        type: "object",
        required: ["clientId"],
        properties: {
          clientId: { type: "string", description: "OAuth2 client ID" },
        },
      },
      requiredExternalUrls: ["https://auth.example.com/**"],
      requiredApis: ["credentials", "fetch", "cache"],
      requiredCredentials: [
        {
          name: "clientSecret",
          description: "OAuth2 client secret",
          type: "secret",
          required: true,
        },
      ],
    },
    widget: {
      configSchema: { type: "object", properties: {} },
      requiredExternalUrls: [],
      requiredApis: ["ontology"],
      requiredCredentials: [],
    },
  };

  const manifest = {
    manifestVersion: "1",
    id: opts.id,
    name: opts.name,
    version: "0.1.0",
    type: opts.type,
    description: `A OnePlatform ${opts.type} plugin`,
    author: opts.author,
    minPlatformVersion: "1.0.0",
    entrypoint,
    hooks: [],
    bundleChecksum: "",
    license: "MIT",
    tags: [opts.type],
    ...typeSpecific[opts.type],
  };

  return JSON.stringify(manifest, null, 2) + "\n";
}

// ────────────────────────────────────────────────────────────────────────────
// Source file templates (embedded as string constants)
// ────────────────────────────────────────────────────────────────────────────

function buildConnectorSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import type {
  Connector,
  ConnectorHandle,
  ConnectorMetadata,
  BatchResult,
  PluginContext,
} from "@oneplatform/plugin-sdk";
import { PluginAuthError, PluginConfigError } from "@oneplatform/plugin-sdk";

export const ${entrypoint}: Connector = {
  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "${escapeJsString(opts.id)}",
      name: "${escapeJsString(opts.name)}",
      description: "A OnePlatform connector plugin",
      version: "0.1.0",
      author: "${escapeJsString(opts.author)}",
      category: "other",
      configSchema: {
        type: "object",
        required: ["baseUrl"],
        properties: {
          baseUrl: { type: "string" },
        },
      },
      outputSchema: { type: "object", properties: {} },
      supportsIncremental: true,
      supportsRealtime: false,
    };
  },

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const baseUrl = config["baseUrl"];
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw new PluginConfigError("baseUrl is required", "baseUrl");
    }

    // Retrieve and validate the API key credential up front so that a missing
    // credential fails fast at connect time rather than silently during fetches.
    const apiKey = await context.credentials.get("apiKey");
    if (!apiKey) {
      throw new PluginAuthError("Missing required credential: apiKey");
    }

    return {
      connectionId: \`conn-\${Date.now()}\`,
      metadata: { baseUrl, authenticated: true },
    };
  },

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const offset = cursor !== null ? parseInt(cursor, 10) : 0;
    context.logger.info("Fetching batch", { offset, baseUrl: handle.metadata["baseUrl"] });

    // Minimal scaffold: returns an empty page to signal end-of-stream.
    // Replace this with an actual HTTP call to handle.metadata["baseUrl"].
    return {
      records: [],
      nextCursor: null,
      hasMore: false,
      fetchedAt: new Date().toISOString(),
    };
  },

  async disconnect(
    handle: ConnectorHandle,
    context: PluginContext,
  ): Promise<void> {
    context.logger.info("Disconnecting", { connectionId: handle.connectionId });
  },
};
`;
}

function buildTransformerSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import type {
  Transformer,
  TransformerMetadata,
  DataRecord,
  TransformerContext,
} from "@oneplatform/plugin-sdk";
import { PluginDataError } from "@oneplatform/plugin-sdk";

export const ${entrypoint}: Transformer = {
  metadata(): TransformerMetadata {
    return {
      type: "transformer",
      id: "${escapeJsString(opts.id)}",
      name: "${escapeJsString(opts.name)}",
      description: "A OnePlatform transformer plugin",
      version: "0.1.0",
      author: "${escapeJsString(opts.author)}",
      configSchema: { type: "object", properties: {} },
      idempotent: true,
    };
  },

  async transform(
    record: DataRecord,
    context: TransformerContext,
  ): Promise<DataRecord | null> {
    context.logger.debug("Transforming record", { sourceId: record.sourceId });

    if (!record.sourceId) {
      throw new PluginDataError("Record missing sourceId", record);
    }

    // Minimal scaffold: pass the record through unchanged.
    // Replace with field-level transformations as needed.
    return record;
  },
};
`;
}

function buildDestinationSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import type {
  Destination,
  DestinationMetadata,
  MappedRecord,
  DestinationContext,
  WriteResult,
} from "@oneplatform/plugin-sdk";

export const ${entrypoint}: Destination = {
  metadata(): DestinationMetadata {
    return {
      type: "destination",
      id: "${escapeJsString(opts.id)}",
      name: "${escapeJsString(opts.name)}",
      description: "A OnePlatform destination plugin",
      version: "0.1.0",
      author: "${escapeJsString(opts.author)}",
      configSchema: {
        type: "object",
        required: ["endpointUrl"],
        properties: {
          endpointUrl: { type: "string" },
        },
      },
      deliveryGuarantee: "at-least-once",
      supportsBulk: true,
      supportsStreaming: false,
    };
  },

  async write(
    records: MappedRecord[],
    context: DestinationContext,
  ): Promise<WriteResult> {
    context.logger.info("Writing batch", { count: records.length });

    // Minimal scaffold: acknowledges all records as written without sending them.
    // Replace with actual HTTP delivery using context.fetch and context.credentials.
    return {
      written: records.length,
      failed: 0,
      errors: [],
    };
  },
};
`;
}

function buildAuthProviderSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import type {
  AuthProvider,
  AuthProviderMetadata,
  AuthOptions,
  CallbackParams,
  AuthContext,
  AuthResult,
  PluginContext,
} from "@oneplatform/plugin-sdk";
import { PluginAuthError } from "@oneplatform/plugin-sdk";

// Stored during initialize() and used by getAuthorizationUrl().
let _clientId: string | undefined;

export const ${entrypoint}: AuthProvider = {
  metadata(): AuthProviderMetadata {
    return {
      type: "auth-provider",
      id: "${escapeJsString(opts.id)}",
      name: "${escapeJsString(opts.name)}",
      description: "A OnePlatform auth provider plugin",
      version: "0.1.0",
      author: "${escapeJsString(opts.author)}",
      configSchema: {
        type: "object",
        required: ["clientId"],
        properties: {
          clientId: { type: "string" },
        },
      },
      protocol: "oauth2",
      supportsTokenValidation: false,
      supportsTokenRefresh: false,
    };
  },

  async initialize(config: Record<string, unknown>, _context: PluginContext): Promise<void> {
    if (typeof config["clientId"] !== "string" || !config["clientId"]) {
      throw new PluginAuthError("Missing required config: clientId — set it in the plugin config");
    }
    _clientId = config["clientId"] as string;
  },

  getAuthorizationUrl(state: string, options: AuthOptions): string {
    if (!_clientId) {
      throw new PluginAuthError("Plugin not initialized — clientId is not set");
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: _clientId,
      state,
      redirect_uri: options.redirectUri,
    });
    return \`https://auth.example.com/oauth/authorize?\${params.toString()}\`;
  },

  async handleCallback(
    params: CallbackParams,
    context: AuthContext,
  ): Promise<AuthResult> {
    if (params.error) {
      throw new PluginAuthError(\`Auth provider returned error: \${params.error}\`);
    }
    if (!params.code) {
      throw new PluginAuthError("Callback is missing authorization code");
    }

    context.logger.info("Handling OAuth callback");

    // Minimal scaffold: exchange params.code for tokens via your provider's token endpoint.
    // The implementation below throws so that the auth flow fails visibly rather than
    // silently returning placeholder tokens that look like valid credentials.
    throw new PluginAuthError(
      "handleCallback is not yet implemented. " +
      "Exchange params.code for access/refresh tokens via your provider's token endpoint.",
    );
  },

  mapClaimsToRoles(claims: Record<string, unknown>): string[] {
    // Minimal scaffold: no role mapping by default.
    // Inspect claims and return matching platform role names as needed.
    void claims;
    return [];
  },
};
`;
}

function buildWidgetSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import type {
  Widget,
  WidgetMetadata,
  WidgetData,
  WidgetSlotDeclaration,
  DataQuery,
} from "@oneplatform/plugin-sdk";

/**
 * Escape HTML special characters to prevent XSS when interpolating user-
 * controlled values (config fields, user IDs, etc.) into HTML markup.
 * Always call this before inserting any string into an HTML context.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export const ${entrypoint}: Widget = {
  metadata(): WidgetMetadata {
    return {
      type: "widget",
      id: "${escapeJsString(opts.id)}",
      name: "${escapeJsString(opts.name)}",
      description: "A OnePlatform widget plugin",
      version: "0.1.0",
      author: "${escapeJsString(opts.author)}",
      configSchema: { type: "object", properties: {} },
      minWidth: 3,
      minHeight: 2,
      slots: [{ slot: "main", defaultWidth: 6, defaultHeight: 4 }],
    };
  },

  render(data: WidgetData): string {
    // Escape all user-controlled values before inserting them into HTML to
    // prevent XSS. Even though the platform applies server-side sanitization,
    // escaping at the source is the correct defence-in-depth pattern.
    const title = escapeHtml(String(data.config["title"] ?? "${escapeJsString(opts.name)}"));
    const userId = escapeHtml(String(data.user.id));
    return \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>\${title}</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 16px; }
    h1 { font-size: 1rem; margin: 0 0 8px; }
  </style>
</head>
<body>
  <h1>\${title}</h1>
  <p>Hello, \${userId}!</p>
</body>
</html>\`;
  },

  declareDataRequirements(): DataQuery[] {
    // Minimal scaffold: no data queries by default.
    // Add DataQuery objects here to request entity data from the platform.
    return [];
  },

  declareSlot(): WidgetSlotDeclaration {
    return { slot: "main", defaultWidth: 6, defaultHeight: 4 };
  },
};
`;
}

function buildTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  const typeTests: Record<PluginType, () => string> = {
    connector: () => buildConnectorTestSource(opts, entrypoint),
    transformer: () => buildTransformerTestSource(opts, entrypoint),
    destination: () => buildDestinationTestSource(opts, entrypoint),
    "auth-provider": () => buildAuthProviderTestSource(opts, entrypoint),
    widget: () => buildWidgetTestSource(opts, entrypoint),
  };
  return typeTests[opts.type]();
}

function buildConnectorTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import { describe, it, expect } from "vitest";
import { createConnectorMockContext } from "@oneplatform/plugin-sdk/testing";
import { ${entrypoint} } from "../index.js";

describe("${entrypoint}", () => {
  it("returns valid connector metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("connector");
    expect(meta.id).toBe("${escapeJsString(opts.id)}");
    expect(meta.supportsIncremental).toBeDefined();
  });

  it("connects successfully with valid config", async () => {
    const ctx = createConnectorMockContext({
      credentials: { apiKey: "test-key" },
    });
    const handle = await ${entrypoint}.connect({ baseUrl: "https://api.example.com" }, ctx);
    expect(handle.connectionId).toBeTruthy();
  });

  it("throws on missing baseUrl", async () => {
    const ctx = createConnectorMockContext({
      credentials: { apiKey: "test-key" },
    });
    await expect(${entrypoint}.connect({}, ctx)).rejects.toThrow("baseUrl");
  });

  it("fetches an empty batch", async () => {
    const ctx = createConnectorMockContext({
      credentials: { apiKey: "test-key" },
    });
    const handle = await ${entrypoint}.connect({ baseUrl: "https://api.example.com" }, ctx);
    const batch = await ${entrypoint}.fetchBatch(handle, null, ctx);
    expect(batch.records).toEqual([]);
    expect(batch.hasMore).toBe(false);
  });

  it("disconnects without error", async () => {
    const ctx = createConnectorMockContext({
      credentials: { apiKey: "test-key" },
    });
    const handle = await ${entrypoint}.connect({ baseUrl: "https://api.example.com" }, ctx);
    await expect(${entrypoint}.disconnect(handle, ctx)).resolves.toBeUndefined();
  });
});
`;
}

function buildTransformerTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import { describe, it, expect } from "vitest";
import { createTransformerMockContext } from "@oneplatform/plugin-sdk/testing";
import { ${entrypoint} } from "../index.js";

describe("${entrypoint}", () => {
  it("returns valid transformer metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("transformer");
    expect(meta.id).toBe("${escapeJsString(opts.id)}");
    expect(meta.idempotent).toBeDefined();
  });

  it("passes a record through unchanged", async () => {
    const ctx = createTransformerMockContext();
    const record = {
      sourceId: "rec-001",
      data: { name: "Test" },
      metadata: { createdAt: new Date().toISOString() },
    };
    const result = await ${entrypoint}.transform(record, ctx);
    expect(result).toEqual(record);
  });

  it("throws on record missing sourceId", async () => {
    const ctx = createTransformerMockContext();
    const record = {
      sourceId: "",
      data: { name: "Test" },
      metadata: {},
    };
    await expect(${entrypoint}.transform(record, ctx)).rejects.toThrow("sourceId");
  });
});
`;
}

function buildDestinationTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import { describe, it, expect } from "vitest";
import { createDestinationMockContext } from "@oneplatform/plugin-sdk/testing";
import { ${entrypoint} } from "../index.js";

describe("${entrypoint}", () => {
  it("returns valid destination metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("destination");
    expect(meta.id).toBe("${escapeJsString(opts.id)}");
    expect(meta.deliveryGuarantee).toBeDefined();
  });

  it("writes an empty batch successfully", async () => {
    const ctx = createDestinationMockContext();
    const result = await ${entrypoint}.write([], ctx);
    expect(result.written).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("writes a batch and reports correct counts", async () => {
    const ctx = createDestinationMockContext();
    const records = [
      { sourceId: "rec-001", entityType: "contact", data: { name: "A" }, operation: "upsert" as const },
      { sourceId: "rec-002", entityType: "contact", data: { name: "B" }, operation: "upsert" as const },
    ];
    const result = await ${entrypoint}.write(records, ctx);
    expect(result.written).toBe(2);
    expect(result.failed).toBe(0);
  });
});
`;
}

function buildAuthProviderTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import { describe, it, expect, beforeEach } from "vitest";
import { createAuthProviderMockContext } from "@oneplatform/plugin-sdk/testing";
import { ${entrypoint} } from "../index.js";

describe("${entrypoint}", () => {
  it("returns valid auth-provider metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("auth-provider");
    expect(meta.id).toBe("${escapeJsString(opts.id)}");
    expect(meta.protocol).toBeDefined();
  });

  it("generates a valid authorization URL", async () => {
    const ctx = createAuthProviderMockContext();
    await ${entrypoint}.initialize!({ clientId: "test-client-id" }, ctx);
    const url = ${entrypoint}.getAuthorizationUrl("test-state", {
      redirectUri: "https://localhost/callback",
    });
    expect(url).toContain("https://auth.example.com");
    expect(url).toContain("test-state");
    expect(url).toContain("test-client-id");
  });

  it("throws on missing clientId during initialize", async () => {
    const ctx = createAuthProviderMockContext();
    await expect(${entrypoint}.initialize!({}, ctx)).rejects.toThrow("clientId");
  });

  it("returns empty role array from mapClaimsToRoles", () => {
    const roles = ${entrypoint}.mapClaimsToRoles({ sub: "user-1" });
    expect(roles).toEqual([]);
  });
});
`;
}

function buildWidgetTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import { describe, it, expect } from "vitest";
import { ${entrypoint} } from "../index.js";

describe("${entrypoint}", () => {
  it("returns valid widget metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("widget");
    expect(meta.id).toBe("${escapeJsString(opts.id)}");
    expect(meta.minWidth).toBeGreaterThan(0);
    expect(meta.minHeight).toBeGreaterThan(0);
  });

  it("renders valid HTML", () => {
    const html = ${entrypoint}.render({
      config: { title: "Test Widget" },
      user: { id: "user-1", roles: ["viewer"] },
      queryResults: {},
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Test Widget");
    expect(html).toContain("user-1");
  });

  it("returns data requirements as an array", () => {
    const queries = ${entrypoint}.declareDataRequirements();
    expect(Array.isArray(queries)).toBe(true);
  });

  it("declares a slot", () => {
    const slot = ${entrypoint}.declareSlot();
    expect(slot.slot).toBe("main");
    expect(slot.defaultWidth).toBeGreaterThan(0);
  });
});
`;
}

function buildPackageJson(opts: ScaffoldOptions): string {
  const pkg = {
    name: opts.id,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "./dist/bundle.js",
    scripts: {
      // esbuild bundles src/index.ts into the single-file dist/bundle.js that
      // the platform loads at runtime. --packages=external keeps @oneplatform/plugin-sdk
      // out of the bundle — the execution environment injects it at runtime.
      build:
        "esbuild src/index.ts --bundle --format=esm --outfile=dist/bundle.js --packages=external",
      "build:types": "tsc --emitDeclarationOnly",
      dev: "esbuild src/index.ts --bundle --format=esm --outfile=dist/bundle.js --packages=external --watch",
      test: "vitest run",
      "test:watch": "vitest",
      // npx ensures the CLI is resolved from the registry without a global install.
      // See README.md for instructions on installing @oneplatform/cli globally.
      pack: "npx @oneplatform/cli plugin pack",
      "type-check": "tsc --noEmit",
    },
    devDependencies: {
      "@oneplatform/plugin-sdk": "*",
      // esbuild is the bundler used by `npm run build` and `npm run dev`.
      esbuild: "^0.21.0",
      typescript: "^5.5.0",
      vitest: "^1.6.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function buildTsConfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      declaration: true,
      outDir: "dist",
      rootDir: "src",
    },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function buildReadme(opts: ScaffoldOptions): string {
  return `# ${opts.name}

A OnePlatform **${opts.type}** plugin scaffolded with \`op plugin create\`.

## Getting started

\`\`\`bash
npm install          # install dependencies
npm run build        # bundle src/index.ts → dist/bundle.js
npm run dev          # watch mode — rebuilds on every save
npm test             # run vitest tests
npm run type-check   # TypeScript type checking (no emit)
\`\`\`

## Packaging and installing

To create a \`.oppkg\` archive for installation:

\`\`\`bash
npm run pack
# or, if @oneplatform/cli is installed globally:
op plugin pack
\`\`\`

### Installing \`@oneplatform/cli\`

The \`npm run pack\` script uses \`npx @oneplatform/cli\` so no global install is required.
For a faster workflow, install the CLI globally:

\`\`\`bash
npm install -g @oneplatform/cli
op plugin pack
op plugin install ./${opts.id}-0.1.0.oppkg --dev
\`\`\`

The \`--dev\` flag installs in development mode — only requires \`plugins:manage\` scope,
scoped to your tenant, and expires after 7 days.

## Plugin ID

\`${opts.id}\`

## Author

${opts.author}
`;
}

function buildGitIgnore(): string {
  return `node_modules/
dist/
*.oppkg
`;
}

// ────────────────────────────────────────────────────────────────────────────
// Main scaffold function
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generate scaffold files for a new plugin.
 * Returns the list of files to be written — the caller handles file I/O.
 * This separation makes the scaffold testable without touching the filesystem.
 */
export function generateScaffold(opts: ScaffoldOptions): ScaffoldResult {
  // Compute once and pass down — avoids divergence between manifest and source file.
  // Use camelCase for generated identifiers so they follow JavaScript convention
  // (named exports like `myConnector` rather than `MyConnector`).
  const entrypoint = toCamelCase(opts.name.replace(/[^a-zA-Z0-9]/g, " "));

  const sourceBuilders: Record<PluginType, (o: ScaffoldOptions, e: string) => string> = {
    connector: buildConnectorSource,
    transformer: buildTransformerSource,
    destination: buildDestinationSource,
    "auth-provider": buildAuthProviderSource,
    widget: buildWidgetSource,
  };

  const buildSource = sourceBuilders[opts.type];

  const files: ScaffoldedFile[] = [
    { relativePath: "package.json", content: buildPackageJson(opts) },
    { relativePath: "tsconfig.json", content: buildTsConfig() },
    { relativePath: "plugin.manifest.json", content: buildManifest(opts, entrypoint) },
    { relativePath: "src/index.ts", content: buildSource(opts, entrypoint) },
    { relativePath: "src/__tests__/index.test.ts", content: buildTestSource(opts, entrypoint) },
    { relativePath: ".gitignore", content: buildGitIgnore() },
    { relativePath: "README.md", content: buildReadme(opts) },
  ];

  return { outputDir: opts.outputDir, files };
}

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

function escapeJsString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function toPascalCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function toCamelCase(input: string): string {
  const pascal = toPascalCase(input);
  if (pascal.length === 0) return pascal;
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
