import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/zrender")) return "zrender-vendor";
          if (id.includes("node_modules/echarts")) return "echarts-vendor";
          if (id.includes("node_modules/react")) return "react-vendor";
          return undefined;
        }
      }
    }
  },
  server: {
    proxy: { "/api/bi": { target: "http://127.0.0.1:3000", changeOrigin: true } }
  },
  preview: {
    allowedHosts: ["187.77.129.207.nip.io"]
  }
});
