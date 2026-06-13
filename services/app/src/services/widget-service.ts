import type { Logger } from "@oneplatform/core";
import type { WidgetRepository } from "../repositories/widget-repository.js";

// ---------------------------------------------------------------------------
// Widget registry — allows apps to register UI widgets that can be embedded
// in the platform shell (dashboard panels, action buttons, etc.)
// Design spec §1 (App Platform Design — extensibility hooks)
// ---------------------------------------------------------------------------

export interface WidgetDescriptor {
  widgetId:    string;
  appId:       string;
  tenantId:    string;
  name:        string;
  description: string;
  entrypoint:  string;   // path within the app bundle, e.g. "/widgets/Chart.js"
  category:    "dashboard" | "action" | "sidebar";
  width:       "narrow" | "full" | "auto";
  createdAt:   string;
}

export interface RegisterWidgetInput {
  name:        string;
  description: string;
  entrypoint:  string;
  category:    "dashboard" | "action" | "sidebar";
  width:       "narrow" | "full" | "auto";
}

export interface WidgetService {
  // Resolves after the in-memory cache is seeded from the DB. Must be awaited
  // before the HTTP server accepts traffic so that list() returns complete data.
  initialize(): Promise<void>;
  register(tenantId: string, appId: string, input: RegisterWidgetInput): Promise<WidgetDescriptor>;
  list(tenantId: string, appId?: string): Promise<WidgetDescriptor[]>;
  unregister(tenantId: string, appId: string, widgetId: string): Promise<void>;
}

export interface WidgetServiceDeps {
  widgetRepo: WidgetRepository;
  logger:     Logger;
}

// ---------------------------------------------------------------------------
// Factory
//
// The in-memory Map is a read cache for fast O(1) lookups on the hot path.
// All mutations go to Postgres first; the Map is updated only after the DB
// write succeeds, so a failed write never leaves the cache in an inconsistent
// state. On startup, initialize() seeds the cache from the DB so that widget
// registrations survive service restarts (M-15).
// ---------------------------------------------------------------------------

export function createWidgetService(deps: WidgetServiceDeps): WidgetService {
  const { widgetRepo, logger } = deps;

  // widgetId → WidgetDescriptor (read cache)
  const registry = new Map<string, WidgetDescriptor>();

  async function initialize(): Promise<void> {
    const widgets = await widgetRepo.findAll();
    for (const widget of widgets) {
      registry.set(widget.widgetId, widget);
    }
    logger.info("Widget registry seeded from DB", { count: widgets.length });
  }

  async function register(
    tenantId: string,
    appId: string,
    input: RegisterWidgetInput
  ): Promise<WidgetDescriptor> {
    const widgetId = `widget:${appId}:${input.name.toLowerCase().replace(/\s+/g, "-")}`;

    const descriptor: WidgetDescriptor = {
      widgetId,
      appId,
      tenantId,
      name:        input.name,
      description: input.description,
      entrypoint:  input.entrypoint,
      category:    input.category,
      width:       input.width,
      createdAt:   new Date().toISOString(),
    };

    // Persist first — update cache only after the write succeeds so we never
    // serve stale data from a Map that is ahead of the DB.
    const persisted = await widgetRepo.upsert(descriptor);
    registry.set(widgetId, persisted);

    logger.info("Widget registered", { tenantId, appId, widgetId });
    return persisted;
  }

  function list(tenantId: string, appId?: string): Promise<WidgetDescriptor[]> {
    const widgets = [...registry.values()].filter((w) => {
      if (w.tenantId !== tenantId) return false;
      if (appId !== undefined && w.appId !== appId) return false;
      return true;
    });
    return Promise.resolve(widgets);
  }

  async function unregister(tenantId: string, appId: string, widgetId: string): Promise<void> {
    const widget = registry.get(widgetId);

    // Guard against cross-tenant or cross-app deletions — same checks as before,
    // enforced before the DB delete so we never issue a spurious DELETE.
    if (widget === undefined || widget.tenantId !== tenantId || widget.appId !== appId) {
      return;
    }

    await widgetRepo.delete(tenantId, widgetId);
    registry.delete(widgetId);

    logger.info("Widget unregistered", { tenantId, appId, widgetId });
  }

  return { initialize, register, list, unregister };
}
