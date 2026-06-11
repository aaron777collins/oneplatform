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

function buildManifest(opts: ScaffoldOptions): string {
  const entrypoint = toPascalCase(opts.name.replace(/[^a-zA-Z0-9]/g, " "));

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
      id: "${opts.id}",
      name: "${opts.name}",
      description: "A OnePlatform connector plugin",
      version: "0.1.0",
      author: "${opts.author}",
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

    const apiKey = await context.credentials.get("apiKey");
    void apiKey; // TODO: use apiKey in actual requests

    return {
      connectionId: \`conn-\${Date.now()}\`,
      metadata: { baseUrl },
    };
  },

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | undefined,
    context: PluginContext,
  ): Promise<BatchResult> {
    const offset = cursor ? parseInt(cursor, 10) : 0;
    context.logger.info("Fetching batch", { offset });

    // TODO: implement actual API call using handle.metadata.baseUrl

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
      id: "${opts.id}",
      name: "${opts.name}",
      description: "A OnePlatform transformer plugin",
      version: "0.1.0",
      author: "${opts.author}",
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

    // TODO: implement actual transformation
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
      id: "${opts.id}",
      name: "${opts.name}",
      description: "A OnePlatform destination plugin",
      version: "0.1.0",
      author: "${opts.author}",
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

    // TODO: implement actual write logic

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
} from "@oneplatform/plugin-sdk";
import { PluginAuthError } from "@oneplatform/plugin-sdk";

export const ${entrypoint}: AuthProvider = {
  metadata(): AuthProviderMetadata {
    return {
      type: "auth-provider",
      id: "${opts.id}",
      name: "${opts.name}",
      description: "A OnePlatform auth provider plugin",
      version: "0.1.0",
      author: "${opts.author}",
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

  getAuthorizationUrl(state: string, options: AuthOptions): string {
    const params = new URLSearchParams({
      response_type: "code",
      state,
      redirect_uri: options.redirectUri,
      // TODO: add client_id from config
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

    context.logger.info("Handling OAuth callback");

    // TODO: exchange params.code for tokens

    return {
      accessToken: "TODO",
      claims: {},
      platformRoles: [],
      providerUserId: "TODO",
    };
  },

  mapClaimsToRoles(claims: Record<string, unknown>): string[] {
    // TODO: map provider claims to platform role names
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

export const ${entrypoint}: Widget = {
  metadata(): WidgetMetadata {
    return {
      type: "widget",
      id: "${opts.id}",
      name: "${opts.name}",
      description: "A OnePlatform widget plugin",
      version: "0.1.0",
      author: "${opts.author}",
      configSchema: { type: "object", properties: {} },
      minWidth: 3,
      minHeight: 2,
      slots: [{ slot: "main", defaultWidth: 6, defaultHeight: 4 }],
    };
  },

  render(data: WidgetData): string {
    const title = String(data.config["title"] ?? "${opts.name}");
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
  <p>Hello, \${data.user.id}!</p>
</body>
</html>\`;
  },

  declareDataRequirements(): DataQuery[] {
    // TODO: declare entity queries this widget needs
    return [];
  },

  declareSlot(): WidgetSlotDeclaration {
    return { slot: "main", defaultWidth: 6, defaultHeight: 4 };
  },
};
`;
}

function buildTestSource(opts: ScaffoldOptions, entrypoint: string): string {
  return `import { describe, it, expect } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import { ${entrypoint} } from "../index.js";

describe("${entrypoint}", () => {
  it("returns valid metadata", () => {
    const meta = ${entrypoint}.metadata();
    expect(meta.type).toBe("${opts.type}");
    expect(meta.id).toBe("${opts.id}");
  });

  it("has all required methods", () => {
    expect(typeof ${entrypoint}.metadata).toBe("function");
  });

  it("creates a mock context without errors", () => {
    const ctx = createMockContext({ config: {} });
    expect(ctx.tenant.tenantId).toBe("test-tenant");
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
      build: "tsc --project tsconfig.json",
      dev: "tsc --project tsconfig.json --watch",
      test: "vitest run",
      "test:watch": "vitest",
      pack: "op plugin pack",
    },
    devDependencies: {
      "@oneplatform/plugin-sdk": "*",
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
  const entrypoint = toPascalCase(opts.name.replace(/[^a-zA-Z0-9]/g, " "));

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
    { relativePath: "plugin.manifest.json", content: buildManifest(opts) },
    { relativePath: "src/index.ts", content: buildSource(opts, entrypoint) },
    { relativePath: "src/__tests__/index.test.ts", content: buildTestSource(opts, entrypoint) },
    { relativePath: ".gitignore", content: buildGitIgnore() },
  ];

  return { outputDir: opts.outputDir, files };
}

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

function toPascalCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}
