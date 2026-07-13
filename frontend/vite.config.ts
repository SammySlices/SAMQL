import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * In Vite, the HTML shell is not served by the Python backend, so the
 * HttpOnly samql_api_token cookie is never set. Inject X-SamQL-Token on
 * proxied /api calls from SAMQL_API_TOKEN / VITE_SAMQL_API_TOKEN so the
 * shared token path matches a backend started with the same env.
 */
function samqlApiTokenProxy(): Plugin {
  return {
    name: "samql-api-token-proxy",
    configureServer(server) {
      const token = (
        process.env.SAMQL_API_TOKEN ||
        process.env.VITE_SAMQL_API_TOKEN ||
        ""
      ).trim();
      if (!token) {
        server.config.logger.warn(
          "[samql] No SAMQL_API_TOKEN / VITE_SAMQL_API_TOKEN set — " +
            "/api calls via the Vite proxy will 403 unless the backend " +
            "is started with a matching token. Set both to the same value.",
        );
      }
    },
  };
}

const proxyToken = (
  process.env.SAMQL_API_TOKEN ||
  process.env.VITE_SAMQL_API_TOKEN ||
  ""
).trim();

// The Python backend serves the built files from `dist/` in production.
// In dev (`npm run dev`), Vite serves the app and proxies /api to the
// backend so there is no CORS friction and the same code path works.
export default defineConfig({
  plugins: [react(), samqlApiTokenProxy()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // .547 startup: split heavy, not-first-paint libraries into their
        // own chunks so the initial IDE view downloads + parses less.
        // NodeFlow is React.lazy'd (App.tsx), so its code naturally lands
        // in a separate chunk; these manualChunks keep the big shared
        // vendors out of the entry chunk too.
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        configure(proxy) {
          if (!proxyToken) return;
          proxy.on("proxyReq", (proxyReq) => {
            if (!proxyReq.getHeader("x-samql-token")) {
              proxyReq.setHeader("X-SamQL-Token", proxyToken);
            }
          });
        },
      },
    },
  },
});
