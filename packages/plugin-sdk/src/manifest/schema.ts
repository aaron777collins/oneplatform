/**
 * Zod schema for plugin.manifest.json.
 *
 * Exported at @oneplatform/plugin-sdk/manifest. Imported by:
 * - @oneplatform/cli (op plugin pack, op plugin validate)
 * - Plugin Service (install-time validation)
 *
 * Plugin source code must NEVER import from this path — it would pull Zod
 * into the plugin bundle. This path is only for build tooling and platform services.
 */

import { z } from "zod";

const JSONSchemaZ = z.record(z.unknown());

const HookDeclarationZ = z.object({
  stage: z.string().regex(
    /^(before|after):\w[\w.]*(?::\w+)?$/,
    "Stage must be 'before:{name}' or 'after:{name}', e.g. 'before:ingestion.receive'",
  ),
  criticality: z.enum(["critical", "advisory"]),
  priority: z.number().int().min(0).max(999).default(100),
  timeout: z.number().int().min(1).max(300).optional(),
  entrypoint: z.string().min(1),
});

const RequiredCredentialZ = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  type: z.enum(["secret", "password", "token", "certificate"]),
  required: z.boolean(),
});

export const PluginManifestSchema = z.object({
  manifestVersion: z.literal("1"),

  id: z
    .string()
    .min(3)
    .max(200)
    // Requires at least three dot-separated segments (e.g. com.example.plugin).
    // Each segment may be a single character, fixing rejection of e.g. com.x.plugin.
    .regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$/, {
      message: "id must be reverse-domain format with at least three segments, e.g. com.example.my-plugin",
    }),

  name: z.string().min(2).max(100),

  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.+-]+)?(\+[a-zA-Z0-9.+]+)?$/, {
      message: "version must be SemVer, e.g. 1.2.3 or 1.0.0-beta.1",
    }),

  type: z.enum(["connector", "transformer", "destination", "auth-provider", "widget"]),

  // 500 aligns with BaseMetadata's description limit in types/metadata.ts.
  // min(10) enforces a minimum meaningful description — scaffold generates >10 chars.
  description: z
    .string()
    .min(10, { message: "description must be at least 10 characters" })
    .max(500),

  author: z.string().min(1).max(200),

  supportUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),

  icon: z
    .string()
    .refine(
      (v) =>
        v.startsWith("https://") ||
        v.startsWith("data:image/png;base64,") ||
        v.startsWith("data:image/svg+xml;base64,"),
      { message: "icon must be an https URL or a PNG/SVG data URI" },
    )
    .optional(),

  minPlatformVersion: z.string().regex(/^\d+\.\d+\.\d+$/, {
    message: "minPlatformVersion must be a simple x.y.z SemVer",
  }),

  entrypoint: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
    message: "entrypoint must be a valid JavaScript identifier",
  }),

  configSchema: JSONSchemaZ,

  hooks: z.array(HookDeclarationZ).default([]),

  requiredExternalUrls: z
    .array(
      z
        .string()
        .refine((u) => u.startsWith("https://"), {
          message: "requiredExternalUrls entries must use https://",
        }),
    )
    .default([]),

  requiredApis: z
    .array(z.enum(["credentials", "fetch", "cache", "ontology", "tracing"]))
    .default([]),

  requiredCredentials: z.array(RequiredCredentialZ).default([]),

  bundleChecksum: z.string().regex(/^[a-f0-9]{64}$/, {
    message: "bundleChecksum must be a 64-character lowercase hex SHA-256",
  }),

  gpgFingerprint: z
    .string()
    .regex(/^[A-F0-9]{40}$/, {
      message: "gpgFingerprint must be a 40-character uppercase hex fingerprint",
    })
    .optional(),

  tags: z.array(z.string().min(1).max(50)).max(20).optional(),

  license: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9\-.+]+$/, {
      message: "license must be an SPDX identifier, e.g. MIT or Apache-2.0",
    }),

  changelog: z.string().max(5000).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Structured error format produced when manifest validation fails.
 * The CLI and Plugin Service both produce this shape on validation failure.
 */
export interface ManifestValidationError {
  valid: false;
  errors: Array<{
    path: string; // Dot-separated path, e.g., "hooks[0].entrypoint"
    message: string; // Human-readable validation message
    received?: unknown; // The value that failed validation (omitted for security)
  }>;
}

/**
 * Validate a raw object against the plugin manifest schema.
 * Returns a structured error list on failure rather than throwing.
 */
export function validateManifest(
  raw: unknown,
): { valid: true; manifest: PluginManifest } | ManifestValidationError {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, manifest: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    // Convert Zod's path array to a dot/bracket notation string
    const path = issue.path
      .map((segment, i) =>
        typeof segment === "number" ? `[${segment}]` : i === 0 ? segment : `.${segment}`,
      )
      .join("");

    return {
      path: path || "(root)",
      message: issue.message,
    };
  });

  return { valid: false, errors };
}
