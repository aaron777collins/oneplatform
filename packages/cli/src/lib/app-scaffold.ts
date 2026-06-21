/**
 * App scaffold generator for `op app init`.
 *
 * Templates are embedded as string constants (not read from disk) so the scaffold
 * works correctly from a compiled binary where no template files exist on the
 * filesystem. This follows the same pattern as packages/plugin-sdk/src/dev/scaffold.ts.
 *
 * The generated project is a Vite + React app that imports from @oneplatform/app-sdk.
 * AppProvider is wrapped around the root component so that useQuery and other SDK
 * hooks are available to child components out of the box.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AppScaffoldOptions {
  /** Display name shown in the platform UI and in package.json. */
  name: string;
  /** URL-safe slug — kebab-case, used as the package name and manifest slug. */
  slug: string;
  /** Absolute or relative path where scaffold files will be written. */
  outputDir: string;
}

export interface ScaffoldedFile {
  relativePath: string;
  content: string;
}

export interface AppScaffoldResult {
  outputDir: string;
  files: ScaffoldedFile[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Template builders ────────────────────────────────────────────────────────

function buildPackageJson(opts: AppScaffoldOptions): string {
  const pkg = {
    name: opts.slug,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview",
      "type-check": "tsc --noEmit",
    },
    dependencies: {
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "@oneplatform/app-sdk": "*",
    },
    devDependencies: {
      typescript: "^5.5.0",
      vite: "^5.4.0",
      "@vitejs/plugin-react": "^4.3.0",
      "@types/react": "^18.3.0",
      "@types/react-dom": "^18.3.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function buildViteConfig(): string {
  // @oneplatform/app-sdk is externalized — the platform injects it at runtime
  // through the app shell. Bundling it would cause version mismatches and
  // bloat the bundle unnecessarily.
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/index.tsx",
      formats: ["es"],
      fileName: "bundle",
    },
    rollupOptions: {
      // Keep @oneplatform/app-sdk external — the platform shell provides it.
      external: ["react", "react-dom", "@oneplatform/app-sdk"],
    },
    outDir: "dist",
  },
});
`;
}

function buildTsConfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
    },
    include: ["src"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function buildIndexHtml(opts: AppScaffoldOptions): string {
  const safeName = escapeHtml(opts.name);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeName}</title>
  </head>
  <body>
    <div id="root"></div>
    <!--
      The platform app shell injects window.__OP_APP_CONFIG__ before this script.
      Do not remove the module type — the bundle is an ES module.
    -->
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
`;
}

function buildAppTsx(opts: AppScaffoldOptions): string {
  const safeName = escapeHtml(opts.name);
  return `import { AppProvider, useQuery } from "@oneplatform/app-sdk";

// Replace "example" with the slug of an entity type from your ontology.
// Run \`op sdk generate-types\` to get TypeScript types for your entities.
function ExampleList() {
  const { data, isLoading, error } = useQuery("example", { limit: 20 });

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <ul>
      {data?.map((item) => (
        <li key={String(item["id"])}>{JSON.stringify(item)}</li>
      ))}
    </ul>
  );
}

export default function App() {
  return (
    <AppProvider loadingFallback={<p>Initialising ${safeName}…</p>}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1rem" }}>
        <h1>${safeName}</h1>
        <ExampleList />
      </main>
    </AppProvider>
  );
}
`;
}

function buildIndexTsx(): string {
  return `import { createRoot } from "react-dom/client";
import App from "./App.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found in index.html");

createRoot(rootEl).render(<App />);
`;
}

function buildManifest(opts: AppScaffoldOptions): string {
  const manifest = {
    name: opts.name,
    slug: opts.slug,
    version: "0.1.0",
    entrypoint: "dist/bundle.js",
    description: `A OnePlatform app — ${opts.name}`,
    minPlatformVersion: "1.0.0",
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

function buildGitIgnore(): string {
  return `node_modules/
dist/
*.tgz
.env
.env.local
`;
}

// ─── Main scaffold function ───────────────────────────────────────────────────

/**
 * Generate scaffold files for a new OnePlatform app project.
 *
 * Returns the list of files to be written — the caller handles file I/O.
 * This separation keeps the scaffold testable without touching the filesystem.
 */
export function generateAppScaffold(opts: AppScaffoldOptions): AppScaffoldResult {
  const files: ScaffoldedFile[] = [
    { relativePath: "package.json", content: buildPackageJson(opts) },
    { relativePath: "vite.config.ts", content: buildViteConfig() },
    { relativePath: "tsconfig.json", content: buildTsConfig() },
    { relativePath: "index.html", content: buildIndexHtml(opts) },
    { relativePath: "app.manifest.json", content: buildManifest(opts) },
    { relativePath: "src/App.tsx", content: buildAppTsx(opts) },
    { relativePath: "src/index.tsx", content: buildIndexTsx() },
    { relativePath: ".gitignore", content: buildGitIgnore() },
  ];

  return { outputDir: opts.outputDir, files };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Converts an arbitrary display name into a kebab-case URL slug.
 * e.g. "My Cool App" → "my-cool-app"
 */
export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
