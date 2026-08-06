import { defineConfig } from "vitest/config";
import path from "path";
import { BASE_EXCLUDE } from "./vitest.shared";

/**
 * The disposable-database end-to-end battery (Train 4.1, INT-INT-001).
 *
 * A SEPARATE config, not a flag on the default one. `E2E_GLOB` is excluded in
 * vitest.config.ts, and an exclude wins even over an explicitly named file
 * argument — so `vitest run tests/e2e/...` against the default config would
 * silently collect nothing and exit green. A battery that reports success by
 * running no tests is worse than one that fails.
 *
 * `environment: "node"`, not jsdom: this suite drives server actions and a
 * real postgres driver, and a DOM would only add a global that none of it
 * reads. `setupFiles` is deliberately empty — vitest.setup.ts wires
 * @testing-library/react cleanup, which has nothing to clean here.
 *
 * It is only ever launched by scripts/stella-ticket-e2e.sh, which builds the
 * database it needs and destroys it afterwards.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/e2e/**/*.e2e.test.ts"],
    exclude: [...BASE_EXCLUDE],
    // One file, one database, shared mutable ledger state: parallel forks
    // would race each other's quota and charge counts and turn a real
    // concurrency test into a flaky one.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
