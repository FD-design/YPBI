import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const biProxyTarget = env.BI_PROXY_TARGET || "http://127.0.0.1:3000";

  return {
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
      proxy: { "/api/bi": { target: biProxyTarget, changeOrigin: true } }
    },
    preview: {
      allowedHosts: ["187.77.129.207.nip.io"]
    }
  };
});
