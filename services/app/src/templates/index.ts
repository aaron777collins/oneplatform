// ---------------------------------------------------------------------------
// Template registry — G-075
//
// All templates are registered here. The routes and template service import
// only from this file so adding a new template is a one-line change.
// ---------------------------------------------------------------------------

export { crudAdminTemplate }  from "./crud-admin.js";
export { dashboardTemplate }  from "./dashboard.js";
export { formBuilderTemplate } from "./form-builder.js";
export type { AppTemplate, TemplateMeta, TemplateCategory } from "./types.js";

import { crudAdminTemplate }  from "./crud-admin.js";
import { dashboardTemplate }  from "./dashboard.js";
import { formBuilderTemplate } from "./form-builder.js";
import type { AppTemplate } from "./types.js";

/**
 * All available templates in display order.
 * Consumers iterate this array — they never hard-code template IDs.
 */
export const ALL_TEMPLATES: ReadonlyArray<AppTemplate> = [
  crudAdminTemplate,
  dashboardTemplate,
  formBuilderTemplate,
];

/**
 * Look up a template by its stable string ID.
 * Returns undefined when the ID is not registered rather than throwing so
 * callers can produce a clean 400 rather than a 500.
 */
export function findTemplateById(id: string): AppTemplate | undefined {
  return ALL_TEMPLATES.find((t) => t.meta.id === id);
}
