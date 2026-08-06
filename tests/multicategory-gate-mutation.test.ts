// tests/multicategory-gate-mutation.test.ts
//
// El gate sobre el gate multicategoría.
//
// Una suite estática es fiable sólo en la medida en que alguien haya demostrado
// que se pone ROJA cuando la propiedad que guarda desaparece. Este fichero
// aplica cada mutación catalogada a una copia en memoria del evaluador y de la
// batería que lo alimenta, y exige que `evaluateMulticategoryGateContract()` la
// rechace — y que la rechace por la razón CORRECTA.
//
// Nada aquí escribe en `tests/eval/**` ni en `tests/e2e/**`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateMulticategoryGateContract,
  MULTICATEGORY_GATE_FILES,
  GATE_MODULE,
  GATE_SUITE,
  LOAD_BEARING_FIELDS,
  type Sources,
} from './helpers/multicategory-gate-gates'
import { MULTICATEGORY_GATE_MUTATIONS, type Mutation } from './helpers/multicategory-gate-mutations'
import { CATEGORY_BINDING_MUTATIONS } from './helpers/stella-category-binding-mutations'
import { GOVERNED_CONSUMPTION_MUTATIONS } from './helpers/stella-governed-consumption-mutations'
import { RESERVED_QUOTA_MUTATIONS } from './helpers/stella-reserved-quota-mutations'
import { PROJECT_MUTATIONS } from './helpers/stella-project-ticket-mutations'
import { MUTATIONS as TICKET_MUTATIONS } from './helpers/stella-ticket-mutations'
import { MULTICATEGORY_EVIDENCE_KEYS } from './eval/stella-release/multicategory-release-gate'

const ROOT = process.cwd()

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of MULTICATEGORY_GATE_FILES) out[f] = readFileSync(path.join(ROOT, f), 'utf8')
  return out
}

const BASE = baseline()

/**
 * Los nombres de gate que el evaluador puede emitir, leídos de su propia fuente.
 *
 * Derivados en vez de listados: una lista escrita a mano no puede ver el nombre
 * que no está en ella, y un gate añadido sin mutación es exactamente lo que
 * este fichero existe para hacer visible.
 */
