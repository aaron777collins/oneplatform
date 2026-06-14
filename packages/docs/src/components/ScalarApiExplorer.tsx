/**
 * Wraps @scalar/api-reference-react to embed an interactive API explorer in
 * Starlight MDX pages. The component is intentionally kept thin — all
 * configuration lives in the parent MDX page so each service page can
 * customise its spec URL without touching this file.
 *
 * Security: the explorer is configured with no credential auto-fill.
 * Users must supply their own Bearer token or API key via the Scalar UI.
 * The component does NOT read from localStorage, sessionStorage, or cookies.
 */
import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

interface ScalarApiExplorerProps {
  /**
   * URL of the OpenAPI JSON spec to load. Can be a relative URL (served by
   * the gateway at /api/v1/openapi/{service}.json) or an absolute URL for
   * local development pointing at a running gateway instance.
   */
  specUrl: string;
  /** Human-readable label shown in the Scalar header. Defaults to "API Reference". */
  title?: string;
}

export default function ScalarApiExplorer({
  specUrl,
  title = "API Reference",
}: ScalarApiExplorerProps) {
  return (
    <div className="scalar-container">
      <ApiReferenceReact
        configuration={{
          spec: { url: specUrl },
          // "default" theme blends with Starlight's light/dark mode handling
          theme: "default",
          layout: "modern",
          darkMode: false,
          showSidebar: true,
          hideDownloadButton: false,
          // Disable any credential persistence — users supply tokens manually
          authentication: {
            preferredSecurityScheme: "",
          },
          _integration: title,
        }}
      />
    </div>
  );
}
