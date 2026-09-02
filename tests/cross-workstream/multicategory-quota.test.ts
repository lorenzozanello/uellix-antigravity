// tests/cross-workstream/multicategory-quota.test.ts
// INTEGRACIÓN — Tren 4.3c. Las costuras que cruza la evidencia multicategoría,
// comprobadas desde el OTRO lado de cada una.
//
// Nada aquí abre una base ni un socket. La mitad conductual de la invariante
// vive en `tests/e2e/stella-multicategory-quota.e2e.test.ts` (PostgreSQL real,
// seis server actions reales); lo que este fichero comprueba es que las piezas
// que la producen y la consumen no puedan derivar en silencio:
//
//   · que las SIETE acciones usen el protocolo común y ninguna escriba directo;
//   · que la categoría esperada llegue a SQL desde la superficie y no del cliente;
//   · que el gate no pueda alimentarse del MODELO DE REFERENCIA;
//   · que el guion del E2E aplique la cadena completa;
//   · que la precedencia de paquetes sea 0013 < 0014 < … < 0018.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { readSourceText } from '@/tests/helpers/source-text'
import {
  evaluateMulticategoryQuotaGate,
  MULTICATEGORY_EVIDENCE_KEYS,
  REQUIRED_CATEGORIES,
  REQUIRED_EVENTS,
  GOVERNED_FUNCTION_COUNT,
  type MulticategoryQuotaEvidence,
} from '@/tests/eval/stella-release/multicategory-release-gate'
import { STELLA_TICKET_PACKAGE_CHAIN } from '@/db/prepared-package-order'
import { STELLA_TICKET_CATEGORIES } from '@/lib/stella/operation-ticket/categories'
import { TICKET_LIFECYCLE_EVENT_NAMES } from '@/lib/stella/operation-ticket/ticket-observability'

const E2E_SUITE = 'tests/e2e/stella-multicategory-quota.e2e.test.ts'
const E2E_SCRIPT = 'scripts/stella-multicategory-quota-e2e.sh'

const E2E_TS = readSourceText(E2E_SUITE)
const E2E_SH = readSourceText(E2E_SCRIPT)
const DRIVER_TS = readSourceText('lib/stella/operation-ticket/governed-operation.ts')
const ADAPTER_TS = readSourceText('db/stella/operation-tickets.ts')
const GATE_TS = readSourceText('tests/eval/stella-release/multicategory-release-gate.ts')

const ACTIONS = [
  'app/actions/stella/advisor.ts',
  'app/actions/stella/validator.ts',
  'app/actions/stella/composer.ts',
  'app/actions/stella/reviewer.ts',
  'app/actions/stella/grounded-query.ts',
] as const

/** Fuente sin comentarios: una aserción de ausencia no puede castigar a un
 *  módulo por documentar exactamente lo que se niega a hacer. */
function codeLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('--'))
    .join('\n')
}

/* ========================================================================== */
/* 1. Las siete rutas usan UN protocolo                                       */
/* ========================================================================== */

