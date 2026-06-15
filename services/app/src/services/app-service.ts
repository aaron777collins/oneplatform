import { createHash } from "node:crypto";
import type { Logger } from "@oneplatform/core";
import type { AppRepository } from "../repositories/app-repository.js";
import type { VersionRepository } from "../repositories/version-repository.js";
import type { AppRow } from "../repositories/types.js";
import {
  AppNotFoundError,
  AppSlugConflictError,
  AppFileInvalidPathError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Default VFS template — seeded on every new app creation
// Design spec §4.3
// ---------------------------------------------------------------------------

function renderDefaultTemplate(appName: string, slug: string): Record<string, string> {
  return {
    "/package.json": JSON.stringify(
      {
        name: slug,
        version: "0.1.0",
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
          "@oneplatform/app-sdk": "^1.0.0",
        },
      },
      null,
      2
    ),
    "/tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
        include: ["src"],
      },
      null,
      2
    ),
    "/src/index.tsx": [
      `import React from "react";`,
      `import { createRoot } from "react-dom/client";`,
      `import { AppProvider } from "@oneplatform/app-sdk";`,
      `import { App } from "./App.js";`,
      ``,
      `const container = document.getElementById("app");`,
      `if (!container) throw new Error("Root element #app not found");`,
      ``,
      `createRoot(container).render(`,
      `  <AppProvider>`,
      `    <App />`,
      `  </AppProvider>`,
      `);`,
    ].join("\n"),
    "/src/App.tsx": [
      `import React from "react";`,
      `import { useUser } from "@oneplatform/app-sdk";`,
      ``,
      `export function App() {`,
      `  const user = useUser();`,
      ``,
      `  return (`,
      `    <div>`,
      `      <h1>${appName}</h1>`,
      `      <p>Hello, {user.displayName}!</p>`,
      `    </div>`,
      `  );`,
      `}`,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Path validation — enforced before any DB write
// Design spec §4.2
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = new Set([
  // Code
  ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".html", ".md",
  // Images
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  // Fonts
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  // Config & data
  ".yaml", ".yml", ".env.example", ".graphql", ".gql", ".xml", ".txt", ".csv",
  // Source maps
  ".map",
]);

export function validateFilePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new AppFileInvalidPathError("File path must start with /");
  }
  if (path.includes("..")) {
    throw new AppFileInvalidPathError("File path must not contain .. segments");
  }
  if (path.length > 512) {
    throw new AppFileInvalidPathError("File path must not exceed 512 characters");
  }
  // No null bytes or non-printable ASCII
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new AppFileInvalidPathError("File path must contain only printable ASCII characters");
  }
  const ext = path.slice(path.lastIndexOf("."));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppFileInvalidPathError(
      `File extension "${ext}" is not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`
    );
  }
}

export function sha256hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface AppService {
  createApp(tenantId: string, userId: string, input: CreateAppInput): Promise<AppRow>;
  getApp(tenantId: string, id: string): Promise<AppRow>;
  listApps(tenantId: string, options?: ListAppsOptions): Promise<{ apps: AppRow[]; nextCursor: string | null; total: number }>;
  updateApp(tenantId: string, id: string, input: UpdateAppInput): Promise<AppRow>;
  deleteApp(tenantId: string, id: string): Promise<void>;
}

export interface CreateAppInput {
  name:        string;
  slug:        string;
  description?: string;
  accessMode:  "platform-user" | "public";
}

export interface UpdateAppInput {
  name?:           string;
  slug?:           string;
  description?:    string | null;
  accessMode?:     "platform-user" | "public";
  allowedModules?: string[];
}

export interface ListAppsOptions {
  cursor?: string;
  limit?:  number;
}

