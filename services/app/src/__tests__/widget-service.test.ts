// Unit tests for services/widget-service.ts
//
// Covers register, list, and unregister for the persisted widget registry.
// Each describe block uses a fresh service instance (no shared state).
// The WidgetRepository is stubbed with an in-memory implementation so tests
// remain fast and hermetic — no real Postgres connection required.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWidgetService,
  type WidgetService,
  type WidgetServiceDeps,
  type WidgetDescriptor,
  type RegisterWidgetInput,
} from "../services/widget-service.js";
import type { WidgetRepository } from "../repositories/widget-repository.js";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// Minimal in-memory stub for WidgetRepository. Mirrors the real interface so
// tests exercise the service logic without hitting a database.
function makeWidgetRepo(seed: WidgetDescriptor[] = []): WidgetRepository {
  const store = new Map<string, WidgetDescriptor>(seed.map((w) => [w.widgetId, w]));

  return {
    upsert: vi.fn(async (descriptor: WidgetDescriptor) => {
      store.set(descriptor.widgetId, descriptor);
      return descriptor;
    }),
    findAll: vi.fn(async () => [...store.values()]),
    delete: vi.fn(async (_tenantId: string, widgetId: string) => {
      store.delete(widgetId);
    }),
  } as unknown as WidgetRepository;
}

function makeDeps(overrides?: Partial<WidgetServiceDeps>): WidgetServiceDeps {
  return {
    widgetRepo: overrides?.widgetRepo ?? makeWidgetRepo(),
    logger:     overrides?.logger ?? makeLogger(),
  };
}

