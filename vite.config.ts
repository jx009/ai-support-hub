import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  publicDir: "../public",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5188,
    proxy: {
      "/support": "http://127.0.0.1:4080",
      "/admin/api": "http://127.0.0.1:4080",
    },
  },
});
