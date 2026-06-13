import type { Logger } from "@oneplatform/core";

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
  register(tenantId: string, appId: string, input: RegisterWidgetInput): Promise<WidgetDescriptor>;
  list(tenantId: string, appId?: string): Promise<WidgetDescriptor[]>;
  unregister(tenantId: string, appId: string, widgetId: string): Promise<void>;
}

export interface WidgetServiceDeps {
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Factory
//
// The widget registry is held in-memory for this implementation. Widgets are
// re-registered on service restart via the deploy event subscriber.
// A persistent store (Redis or Postgres) can replace this map when multi-
// instance deployments require cross-node consistency.
// ---------------------------------------------------------------------------

// TODO: Persist widget registry to Postgres (app.widgets table) so that
// registrations survive service restarts without requiring a full re-deploy
// event from every installed app. Use the existing db pool from deps and
// mirror the register/unregister operations to the DB alongside the in-memory
// map. On startup, seed the in-memory map from the DB. (M-15)
export function createWidgetService(deps: WidgetServiceDeps): WidgetService {
  const { logger } = deps;

  // widgetId → WidgetDescriptor
  const registry = new Map<string, WidgetDescriptor>();

  function register(
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

    registry.set(widgetId, descriptor);
    logger.info("Widget registered", { tenantId, appId, widgetId });

    return Promise.resolve(descriptor);
  }

  function list(tenantId: string, appId?: string): Promise<WidgetDescriptor[]> {
    const widgets = [...registry.values()].filter((w) => {
      if (w.tenantId !== tenantId) return false;
      if (appId !== undefined && w.appId !== appId) return false;
      return true;
    });
    return Promise.resolve(widgets);
  }

  function unregister(tenantId: string, appId: string, widgetId: string): Promise<void> {
    const widget = registry.get(widgetId);
    if (widget !== undefined && widget.tenantId === tenantId && widget.appId === appId) {
      registry.delete(widgetId);
      logger.info("Widget unregistered", { tenantId, appId, widgetId });
    }
    return Promise.resolve();
  }

  return { register, list, unregister };
}
