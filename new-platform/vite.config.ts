import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5190, proxy: { "/api": "http://127.0.0.1:3100" } },
  preview: { port: 5191 },
  build: { rollupOptions: { output: { manualChunks: { "react-vendor": ["react", "react-dom"], "echarts-vendor": ["echarts"] } } } }
});
