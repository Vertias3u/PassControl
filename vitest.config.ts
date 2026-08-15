import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the `@/…` path alias (same as tsconfig `paths`) so tests can import app
// and lib modules the way the app does. Existing relative-import tests are
// unaffected; this only adds resolution for the `@` prefix.
export default defineConfig({
  test: {
    // Several security/release tests intentionally spawn npm, bash, and one
    // stubbed psql process per migration. Unbounded file parallelism turns the
    // 5s assertion timeout into a CPU-contention lottery on CI and developer
    // laptops without making the product checks more rigorous.
    maxWorkers: 4,
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  // tsconfig sets `jsx: "preserve"` because Next compiles the JSX itself. Vitest
  // has no Next in front of it, so a test that RENDERS a component — rather than
  // grepping its source — cannot parse the .tsx without being told the
  // transform. Additive: no existing test imports a component.
  oxc: {
    jsx: { runtime: "automatic", importSource: "react" },
  },
});
