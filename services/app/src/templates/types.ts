// ---------------------------------------------------------------------------
// Template system types — G-075
//
// Templates are static definitions — no DB rows, no dynamic generation.
// They are rendered once at request time to produce a virtual filesystem
// that exactly mirrors what createApp() seeds via renderDefaultTemplate().
// ---------------------------------------------------------------------------

export type TemplateCategory = "admin" | "dashboard" | "form";

export interface TemplateMeta {
  id:                   string;
  name:                 string;
  description:          string;
  category:             TemplateCategory;
  /** Relative URL to the preview thumbnail served from the platform CDN. */
  thumbnail:            string;
  requiredPermissions:  string[];
}

export interface AppTemplate {
  meta:    TemplateMeta;
  /**
   * Render the virtual filesystem files for this template.
   * Each key is an absolute VFS path (e.g. "/src/App.tsx").
   * appName is interpolated into headings and titles.
   */
  render(appName: string, slug: string): Record<string, string>;
}
