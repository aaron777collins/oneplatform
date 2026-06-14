// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Compute paths relative to this config file rather than the process cwd.
// packages/docs/astro.config.mjs is two levels below the repo root, so
// "../../docs" resolves to the repo-level docs/ directory regardless of
// where pnpm is invoked from.
const repoDocsDir = fileURLToPath(new URL("../../docs", import.meta.url));
const generatedDir = resolve(repoDocsDir, "generated");
const decisionsDir = resolve(repoDocsDir, "decisions");
const designsDir = resolve(repoDocsDir, "designs");

export default defineConfig({
  output: "static",
  // Use legacy content collections for Astro 5 compatibility with Starlight's
  // docsLoader(). This avoids issues with the new Content Layer API in monorepo
  // setups where the data store isn't populated correctly during the build.
  legacy: {
    collections: true,
  },
  integrations: [
    react(),
    starlight({
      title: "OnePlatform Docs",
      logo: {
        src: "./src/assets/logo.svg",
      },
      social: {
        github: "https://github.com/yourorg/oneplatform",
      },
      sidebar: [
        {
          label: "Getting Started",
          autogenerate: { directory: "getting-started" },
        },
        {
          label: "API Reference",
          items: [
            { label: "Overview", link: "/api/" },
            { label: "Gateway", link: "/api/gateway" },
            { label: "Auth", link: "/api/auth" },
            { label: "Ingestion", link: "/api/ingestion" },
            { label: "Ontology", link: "/api/ontology" },
            { label: "Pipeline", link: "/api/pipeline" },
            { label: "Execution", link: "/api/execution" },
            { label: "App", link: "/api/app" },
            { label: "Logging", link: "/api/logging" },
            { label: "Plugin", link: "/api/plugin" },
          ],
        },
        {
          label: "SDK Reference",
          items: [
            {
              label: "@oneplatform/sdk",
              autogenerate: { directory: "sdk/sdk" },
            },
            {
              label: "@oneplatform/app-sdk",
              autogenerate: { directory: "sdk/app-sdk" },
            },
            {
              label: "@oneplatform/plugin-sdk",
              autogenerate: { directory: "sdk/plugin-sdk" },
            },
            {
              label: "@oneplatform/core",
              autogenerate: { directory: "sdk/core" },
            },
          ],
        },
        {
          label: "CLI Reference",
          autogenerate: { directory: "cli" },
        },
        {
          label: "Architecture",
          items: [
            {
              label: "Architecture Decisions",
              autogenerate: { directory: "architecture/decisions" },
            },
            {
              label: "Service Designs",
              autogenerate: { directory: "architecture/designs" },
            },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
  vite: {
    resolve: {
      alias: {
        // These aliases let content files reference generated docs by logical
        // name rather than needing to know the physical path on disk.
        "@generated": generatedDir,
        "@decisions": decisionsDir,
        "@designs": designsDir,
      },
    },
  },
});
