import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works from GitHub Pages subpaths too.
  base: "./",
  server: {
    host: true,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
  },
});
