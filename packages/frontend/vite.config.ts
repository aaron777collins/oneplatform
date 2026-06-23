import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
    // 'hidden' generates .map files for error monitoring tools but omits the
    // sourceMappingURL comment from JS bundles — browsers never fetch maps.
    // Nginx also blocks .map requests as defense-in-depth.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-router": ["@tanstack/react-router"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/bff": "http://localhost:3006",
    },
  },
});
