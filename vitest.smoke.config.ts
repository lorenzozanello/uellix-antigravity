import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Etapa B0 — configuración exclusiva para el smoke test real (paid Gemini).
// Deliberadamente separada de vitest.config.ts (unit) y vitest.integration.config.ts
// (integración, que a propósito NO lee .env.local): este archivo SÍ debe leer
// .env.local, porque ahí viven GEMINI_API_KEY y los STELLA_PILOT_* de esta
// sesión. Nunca se invoca desde pnpm test / test:unit / test:integration / CI
// — solo desde `pnpm stella:pilot:smoke`, un comando que un humano ejecuta a
// propósito.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/smoke/**/*.test.ts"],
      setupFiles: ["./vitest.setup.smoke.ts"],
      testTimeout: 30000,
    },
  })
);
