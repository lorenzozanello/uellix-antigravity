import { defineConfig } from "vitest/config";
import path from "path";
import { BASE_EXCLUDE, INTEGRATION_GLOB } from "./vitest.shared";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Required so @testing-library/react's afterEach(cleanup) auto-registers
    // (it feature-detects a global `afterEach`); without this, DOM from one
    // test leaks into the next within the same file.
    globals: true,
    // See vitest.shared.ts for why the integration glob is excluded here and
    // why the list is shared rather than inherited.
    exclude: [...BASE_EXCLUDE, INTEGRATION_GLOB],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