describe('RUNTIME: una sola ruta de consumo, siete categorías', () => {
  it('las cinco acciones hermanas pasan por el driver común y ninguna escribe el ledger', () => {
    for (const file of ACTIONS.filter((f) => !f.endsWith('grounded-query.ts'))) {
      const source = readSourceText(file)
      expect(source, `${file} no usa el driver gobernado`).toContain('runGovernedStellaOperation')
      expect(codeLines(source), `${file} escribe el ledger directamente`).not.toMatch(
        /db\s*\.\s*insert\s*\(\s*stellaInteractions/,
      )
    }
  })

  it('ninguna acción alcanza una superficie de consumo sin ticket', () => {
    // Ni por nombre de función SQL ni por el helper que las envolvía. El gate
    // del catálogo (privilegios) lo comprueba contra la base; esto lo comprueba
    // contra el CÓDIGO, que es donde una regresión aparecería primero.
    // Se busca la INVOCACIÓN, no la mención. `grounded-query.ts` nombra
    // `consume_stella_quota` dentro del literal que describe la ruta de cargo en
    // su rastro de auditoría — una cadena de texto, no una llamada — y una
    // aserción sobre la mención habría exigido borrar la documentación de lo que
    // el módulo justamente NO hace.
    for (const file of ACTIONS) {
      const code = codeLines(readSourceText(file))
      for (const forbidden of ['consume_stella_quota', 'consume_stella_capacity']) {
        expect(code, `${file} invoca ${forbidden}`).not.toMatch(
          new RegExp(`(uellix_stella\\.)?${forbidden}\\s*\\(`),
        )
      }
      expect(code, `${file} usa checkStellaQuota`).not.toMatch(/checkStellaQuota\s*\(/)
    }
  })

  it('la categoría esperada viaja del SERVIDOR a SQL, y no puede venir del cliente', () => {
    // El adaptador la exige, la refuta si no es del vocabulario, y NUNCA la
    // sustituye por la del propio ticket — que es la trampa que haría trivial
    // cualquier comparación.
    expect(ADAPTER_TS).toMatch(
      /export async function bindOperationTicket\(\s*\n\s*ticketId: string,\s*\n\s*expectedProjectId: string,\s*\n\s*queryHash: string,\s*\n\s*expectedCategory: StellaTicketCategory,/,
    )
    expect(ADAPTER_TS).toContain('if (!isStellaTicketCategory(expectedCategory))')
    expect(ADAPTER_TS).toContain('${expectedCategory}::varchar(50)')

    // El driver pasa SU constante, no un argumento del llamante.
    expect(DRIVER_TS).toContain('bindOperationTicket(ticket, projectId, operationHash, category)')

    // Y la acción parametrizada —la única que puede actuar como más de una
    // categoría— narrow el valor entrante contra un conjunto que el SERVIDOR
    // calcula a partir de las banderas.
    const reviewer = readSourceText('app/actions/stella/reviewer.ts')
    expect(reviewer).toContain('resolveIssuableCategory')
    expect(reviewer).toContain('enabledReviewerCategories()')
  })

  it('el vocabulario del gate es el del producto, no una copia', () => {
    expect([...REQUIRED_CATEGORIES].sort()).toEqual([...STELLA_TICKET_CATEGORIES].sort())
    for (const event of REQUIRED_EVENTS) {
      expect(
        (TICKET_LIFECYCLE_EVENT_NAMES as readonly string[]).includes(event),
        `${event} no es un evento que el runtime pueda emitir`,
      ).toBe(true)
    }
  })
})

/* ========================================================================== */
/* 2. El E2E conduce runtime real                                             */
/* ========================================================================== */

describe('E2E: la batería multicategoría conduce el runtime, no un modelo', () => {
  it('importa las SEIS superficies reales y las ejecuta', () => {
    for (const mod of [
      '@/app/actions/stella/grounded-query',
      '@/app/actions/stella/advisor',
      '@/app/actions/stella/validator',
      '@/app/actions/stella/composer',
      '@/app/actions/stella/reviewer',
    ]) {
      expect(E2E_TS, `la batería no importa ${mod}`).toContain(mod)
    }
    for (const entry of [
      'issueStellaAdvisorTicket',
      'issueStellaValidatorTicket',
      'issueStellaComposerTicket',
      'issueStellaReviewerTicket',
      'issueStellaGroundedQueryTicketForProject',
      'getStellaAdvisor',
      'getStellaValidator',
      'getStellaComposer',
      'getStellaReviewer',
      'runStellaGroundedQueryForProject',
    ]) {
      expect(E2E_TS, `la batería no conduce ${entry}`).toContain(entry)
    }
  })

  it('sustituye EXACTAMENTE cuatro cosas, y el proveedor es la única del dominio', () => {
    const mocked = [...E2E_TS.matchAll(/vi\.mock\('([^']+)'/g)].map((m) => m[1]!)
    expect(new Set(mocked)).toEqual(
      new Set([
        '@/lib/stella/config',
        '@/lib/stella/rate-limit',
        '@/lib/auth/session',
        '@/lib/auth/database-context',
        '@/lib/stella/adapter/gemini-client',
      ]),
    )
    // El contexto de identidad sustituido llama al REAL: si se redujera a
    // `cb => cb()`, cada policy RLS y cada U0102 se evaluaría como nadie.
    expect(E2E_TS).toContain('withDatabaseIdentityContext')
    // Y el `parseResponse` inyectado delega en el esquema del producto.
    expect(E2E_TS).toContain('schema.parse(JSON.parse(rawOutput))')
    // Ni el driver ni el adaptador se sustituyen: el protocolo es real.
    expect(mocked).not.toContain('@/lib/stella/operation-ticket/governed-operation')
    expect(mocked).not.toContain('@/db/stella/operation-tickets')
    expect(mocked).not.toContain('@/db/client')
  })

  it('lee el ledger y los privilegios por una SEGUNDA conexión', () => {
    expect(E2E_TS).toContain('UELLIX_MULTICATEGORY_E2E_ADMIN_URL')
    expect(E2E_TS).toContain('FROM public.stella_interactions')
    expect(E2E_TS).toContain('has_function_privilege')
    // Y falla si esa conexión no es el contenedor desechable.
    expect(E2E_TS).toContain("includes('127.0.0.1:56322')")
  })

  it('captura los eventos del RUNTIME y no los fabrica', () => {
    // La captura es sobre lo que `emitTicketEvent` escribe de verdad.
    expect(E2E_TS).toContain("args[0] === '[stella-ticket]'")
    // Y no hay ni un solo `captured.push` con un nombre inventado.
    const pushes = [...E2E_TS.matchAll(/captured\.push\(/g)]
    expect(pushes.length, 'los eventos se empujan desde más de un sitio').toBe(1)
  })

  it('el guion aplica la cadena COMPLETA y ninguno de sus paquetes es best-effort', () => {
    for (const pkg of STELLA_TICKET_PACKAGE_CHAIN) {
      expect(E2E_SH, `el guion no aplica ${pkg}`).toContain(pkg)
    }
    for (const grounding of [
      'grounding_0002_document_versions',
      'grounding_0003_evidence_chunks',
      'grounding_0004_runtime_attestation',
    ]) {
      expect(E2E_SH).toContain(grounding)
    }
    // Falla si falta un paquete, y falla si uno no aplica.
    expect(E2E_SH).toContain('|| fail "falta db/prepared/$f.sql"')
    expect(E2E_SH).toContain('|| fail "$f no aplicó"')
    // Y no admite `|| true` sobre un apply.
    expect(E2E_SH).not.toMatch(/-f "\/\$f\.sql".*\|\| true/)
  })

  it('el guion comprueba el orden ANTES de aplicar, y el estado DESPUÉS', () => {
    expect(E2E_SH).toContain('package_order_guard "$f"')
    expect(E2E_SH).toContain('DB_MIGRATOR_PACKAGE_ORDER_VIOLATION')
    expect(E2E_SH).toContain(`[ "$FNS" = "${GOVERNED_FUNCTION_COUNT}" ]`)
    expect(E2E_SH).toContain('0 escritores de runtime')
    for (const surface of [
      'uellix_stella_ops.bind_operation_ticket(character, uuid, character)',
      'uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)',
      'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)',
    ]) {
      expect(E2E_SH, `el guion no comprueba ${surface}`).toContain(surface)
    }
  })

  it('destruye el contenedor en un trap y comprueba que no quedan residuos', () => {
    expect(E2E_SH).toContain('trap cleanup EXIT')
    expect(E2E_SH).toContain('el contenedor sobrevivió al teardown')
    expect(E2E_SH).toContain('el contenedor dejó un volumen')
    // Sin volúmenes por construcción, y afirmado sobre el contenedor real.
    expect(E2E_SH).toContain("docker inspect -f '{{len .Mounts}}'")
    // Acotado a las líneas de `docker run` REALES: la cabecera del guion explica
    // por qué no hay `-v` ni `--mount`, y una expresión sobre el fichero entero
    // castigaría esa explicación.
    const runLines = E2E_SH.split('\n').filter(
      (l) => l.includes('docker run') && !l.trim().startsWith('#'),
    )
    expect(runLines.length, 'el guion no levanta ningún contenedor').toBeGreaterThan(0)
    for (const line of runLines) {
      expect(line, 'docker run monta un volumen').not.toMatch(/\s-v\s|--mount/)
    }
  })

  it('el proveedor externo no está en el entorno del proceso hijo', () => {
    expect(E2E_SH).toContain('env -u MSYS_NO_PATHCONV -u GEMINI_API_KEY')
    expect(E2E_TS).toContain("expect('GEMINI_API_KEY' in process.env).toBe(false)")
  })
})

/* ========================================================================== */
/* 3. El gate no puede alimentarse de un modelo                               */
/* ========================================================================== */

describe('RELEASE: runtime-reserved-quota-verified es fail-closed', () => {
  const complete: MulticategoryQuotaEvidence = {
    categoriesReached: [...REQUIRED_CATEGORIES],
    ledgerRowsInspected: REQUIRED_CATEGORIES.length,
    ledgerAttributionCorrect: true,
    siblingReservationRejected: true,
    siblingNeverExecuted: true,
    crossActorVisibility: true,
    crossProjectSharedPool: true,
    categoryBindingRejected: true,
    scopeBindingRejected: true,
    attacksChargedNothing: true,
    retryChargedNothing: true,
    newOperationCharged: true,
    abortChargedNothing: true,
    expirationReleased: true,
    periodConsistent: true,
    directWriteRejected: true,
    unticketedConsumptionRejected: true,
    governedFunctionCount: GOVERNED_FUNCTION_COUNT,
    observabilityEventsSeen: [...REQUIRED_EVENTS],
    invariantHeld: true,
    disposableDatabaseGuarded: true,
  }

  it('acepta una evidencia completa', () => {
    const verdict = evaluateMulticategoryQuotaGate(complete)
    expect(verdict.reasons).toEqual([])
    expect(verdict.verified).toBe(true)
  })

  it('cada campo tiene su propio control negativo — no hay campo decorativo', () => {
    for (const key of MULTICATEGORY_EVIDENCE_KEYS) {
      const weakened = { ...complete } as Record<string, unknown>
      const current = weakened[key]
      if (typeof current === 'boolean') weakened[key] = false
      else if (typeof current === 'number') weakened[key] = 0
      else if (Array.isArray(current)) weakened[key] = []
      const verdict = evaluateMulticategoryQuotaGate(weakened as unknown as MulticategoryQuotaEvidence)
      expect(verdict.verified, `${key} no es portante`).toBe(false)
      expect(verdict.reasons.length, `${key} no produce una razón`).toBeGreaterThan(0)
    }
  })

  it('una sola categoría ausente lo derriba, y la razón la nombra', () => {
    for (const missing of REQUIRED_CATEGORIES) {
      const verdict = evaluateMulticategoryQuotaGate({
        ...complete,
        categoriesReached: REQUIRED_CATEGORIES.filter((c) => c !== missing),
      })
      expect(verdict.verified, `${missing} ausente no bajó el gate`).toBe(false)
      expect(verdict.reasons.join(' ')).toContain(missing)
    }
  })

  it('devuelve TODAS las razones, no la primera', () => {
    const verdict = evaluateMulticategoryQuotaGate({
      ...complete,
      directWriteRejected: false,
      unticketedConsumptionRejected: false,
      invariantHeld: false,
    })
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(3)
  })

  it('el evaluador es PURO: no abre base, no importa el runtime y no fabrica evidencia', () => {
    expect(GATE_TS).not.toMatch(/from '@\/db\//)
    expect(GATE_TS).not.toMatch(/from '@\/app\//)
    expect(GATE_TS).not.toContain('postgres')
    expect(GATE_TS).not.toContain('process.env')
  })

  it('el ÚNICO productor de evidencia es el E2E — el modelo de referencia no alimenta readiness', () => {
    const ROOT = process.cwd()
    const producers: string[] = []
    for (const candidate of [
      'tests/e2e/stella-multicategory-quota.e2e.test.ts',
      'tests/e2e/stella-ticket-journey.e2e.test.ts',
      'tests/cross-workstream/multicategory-quota.test.ts',
      'tests/eval/stella-release/reserved-quota-protocol.ts',
      'tests/eval/stella-release/reserved-quota-release-gate.ts',
      'scripts/eval-reserved-quota-offline.ts',
      'scripts/eval-release-offline.ts',
    ]) {
      const full = path.join(ROOT, candidate)
      if (!existsSync(full)) continue
      if (readFileSync(full, 'utf8').includes('evaluateMulticategoryQuotaGate')) producers.push(candidate)
    }
    // Este mismo fichero lo llama para probar el gate; el E2E lo llama con
    // evidencia real. Nada más puede.
    expect(new Set(producers)).toEqual(
      new Set([
        'tests/e2e/stella-multicategory-quota.e2e.test.ts',
        'tests/cross-workstream/multicategory-quota.test.ts',
      ]),
    )
  })

  it('el E2E no rellena la evidencia con literales', () => {
    // La primera versión del bloque del gate ponía nueve `true` a mano y
    // «pasaba». Lo que se afirma aquí es que cada campo booleano del informe
    // proviene de una variable calculada, no de una constante.
    const block = /const evidence: MulticategoryQuotaEvidence = \{[\s\S]*?\n    \}/.exec(E2E_TS)?.[0]
    expect(block, 'no se encontró el informe de evidencia en el E2E').toBeTruthy()
    const literalTrue = [...block!.matchAll(/^\s*(\w+):\s*true,\s*$/gm)].map((m) => m[1]!)
    expect(
      literalTrue,
      `estos campos se declaran en vez de medirse: ${literalTrue.join(', ')}`,
    ).toEqual([])
  })
})

/* ========================================================================== */
/* 4. Precedencia de paquetes                                                 */
/* ========================================================================== */

describe('CAPABILITIES: la cadena preparada tiene un orden total', () => {
  it('0013 < 0014 < 0015 < 0016 < 0017 < 0018, derivado y no escrito', () => {
    const ordinals = STELLA_TICKET_PACKAGE_CHAIN.map((pkg) => {
      const m = /^stella_(\d{4})_/.exec(pkg)
      expect(m, `${pkg} no está numerado`).not.toBeNull()
      return Number(m![1])
    })
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]!).toBeGreaterThan(ordinals[i - 1]!)
    }
    expect(ordinals[0]).toBe(13)
    expect(ordinals[ordinals.length - 1]).toBe(18)
  })

  it('el guion del E2E aplica los paquetes en el orden que el registro declara', () => {
    const positions = STELLA_TICKET_PACKAGE_CHAIN.map((pkg) => E2E_SH.indexOf(`  ${pkg}\n`))
    for (const [index, at] of positions.entries()) {
      expect(at, `${STELLA_TICKET_PACKAGE_CHAIN[index]} no está en la lista FORWARD`).toBeGreaterThan(-1)
    }
    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i]!,
        `${STELLA_TICKET_PACKAGE_CHAIN[i]} se aplica antes que ${STELLA_TICKET_PACKAGE_CHAIN[i - 1]}`,
      ).toBeGreaterThan(positions[i - 1]!)
    }
  })
})

/* ========================================================================== */
/* 5. La siembra local sigue siendo fail-closed                               */
/* ========================================================================== */

describe('RELEASE: seed-stella-local se niega bajo identidad de runtime', () => {
  it('comprueba session_user y current_user antes de escribir', () => {
    const seed = readSourceText('scripts/seed-stella-local.ts')
    expect(seed).toContain('session_user')
    expect(seed).toContain('current_user')
    expect(seed).toContain('uellix_app')
    // Y la comprobación ocurre ANTES del primer INSERT.
    const guardAt = seed.indexOf('current_user')
    const insertAt = seed.search(/insert\s*\(|INSERT INTO/i)
    expect(insertAt, 'no hay ningún INSERT en el seed').toBeGreaterThan(-1)
    expect(guardAt, 'la guarda de identidad corre después del primer INSERT').toBeLessThan(insertAt)
  })
})
