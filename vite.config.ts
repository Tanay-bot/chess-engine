import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The multi-threaded Stockfish build needs SharedArrayBuffer, which browsers
// only expose to cross-origin isolated documents.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
});
