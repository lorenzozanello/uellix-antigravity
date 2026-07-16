import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/integration/**/*.test.ts"],
      setupFiles: ["./vitest.setup.integration.ts"],
    },
  })
);
