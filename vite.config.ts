import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const proxy = {
  target: "http://127.0.0.1:3000",
  changeOrigin: true,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/admin-api": proxy,
      "/public-api": proxy,
      "/api": proxy,
      "/submit.php": proxy,
      "/mapi.php": proxy,
      "/api.php": proxy,
      "/uploads": proxy,
      "/healthz": proxy,
      "/readyz": proxy,
    },
  },
  build: {
    outDir: "dist/client",
    sourcemap: true,
    emptyOutDir: true,
  },
});
