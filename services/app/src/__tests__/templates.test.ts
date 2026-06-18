// Unit tests for services/app/src/templates/
//
// Covers:
//   - Template registry (ALL_TEMPLATES, findTemplateById)
//   - Each template's render() output: required VFS paths, valid file paths,
//     SDK import usage, and size constraints.
//   - CreateAppFromTemplateSchema validation.

import { describe, it, expect } from "vitest";
import {
  ALL_TEMPLATES,
  findTemplateById,
  crudAdminTemplate,
  dashboardTemplate,
  formBuilderTemplate,
} from "../templates/index.js";
import { CreateAppFromTemplateSchema } from "../schemas/index.js";
import { validateFilePath } from "../services/app-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_NAME = "Test App";
const APP_SLUG = "test-app";

/** Every VFS path produced by a template must pass the service-layer validator. */
function assertPathsValid(files: Record<string, string>): void {
  for (const path of Object.keys(files)) {
    // Throws AppFileInvalidPathError on bad paths — the test will fail if it throws
    expect(() => validateFilePath(path)).not.toThrow();
  }
}

/** 1MB = 1_048_576 bytes — mirrors the service-layer check */
function assertFileSizes(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const size = Buffer.byteLength(content, "utf8");
    expect(size, `${path} exceeds 1MB`).toBeLessThanOrEqual(1_048_576);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("Template registry", () => {
  it("exports three templates", () => {
    expect(ALL_TEMPLATES).toHaveLength(3);
  });

  it("all template IDs are unique", () => {
    const ids = ALL_TEMPLATES.map((t) => t.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findTemplateById returns the correct template", () => {
    expect(findTemplateById("crud-admin")?.meta.id).toBe("crud-admin");
    expect(findTemplateById("dashboard")?.meta.id).toBe("dashboard");
    expect(findTemplateById("form-builder")?.meta.id).toBe("form-builder");
  });

  it("findTemplateById returns undefined for unknown ids", () => {
    expect(findTemplateById("")).toBeUndefined();
    expect(findTemplateById("unknown-template")).toBeUndefined();
  });

  it("each template has required metadata fields", () => {
    for (const t of ALL_TEMPLATES) {
      expect(t.meta.id.length).toBeGreaterThan(0);
      expect(t.meta.name.length).toBeGreaterThan(0);
      expect(t.meta.description.length).toBeGreaterThan(0);
      expect(["admin", "dashboard", "form"]).toContain(t.meta.category);
      expect(t.meta.thumbnail).toMatch(/^\/assets\/templates\//);
      expect(Array.isArray(t.meta.requiredPermissions)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// crud-admin template
// ---------------------------------------------------------------------------

describe("crudAdminTemplate", () => {
  const files = crudAdminTemplate.render(APP_NAME, APP_SLUG);

  it("includes required VFS entrypoint /src/index.tsx", () => {
    expect(files["/src/index.tsx"]).toBeDefined();
  });

  it("includes /src/App.tsx", () => {
    expect(files["/src/App.tsx"]).toBeDefined();
  });

  it("includes RecordTable and RecordFormModal components", () => {
    expect(files["/src/components/RecordTable.tsx"]).toBeDefined();
    expect(files["/src/components/RecordFormModal.tsx"]).toBeDefined();
  });

  it("uses @oneplatform/app-sdk hooks", () => {
    const table = files["/src/components/RecordTable.tsx"] ?? "";
    expect(table).toContain("@oneplatform/app-sdk");
    expect(table).toContain("useQuery");
    expect(table).toContain("useMutation");
  });

  it("renders the app name into App.tsx", () => {
    expect(files["/src/App.tsx"]).toContain(APP_NAME);
  });

  it("all paths pass the service-layer validator", () => {
    assertPathsValid(files);
  });

  it("all files are within the 1MB limit", () => {
    assertFileSizes(files);
  });

  it("package.json declares @oneplatform/app-sdk dependency", () => {
    const pkg = JSON.parse(files["/package.json"] ?? "{}") as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe(APP_SLUG);
    expect(pkg.dependencies?.["@oneplatform/app-sdk"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dashboard template
// ---------------------------------------------------------------------------

describe("dashboardTemplate", () => {
  const files = dashboardTemplate.render(APP_NAME, APP_SLUG);

  it("includes required VFS entrypoint /src/index.tsx", () => {
    expect(files["/src/index.tsx"]).toBeDefined();
  });

  it("includes KpiSection and BarChart components", () => {
    expect(files["/src/components/KpiSection.tsx"]).toBeDefined();
    expect(files["/src/components/BarChart.tsx"]).toBeDefined();
  });

  it("uses @oneplatform/app-sdk useQuery", () => {
    const app = files["/src/App.tsx"] ?? "";
    expect(app).toContain("@oneplatform/app-sdk");
    expect(app).toContain("useQuery");
  });

  it("renders the app name into App.tsx", () => {
    expect(files["/src/App.tsx"]).toContain(APP_NAME);
  });

  it("BarChart uses SVG", () => {
    const chart = files["/src/components/BarChart.tsx"] ?? "";
    expect(chart).toContain("<svg");
  });

  it("all paths pass the service-layer validator", () => {
    assertPathsValid(files);
  });

  it("all files are within the 1MB limit", () => {
    assertFileSizes(files);
  });
});

// ---------------------------------------------------------------------------
// form-builder template
// ---------------------------------------------------------------------------

describe("formBuilderTemplate", () => {
  const files = formBuilderTemplate.render(APP_NAME, APP_SLUG);

  it("includes required VFS entrypoint /src/index.tsx", () => {
    expect(files["/src/index.tsx"]).toBeDefined();
  });

  it("includes SubmissionForm component", () => {
    expect(files["/src/components/SubmissionForm.tsx"]).toBeDefined();
  });

  it("includes validation library at /src/lib/validate.ts", () => {
    expect(files["/src/lib/validate.ts"]).toBeDefined();
  });

  it("uses @oneplatform/app-sdk useMutation", () => {
    const form = files["/src/components/SubmissionForm.tsx"] ?? "";
    expect(form).toContain("@oneplatform/app-sdk");
    expect(form).toContain("useMutation");
  });

  it("validate.ts exports validateForm function", () => {
    const validate = files["/src/lib/validate.ts"] ?? "";
    expect(validate).toContain("export function validateForm");
  });

  it("validate.ts enforces required fields and email format", () => {
    const validate = files["/src/lib/validate.ts"] ?? "";
    expect(validate).toContain("fullName");
    expect(validate).toContain("email");
    expect(validate).toContain("message");
    // Email regex present
    expect(validate).toContain("EMAIL_RE");
  });

  it("renders the app name into App.tsx", () => {
    expect(files["/src/App.tsx"]).toContain(APP_NAME);
  });

  it("all paths pass the service-layer validator", () => {
    assertPathsValid(files);
  });

  it("all files are within the 1MB limit", () => {
    assertFileSizes(files);
  });
});

// ---------------------------------------------------------------------------
// CreateAppFromTemplateSchema
// ---------------------------------------------------------------------------

describe("CreateAppFromTemplateSchema — valid", () => {
  it("accepts a minimal valid request", () => {
    const r = CreateAppFromTemplateSchema.safeParse({
      templateId: "crud-admin",
      name:       "My Admin",
      slug:       "my-admin",
    });
    expect(r.success).toBe(true);
  });

  it("defaults accessMode to platform-user", () => {
    const r = CreateAppFromTemplateSchema.parse({
      templateId: "dashboard",
      name:       "Dash",
      slug:       "dash",
    });
    expect(r.accessMode).toBe("platform-user");
  });

  it("accepts optional description", () => {
    const r = CreateAppFromTemplateSchema.safeParse({
      templateId:  "form-builder",
      name:        "Form App",
      slug:        "form-app",
      description: "A contact form.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts accessMode public", () => {
    const r = CreateAppFromTemplateSchema.safeParse({
      templateId: "crud-admin",
      name:       "Public Admin",
      slug:       "public-admin",
      accessMode: "public",
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateAppFromTemplateSchema — invalid", () => {
  it("rejects empty templateId", () => {
    const r = CreateAppFromTemplateSchema.safeParse({ templateId: "", name: "X", slug: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects missing name", () => {
    const r = CreateAppFromTemplateSchema.safeParse({ templateId: "dashboard", slug: "d" });
    expect(r.success).toBe(false);
  });

  it("rejects slug with uppercase letters", () => {
    const r = CreateAppFromTemplateSchema.safeParse({ templateId: "dashboard", name: "D", slug: "My-Slug" });
    expect(r.success).toBe(false);
  });

  it("rejects slug with spaces", () => {
    const r = CreateAppFromTemplateSchema.safeParse({ templateId: "dashboard", name: "D", slug: "my slug" });
    expect(r.success).toBe(false);
  });

  it("rejects description exceeding 512 chars", () => {
    const r = CreateAppFromTemplateSchema.safeParse({
      templateId:  "dashboard",
      name:        "D",
      slug:        "d",
      description: "x".repeat(513),
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown accessMode values", () => {
    const r = CreateAppFromTemplateSchema.safeParse({
      templateId: "dashboard",
      name:       "D",
      slug:       "d",
      accessMode: "private",
    });
    expect(r.success).toBe(false);
  });
});
