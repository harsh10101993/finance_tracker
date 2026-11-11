import { defineConfig } from "vite";

// GitHub Pages: served from https://<user>.github.io/finance_tracker/
export default defineConfig({
  base: "/finance_tracker/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173 },
});
