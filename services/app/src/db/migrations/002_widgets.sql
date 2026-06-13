-- Widget registry persistence (M-15)
-- Widgets are registered by apps at install/deploy time. Storing them in Postgres
-- ensures the registry survives service restarts without requiring every installed
-- app to re-emit a deploy event.
--
-- widget_id is app-controlled (e.g. "widget:my-app:chart") so it is TEXT, not UUID.
-- The combination (tenant_id, widget_id) is the natural unique key because widget
-- IDs are scoped to an app which is already scoped to a tenant.

CREATE TABLE IF NOT EXISTS app.widgets (
  widget_id   TEXT        NOT NULL,
  app_id      UUID        NOT NULL REFERENCES app.apps(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  entrypoint  TEXT        NOT NULL,
  category    TEXT        NOT NULL CHECK (category IN ('dashboard', 'action', 'sidebar')),
  width       TEXT        NOT NULL CHECK (width IN ('narrow', 'full', 'auto')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, widget_id)
);

-- Fast lookup by tenant when listing all widgets for a tenant
CREATE INDEX IF NOT EXISTS app_widgets_tenant_id_idx
  ON app.widgets (tenant_id);

-- Fast lookup by app when unregistering all widgets for an app on uninstall
CREATE INDEX IF NOT EXISTS app_widgets_app_id_idx
  ON app.widgets (app_id);
