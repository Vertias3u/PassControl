import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the `@/…` path alias (same as tsconfig `paths`) so tests can import app
// and lib modules the way the app does. Existing relative-import tests are
// unaffected; this only adds resolution for the `@` prefix.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