export interface AppServiceDeps {
  appRepo:     AppRepository;
  fileRepo:    VersionRepository;
  logger:      Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppService(deps: AppServiceDeps): AppService {
  const { appRepo, fileRepo, logger } = deps;

  async function createApp(
    tenantId: string,
    userId: string,
    input: CreateAppInput
  ): Promise<AppRow> {
    // Slug conflict check: per-tenant for platform-user, global for public
    if (input.accessMode === "public") {
      const existing = await appRepo.findPublicBySlug(input.slug);
      if (existing !== null) {
        throw new AppSlugConflictError(
          `Slug "${input.slug}" is already in use by a public app.`
        );
      }
    } else {
      const existing = await appRepo.findByTenantAndSlug(tenantId, input.slug);
      if (existing !== null) {
        throw new AppSlugConflictError(
          `Slug "${input.slug}" is already in use within this tenant.`
        );
      }
    }

    const app = await appRepo.create({
      tenant_id:   tenantId,
      name:        input.name,
      slug:        input.slug,
      access_mode: input.accessMode,
      created_by:  userId,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });

    // Seed default template files into VFS
    const template = renderDefaultTemplate(input.name, input.slug);
    await Promise.all(
      Object.entries(template).map(([path, content]) =>
        fileRepo.create({
          app_id:       app.id,
          path,
          content,
          content_hash: sha256hex(content),
          updated_by:   userId,
        })
      )
    );

    logger.info("App created with default template", {
      tenantId,
      appId: app.id,
      slug: app.slug,
      accessMode: app.access_mode,
    });

    return app;
  }

  async function getApp(tenantId: string, id: string): Promise<AppRow> {
    const app = await appRepo.findByTenantAndId(tenantId, id);
    if (app === null) {
      throw new AppNotFoundError(`App "${id}" not found.`, { appId: id, tenantId });
    }
    return app;
  }

  async function listApps(
    tenantId: string,
    options?: ListAppsOptions
  ): Promise<{ apps: AppRow[]; nextCursor: string | null; total: number }> {
    const limit = options?.limit ?? 50;
    const [apps, total] = await Promise.all([
      appRepo.findByTenantId(tenantId, {
        ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
        limit,
      }),
      appRepo.countByTenantId(tenantId),
    ]);

    const nextCursor = apps.length === limit ? (apps[apps.length - 1]?.id ?? null) : null;

    return { apps, nextCursor, total };
  }

  async function updateApp(
    tenantId: string,
    id: string,
    input: UpdateAppInput
  ): Promise<AppRow> {
    // Verify ownership
    const existing = await getApp(tenantId, id);

    // Slug conflict check if slug is changing
    if (input.slug !== undefined && input.slug !== existing.slug) {
      const targetMode = input.accessMode ?? existing.access_mode;
      if (targetMode === "public") {
        const conflict = await appRepo.findPublicBySlug(input.slug);
        if (conflict !== null && conflict.id !== id) {
          throw new AppSlugConflictError(
            `Slug "${input.slug}" is already in use by a public app.`
          );
        }
      } else {
        const conflict = await appRepo.findByTenantAndSlug(tenantId, input.slug);
        if (conflict !== null && conflict.id !== id) {
          throw new AppSlugConflictError(
            `Slug "${input.slug}" is already in use within this tenant.`
          );
        }
      }
    }

    const updateData: {
      name?: string;
      slug?: string;
      description?: string | null;
      access_mode?: "platform-user" | "public";
      allowed_modules?: string[];
    } = {};

    if (input.name !== undefined) updateData.name = input.name;
    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.accessMode !== undefined) updateData.access_mode = input.accessMode;
    if (input.allowedModules !== undefined) updateData.allowed_modules = input.allowedModules;

    const updated = await appRepo.update(id, updateData);
    if (updated === null) {
      throw new AppNotFoundError(`App "${id}" not found.`, { appId: id, tenantId });
    }

    logger.info("App updated", { tenantId, appId: id });
    return updated;
  }

  async function deleteApp(tenantId: string, id: string): Promise<void> {
    // Verify ownership before soft-delete
    await getApp(tenantId, id);

    await appRepo.softDelete(id);
    logger.info("App soft-deleted", { tenantId, appId: id });
  }

  return { createApp, getApp, listApps, updateApp, deleteApp };
}
