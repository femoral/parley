import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Parley Cove build. The daemon serves the emitted bundle at `/` via the
 * `parley.ui` discovery marker (which points at `www`), so:
 *  - `outDir: "www"` puts the build exactly where discovery looks (#64/#65).
 *  - `base: "/"` — the cockpit mounts at the origin root and the SPA fallback
 *    re-serves `index.html` for deep routes, so absolute `/assets/*` URLs
 *    resolve on a hard reload of any client-side route.
 *  - Fonts are self-hosted (`@fontsource`, imported from `src`); Vite fingerprints
 *    the woff2 into `www/assets`. Nothing is ever fetched from a CDN at runtime.
 */
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "www",
    emptyOutDir: true,
    // Cockpit chrome + fonts fit comfortably; keep the warning honest.
    chunkSizeWarningLimit: 900,
  },
});
