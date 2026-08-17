import { defineConfig } from "vitest/config";
import path from "path";
import { BASE_EXCLUDE, E2E_GLOB, INTEGRATION_GLOB } from "./vitest.shared";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Required so @testing-library/react's afterEach(cleanup) auto-registers
    // (it feature-detects a global `afterEach`); without this, DOM from one
    // test leaks into the next within the same file.
    globals: true,
    // See vitest.shared.ts for why the integration glob is excluded here and
    // why the list is shared rather than inherited.
    exclude: [...BASE_EXCLUDE, INTEGRATION_GLOB, E2E_GLOB],
    // HZ-01: the network guard is FIRST, so it is installed before any other
    // setup file or test module can issue a request. See
    // vitest.setup.network-guard.ts for the incident it closes.
    setupFiles: ["./vitest.setup.network-guard.ts", "./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