function makeWidgetInput(overrides?: Partial<RegisterWidgetInput>): RegisterWidgetInput {
  return {
    name:        "Sales Chart",
    description: "A chart widget",
    entrypoint:  "/widgets/SalesChart.js",
    category:    "dashboard",
    width:       "full",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe("register", () => {
  let logger:  Logger;
  let service: WidgetService;

  beforeEach(async () => {
    logger  = makeLogger();
    service = createWidgetService(makeDeps({ logger }));
    await service.initialize();
  });

  it("returns a WidgetDescriptor with the correct shape", async () => {
    const input = makeWidgetInput();
    const result = await service.register("tenant-001", "app-001", input);

    expect(result).toHaveProperty("widgetId");
    expect(result).toHaveProperty("appId", "app-001");
    expect(result).toHaveProperty("tenantId", "tenant-001");
    expect(result).toHaveProperty("name", "Sales Chart");
    expect(result).toHaveProperty("description", "A chart widget");
    expect(result).toHaveProperty("entrypoint", "/widgets/SalesChart.js");
    expect(result).toHaveProperty("category", "dashboard");
    expect(result).toHaveProperty("width", "full");
    expect(result).toHaveProperty("createdAt");
  });

  it("generates widgetId from appId and name (lowercased + hyphenated)", async () => {
    const result = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget" }));
    expect(result.widgetId).toBe("widget:app-001:my-widget");
  });

  it("collapses multiple spaces in name to a single hyphen per run (regex replaces entire match)", async () => {
    // The regex /\s+/g replaces each run of whitespace with one hyphen,
    // so "My   Widget" becomes "my-widget" (one hyphen for the 3-space run).
    const result = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My   Widget" }));
    expect(result.widgetId).toBe("widget:app-001:my-widget");
  });

  it("createdAt is a valid ISO 8601 string", async () => {
    const result = await service.register("tenant-001", "app-001", makeWidgetInput());
    expect(() => new Date(result.createdAt)).not.toThrow();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });

  it("logs info when widget is registered", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput());

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "Widget registered",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });

  it("overwrites an existing widget when registered with the same derived widgetId", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget", entrypoint: "/v1/Widget.js" }));
    const result2 = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget", entrypoint: "/v2/Widget.js" }));

    expect(result2.entrypoint).toBe("/v2/Widget.js");
    const listed = await service.list("tenant-001", "app-001");
    expect(listed).toHaveLength(1);
  });

  it("accepts all three category values", async () => {
    const categories: RegisterWidgetInput["category"][] = ["dashboard", "action", "sidebar"];
    for (const category of categories) {
      const result = await service.register("tenant-001", "app-001", makeWidgetInput({ name: category, category }));
      expect(result.category).toBe(category);
    }
  });

  it("accepts all three width values", async () => {
    const widths: RegisterWidgetInput["width"][] = ["narrow", "full", "auto"];
    for (const width of widths) {
      const result = await service.register("tenant-001", "app-001", makeWidgetInput({ name: `widget-${width}`, width }));
      expect(result.width).toBe(width);
    }
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  let service: WidgetService;

  beforeEach(async () => {
    service = createWidgetService(makeDeps());
    await service.initialize();
  });

  it("returns empty array when no widgets are registered", async () => {
    const result = await service.list("tenant-001");
    expect(result).toHaveLength(0);
  });

  it("returns all widgets for a tenant when appId is not filtered", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget A" }));
    await service.register("tenant-001", "app-002", makeWidgetInput({ name: "Widget B" }));

    const result = await service.list("tenant-001");
    expect(result).toHaveLength(2);
  });

  it("filters by appId when provided", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget A" }));
    await service.register("tenant-001", "app-002", makeWidgetInput({ name: "Widget B" }));

    const result = await service.list("tenant-001", "app-001");
    expect(result).toHaveLength(1);
    expect(result[0]?.appId).toBe("app-001");
  });

  it("does not include widgets from other tenants", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "T1 Widget" }));
    await service.register("tenant-002", "app-001", makeWidgetInput({ name: "T2 Widget" }));

    const result = await service.list("tenant-001");
    expect(result).toHaveLength(1);
    expect(result[0]?.tenantId).toBe("tenant-001");
  });

  it("returns empty array when no widgets match the appId filter", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget A" }));

    const result = await service.list("tenant-001", "app-999");
    expect(result).toHaveLength(0);
  });

  it("returns multiple widgets for the same app", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Chart Widget", category: "dashboard" }));
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Export Button", category: "action" }));

    const result = await service.list("tenant-001", "app-001");
    expect(result).toHaveLength(2);
  });

  it("returns all widgets from multiple tenants when different tenant IDs used", async () => {
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget 1" }));
    await service.register("tenant-002", "app-001", makeWidgetInput({ name: "Widget 2" }));

    const t1Result = await service.list("tenant-001");
    const t2Result = await service.list("tenant-002");
    expect(t1Result).toHaveLength(1);
    expect(t2Result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe("unregister", () => {
  let logger:  Logger;
  let service: WidgetService;

  beforeEach(async () => {
    logger  = makeLogger();
    service = createWidgetService(makeDeps({ logger }));
    await service.initialize();
  });

  it("removes the widget from the registry", async () => {
    const descriptor = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget" }));
    await service.unregister("tenant-001", "app-001", descriptor.widgetId);

    const remaining = await service.list("tenant-001", "app-001");
    expect(remaining).toHaveLength(0);
  });

  it("does nothing when widgetId does not exist", async () => {
    await expect(
      service.unregister("tenant-001", "app-001", "widget:nonexistent"),
    ).resolves.not.toThrow();
  });

  it("does not remove widget when tenantId does not match", async () => {
    const descriptor = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget" }));
    await service.unregister("tenant-attacker", "app-001", descriptor.widgetId);

    const remaining = await service.list("tenant-001", "app-001");
    expect(remaining).toHaveLength(1);
  });

  it("does not remove widget when appId does not match", async () => {
    const descriptor = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget" }));
    await service.unregister("tenant-001", "app-other", descriptor.widgetId);

    const remaining = await service.list("tenant-001", "app-001");
    expect(remaining).toHaveLength(1);
  });

  it("logs info when widget is unregistered", async () => {
    const descriptor = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "My Widget" }));

    // Reset logger call count before the unregister call
    (logger.info as ReturnType<typeof vi.fn>).mockClear();

    await service.unregister("tenant-001", "app-001", descriptor.widgetId);

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "Widget unregistered",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001", widgetId: descriptor.widgetId }),
    );
  });

  it("does not log when widgetId not found (silently ignored)", async () => {
    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    logInfo.mockClear();

    await service.unregister("tenant-001", "app-001", "widget:does-not-exist");

    expect(logInfo).not.toHaveBeenCalledWith("Widget unregistered", expect.anything());
  });

  it("only removes the specified widget, leaving others intact", async () => {
    const w1 = await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget One" }));
    await service.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget Two" }));

    await service.unregister("tenant-001", "app-001", w1.widgetId);

    const remaining = await service.list("tenant-001", "app-001");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe("Widget Two");
  });
});

// ---------------------------------------------------------------------------
// In-memory isolation — each service instance has independent state
// ---------------------------------------------------------------------------

describe("in-memory registry isolation", () => {
  it("two service instances do not share registry state", async () => {
    const svc1 = createWidgetService(makeDeps());
    const svc2 = createWidgetService(makeDeps());

    await svc1.initialize();
    await svc2.initialize();

    await svc1.register("tenant-001", "app-001", makeWidgetInput({ name: "Widget" }));

    const svc2Result = await svc2.list("tenant-001");
    expect(svc2Result).toHaveLength(0);
  });
});
