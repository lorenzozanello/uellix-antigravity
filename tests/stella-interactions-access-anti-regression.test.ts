// tests/stella-interactions-access-anti-regression.test.ts
// Etapa A2.2 (STL-A22-016, DR-007 aprobado 2026-07-26). Escaneo estático de
// código fuente: confirma que ninguna referencia a `stellaInteractions` (la
// tabla Drizzle) aparece fuera de la lista de módulos autorizados. RLS y los
// privilegios de tabla ayudan, pero NO protegen las lecturas hechas vía
// Drizzle sobre DATABASE_URL (bypasean RLS por completo) — este test es la
// única red que detecta una nueva ruta de lectura/escritura directa
// introducida por error fuera del servicio central
// (lib/stella/access/stella-interaction-reads.ts) o del único escritor
// (lib/stella/audit-log.ts).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = process.cwd()

const EXCLUDED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.claude'])

/** Módulos de producción autorizados a referenciar `stellaInteractions`. */
const AUTHORIZED_PRODUCTION_FILES = new Set([
  'db/schema.ts', // la propia definición de la tabla
  'lib/stella/audit-log.ts', // único escritor (recordStellaInteraction)
  'lib/stella/quota.ts', // conteo agregado (count()), nunca filas/columnas de contenido
  'lib/admin/stella-services.ts', // conteo agregado por organización, mismo patrón que quota.ts
  'lib/projects/service.ts', // guarda de existencia (SELECT id) antes de borrar un proyecto
  'lib/stella/access/stella-interaction-access.ts', // decisión pura de autorización (no consulta la BD)
  'lib/stella/access/stella-interaction-reads.ts', // servicio central de lectura autorizada
  // Etapa A2.4 (DR-004 aprobado) — el motor de retención/purga. Cada uno
  // limita su acceso a columnas estructurales (id/organizationId/projectId/
  // createdAt/responsePurgedAt), nunca responseJson/contextManifest/
  // riskFlags como CONTENIDO — ver la tercera prueba de este archivo.
  'lib/stella/retention/purge-service.ts', // el ÚNICO camino que escribe response_json = NULL (redacción por vencimiento)
  'lib/stella/retention/hold-service.ts', // valida que un interactionId exista y pertenezca a la organización/proyecto antes de crear un hold con ese alcance
  'lib/stella/retention/settings-service.ts', // conteo agregado (count()) para la simulación de impacto de un cambio de retención, nunca filas/columnas de contenido
])

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, files)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

describe('Anti-regresión: referencias a stellaInteractions (Etapa A2.2, STL-A22-016)', () => {
  it('ninguna referencia de PRODUCCIÓN a stellaInteractions aparece fuera de los módulos autorizados', () => {
    const referencePattern = /\bstellaInteractions\b/
    const unexpected: string[] = []

    for (const dir of ['app', 'lib', 'components', 'db']) {
      const files = walk(join(REPO_ROOT, dir))
      for (const file of files) {
        const relPath = relative(REPO_ROOT, file).replace(/\\/g, '/')

        // Los archivos de prueba (__tests__/, .test.ts) siembran/limpian
        // datos directamente por diseño (ver tests/integration/) — no son
        // "lecturas de producción" y quedan fuera de este escaneo.
        if (relPath.includes('__tests__/') || relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')) {
          continue
        }

        if (AUTHORIZED_PRODUCTION_FILES.has(relPath)) continue

        const content = readFileSync(file, 'utf-8')
        if (referencePattern.test(content)) {
          unexpected.push(relPath)
        }
      }
    }

    expect(unexpected).toEqual([])
  })

  it('la lista de módulos autorizados sigue existiendo y sigue referenciando la tabla (detecta falsos negativos por renombrado)', () => {
    for (const relPath of AUTHORIZED_PRODUCTION_FILES) {
      if (relPath === 'lib/stella/access/stella-interaction-access.ts') continue // no consulta la BD, no referencia la tabla
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
      expect(content, `${relPath} debería seguir referenciando stellaInteractions`).toMatch(/\bstellaInteractions\b/)
    }
  })

  it('lib/stella/quota.ts y lib/admin/stella-services.ts solo hacen conteos agregados, nunca seleccionan columnas de contenido', () => {
    for (const relPath of ['lib/stella/quota.ts', 'lib/admin/stella-services.ts']) {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
      expect(content).not.toMatch(/responseJson|contextManifest|riskFlags/)
    }
  })

  it('el motor de retención (Etapa A2.4) nunca selecciona/actualiza campos de contenido más allá de responseJson=NULL para redacción', () => {
    for (const relPath of ['lib/stella/retention/hold-service.ts', 'lib/stella/retention/settings-service.ts']) {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf-8')
      expect(content, `${relPath} no debería referenciar contextManifest/riskFlags`).not.toMatch(/contextManifest|riskFlags/)
    }
    // purge-service.ts SÍ escribe responseJson — pero únicamente como `responseJson: null` (redacción), nunca lo lee como valor.
    const purgeContent = readFileSync(join(REPO_ROOT, 'lib/stella/retention/purge-service.ts'), 'utf-8')
    expect(purgeContent).not.toMatch(/contextManifest|riskFlags/)
    expect(purgeContent).toMatch(/responseJson:\s*null/)
    expect(purgeContent).not.toMatch(/\.responseJson\b/) // never reads row.responseJson as a value
  })
})
