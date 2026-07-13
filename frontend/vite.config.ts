import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Python backend serves the built files from `dist/` in production.
// In dev (`npm run dev`), Vite serves the app and proxies /api to the
// backend so there is no CORS friction and the same code path works.
export default defineConfig({
  plugins: [react()],
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
      },
    },
  },
});
