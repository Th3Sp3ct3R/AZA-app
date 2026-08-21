import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Read the version from package.json via fs (NOT a JSON import) — a JSON import
// can resolve to undefined under some build/module-interop configs, which made
// `define` skip the substitution and ship a literal `__APP_VERSION__` token that
// crashed the app on update ("__APP_VERSION__ is not defined"). fs + fallback is
// deterministic across every build path. The runtime also guards it defensively.
function appVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    /* fall through to a safe default — never break the build over a version string */
  }
  return "0.0.0";
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    // Single source of truth for the app version (shown in the HUD footer).
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        living: fileURLToPath(new URL("./living.html", import.meta.url)),
      },
      output: {
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
});