const GATES_SOURCE = readFileSync(
  path.join(ROOT, 'tests', 'helpers', 'multicategory-gate-gates.ts'),
  'utf8',
)
const ALL_GATE_NAMES: ReadonlySet<string> = new Set(
  [...GATES_SOURCE.matchAll(/\badd\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!),
)

/**
 * Gates que ninguna mutación ejercita, escritos para que ampliarlos sea un acto
 * visible y no uno silencioso.
 *
 * Los dos `*-present` son propiedades del ARNÉS (un fichero que falta), no del
 * gate. `gate-is-pure` sólo se puede romper añadiendo un import que además haría
 * que el módulo dejara de compilar en este proyecto, con lo que el mutante
 * probaría la compilación en vez de la propiedad. `suite-builds-report`,
 * `suite-probes-direct-write` y `suite-probes-teardown` se rompen borrando
 * bloques enteros de la batería, y entonces el mutante mide el borrado.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'gate-module-present',
  'gate-suite-present',
  'gate-is-pure',
  'suite-builds-report',
  'suite-probes-direct-write',
  'suite-probes-teardown',
]

function mutate(m: Mutation): Sources {
  const out: Sources = { ...BASE }
  out[m.file] = m.apply(BASE[m.file]!)
  return out
}

describe('gate multicategoría — está limpio tal como se entrega', () => {
  it('no produce violaciones', () => {
    const violations = evaluateMulticategoryGateContract(BASE)
    expect(
      violations.map((x) => `${x.gate}: ${x.detail}`),
      'el gate entregado debe satisfacer su propio contrato estático',
    ).toEqual([])
  })

  it('el evaluador comprueba TODOS los campos portantes del informe', () => {
    // Derivado del informe, no de una lista: un campo añadido a
    // `MulticategoryQuotaEvidence` sin comprobación en el evaluador es un campo
    // que el gate acepta con cualquier valor.
    const structural = new Set([
      'categoriesReached',
      'ledgerRowsInspected',
      'governedFunctionCount',
      'observabilityEventsSeen',
    ])
    for (const key of MULTICATEGORY_EVIDENCE_KEYS) {
      if (structural.has(key)) continue
      expect(
        (LOAD_BEARING_FIELDS as readonly string[]).includes(key),
        `${key} está en el informe pero no en la lista de campos portantes`,
      ).toBe(true)
    }
  })
})

describe('gate multicategoría — cada mutación muere por SU propio gate', () => {
  it.each(MULTICATEGORY_GATE_MUTATIONS.map((m) => [m.id, m] as const))('%s', (_id, m) => {
    const mutated = mutate(m)

    // REGLA 1. Un anclaje obsoleto no coincide con nada y da una ejecución sin
    // violaciones que se lee como un aprobado.
    expect(
      mutated[m.file],
      `${m.id}: la mutación no cambió ${m.file} — el anclaje está obsoleto`,
    ).not.toBe(BASE[m.file])

    const violations = evaluateMulticategoryGateContract(mutated)
    expect(
      violations.length,
      `${m.id} (${m.change}) sobrevivió a todos los gates. Qué rompe: ${m.breaks}`,
    ).toBeGreaterThan(0)

    // REGLA 2. No basta con que ALGO objetara.
    const fired = new Set(violations.map((x) => x.gate))
    for (const gate of m.expectedGate) {
      expect(
        fired.has(gate),
        `${m.id}: se esperaba que disparara '${gate}'; en su lugar: ${[...fired].join(', ')}`,
      ).toBe(true)
    }
  })
})

describe('gate multicategoría — el catálogo', () => {
  it('da a cada mutación un id único, disjunto de los cinco catálogos anteriores', () => {
    const mine = MULTICATEGORY_GATE_MUTATIONS.map((m) => m.id)
    expect(new Set(mine).size).toBe(mine.length)

    const earlier = new Set([
      ...TICKET_MUTATIONS.map((m) => m.id),
      ...PROJECT_MUTATIONS.map((m) => m.id),
      ...RESERVED_QUOTA_MUTATIONS.map((m) => m.id),
      ...GOVERNED_CONSUMPTION_MUTATIONS.map((m) => m.id),
      ...CATEGORY_BINDING_MUTATIONS.map((m) => m.id),
    ])
    const collisions = mine.filter((id) => earlier.has(id))
    expect(collisions, `ids reutilizados: ${collisions.join(', ')}`).toEqual([])
  })

  it('continúa la numeración en vez de reiniciarla', () => {
    const highestEarlier = Math.max(
      ...[
        ...TICKET_MUTATIONS,
        ...PROJECT_MUTATIONS,
        ...RESERVED_QUOTA_MUTATIONS,
        ...GOVERNED_CONSUMPTION_MUTATIONS,
        ...CATEGORY_BINDING_MUTATIONS,
      ].map((m) => Number(m.id.replace('K-', ''))),
    )
    for (const m of MULTICATEGORY_GATE_MUTATIONS) {
      expect(
        Number(m.id.replace('K-', '')),
        `${m.id} no continúa la numeración compartida`,
      ).toBeGreaterThan(highestEarlier)
    }
  })

  it('nombra sólo gates que el evaluador puede emitir', () => {
    const unknown = MULTICATEGORY_GATE_MUTATIONS.flatMap((m) =>
      m.expectedGate.filter((g) => !ALL_GATE_NAMES.has(g)).map((g) => `${m.id} -> ${g}`),
    )
    expect(unknown, `expectedGate nombra gates inexistentes: ${unknown.join(', ')}`).toEqual([])
  })

  it('no deja ningún gate sin ejercitar sin decirlo en voz alta', () => {
    const exercised = new Set(MULTICATEGORY_GATE_MUTATIONS.flatMap((m) => m.expectedGate))
    const orphans = [...ALL_GATE_NAMES].filter(
      (g) => !exercised.has(g) && !UNEXERCISED_GATES.includes(g),
    )
    expect(
      orphans,
      `gate(s) sin mutación y sin entrada en UNEXERCISED_GATES: ${orphans.join(', ')}`,
    ).toEqual([])
  })

  it('apunta sólo a los dos ficheros de este cierre', () => {
    for (const m of MULTICATEGORY_GATE_MUTATIONS) {
      expect([GATE_MODULE, GATE_SUITE]).toContain(m.file)
    }
  })

  it('explica qué rompe cada mutación en más de un fragmento de frase', () => {
    for (const m of MULTICATEGORY_GATE_MUTATIONS) {
      expect(m.breaks.length, `${m.id}: la consecuencia no está escrita`).toBeGreaterThan(120)
      expect(m.clause.length, `${m.id}: no nombra ninguna cláusula`).toBeGreaterThan(10)
    }
  })
})
