// vitest.setup.smoke.ts
// Etapa B0 — setup exclusivo para tests/smoke/stella-b0-real-smoke.test.ts.
//
// A diferencia de vitest.setup.integration.ts (que deliberadamente NO lee
// .env.local para no arriesgar escribir en el proyecto remoto), este smoke
// test necesita variables que SOLO viven en .env.local: GEMINI_API_KEY y los
// STELLA_PILOT_* configurados a mano para esta sesión (ver encargo de cierre
// de B0: "Puedes actualizar exclusivamente variables locales de B0 en
// .env.local"). Por eso este archivo SÍ carga .env.local — pero, igual que
// todo punto de entrada operativo de este repositorio, valida con
// db/guard.ts que el host resuelto sea loopback antes de permitir que
// cualquier prueba corra.

import * as dotenv from 'dotenv'
import path from 'path'
import { checkLocalTargets, defaultTargets, RemoteDatabaseError } from './db/guard'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

try {
  checkLocalTargets(defaultTargets())
} catch (error) {
  if (error instanceof RemoteDatabaseError) {
    throw new Error(`${error.message}\n  Contexto: tests/smoke (Etapa B0, smoke test real)\n`)
  }
  throw error
}
