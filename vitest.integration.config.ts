import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";
import { BASE_EXCLUDE } from "./vitest.shared";

// vitest.integration.config.ts — the ONLY config that runs tests/integration.
//
// `exclude` is REPLACED after the merge, not passed into it. `mergeConfig`
// concatenates arrays, so anything declared inside the override object is
// ADDED to the base list rather than replacing it — which means this config
// cannot narrow an exclusion it inherits. Passing the list in the override
// left "tests/integration/**" in place and the config collected zero files,
// silently turning the CI integration and RLS steps into failures.
//
// tests/database-entrypoint-safety.test.ts asserts BOTH sides: that the base
// config excludes tests/integration, and that this config still resolves both
// integration files.
const config = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/integration/**/*.test.ts"],
      setupFiles: ["./vitest.setup.integration.ts"],
    },
  })
);

config.test = { ...config.test, exclude: [...BASE_EXCLUDE] };

export default config;
