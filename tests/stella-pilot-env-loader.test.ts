// tests/stella-pilot-env-loader.test.ts
//
// Etapa B0 — diagnóstico de contradicción de clave (2026-07-27). Una sesión
// de diagnóstico confirmó que scripts/stella-pilot-preflight.ts y
// vitest.setup.smoke.ts YA cargan `.env.local` de forma explícita por ruta
// (`dotenv.config({ path: ... '.env.local' })`), nunca un `import 'dotenv/config'`
// desnudo (que cargaría `.env`) — a diferencia de scripts/seed-proxies.ts,
// scripts/seed-taxonomies.ts y scripts/clean-test-data.ts, que sí usan el
// patrón desnudo (y por eso db/guard.ts existe). Esta prueba fija ese
// comportamiento con fixtures temporales — nunca toca los `.env*` reales del
// repositorio — para que una futura regresión (alguien reemplaza la carga
// explícita por un `import 'dotenv/config'` desnudo) falle en CI.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'

describe('carga explícita de .env.local (dotenv.config con path)', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    delete process.env.STELLA_ENV_LOADER_TEST_VAR
  })

  it('un dotenv.config({ path }) explícito carga el valor del archivo indicado', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'stella-env-test-'))
    const envLocalPath = path.join(dir, '.env.local')
    writeFileSync(envLocalPath, 'STELLA_ENV_LOADER_TEST_VAR=from-env-local\n')

    delete process.env.STELLA_ENV_LOADER_TEST_VAR
    dotenv.config({ path: envLocalPath })

    expect(process.env.STELLA_ENV_LOADER_TEST_VAR).toBe('from-env-local')
  })

  it('un valor YA presente en process.env conserva prioridad (dotenv no sobrescribe por defecto)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'stella-env-test-'))
    const envLocalPath = path.join(dir, '.env.local')
    writeFileSync(envLocalPath, 'STELLA_ENV_LOADER_TEST_VAR=from-file\n')

    process.env.STELLA_ENV_LOADER_TEST_VAR = 'from-process'
    dotenv.config({ path: envLocalPath })

    // Este es exactamente el mecanismo que la sesión de diagnóstico
    // descartó como causa: si algo hubiera fijado la variable ANTES de esta
    // llamada, el archivo nunca la habría sobrescrito silenciosamente.
    expect(process.env.STELLA_ENV_LOADER_TEST_VAR).toBe('from-process')
  })

  it('dos archivos distintos con el mismo nombre de variable no se mezclan si solo se carga uno explícitamente', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'stella-env-test-'))
    const envPath = path.join(dir, '.env')
    const envLocalPath = path.join(dir, '.env.local')
    writeFileSync(envPath, 'STELLA_ENV_LOADER_TEST_VAR=from-dot-env\n')
    writeFileSync(envLocalPath, 'STELLA_ENV_LOADER_TEST_VAR=from-dot-env-local\n')

    delete process.env.STELLA_ENV_LOADER_TEST_VAR
    dotenv.config({ path: envLocalPath }) // nunca se toca envPath

    expect(process.env.STELLA_ENV_LOADER_TEST_VAR).toBe('from-dot-env-local')
  })
})

describe('paridad estructural: preflight y smoke usan el mismo mecanismo de carga', () => {
  it('scripts/stella-pilot-preflight.ts carga .env.local por ruta explícita, no un import desnudo', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'scripts/stella-pilot-preflight.ts'), 'utf-8')
    expect(source).toContain(".env.local")
    expect(/dotenv\.config\(\s*\{\s*path:/.test(source)).toBe(true)
    expect(/^import ['"]dotenv\/config['"]/m.test(source)).toBe(false)
  })

  it('vitest.setup.smoke.ts carga .env.local por ruta explícita, no un import desnudo', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'vitest.setup.smoke.ts'), 'utf-8')
    expect(source).toContain(".env.local")
    expect(/dotenv\.config\(\s*\{\s*path:/.test(source)).toBe(true)
    expect(/^import ['"]dotenv\/config['"]/m.test(source)).toBe(false)
  })

  it('vitest.setup.smoke.ts valida el host de la base de datos (db/guard.ts) después de cargar el entorno', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'vitest.setup.smoke.ts'), 'utf-8')
    const envLoadIndex = source.indexOf('dotenv.config(')
    // Busca la LLAMADA (no el import): `checkLocalTargets(defaultTargets())`.
    const guardCallIndex = source.indexOf('checkLocalTargets(defaultTargets')
    expect(envLoadIndex).toBeGreaterThan(-1)
    expect(guardCallIndex).toBeGreaterThan(-1)
    expect(envLoadIndex).toBeLessThan(guardCallIndex)
  })
})

describe('el arnés de piloto no depende de una variable de entorno ambigua', () => {
  it('lib/stella/pilot/config.ts no lee GOOGLE_API_KEY en ninguna parte', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'lib/stella/pilot/config.ts'), 'utf-8')
    expect(source).not.toContain('GOOGLE_API_KEY')
  })

  it('lib/stella/config.ts resuelve la clave únicamente desde GEMINI_API_KEY, sin autodetección del SDK', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'lib/stella/config.ts'), 'utf-8')
    expect(source).toContain('process.env.GEMINI_API_KEY')
    expect(source).not.toContain('GOOGLE_API_KEY')
  })
})
