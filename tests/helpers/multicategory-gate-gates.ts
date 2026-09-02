// tests/helpers/multicategory-gate-gates.ts
//
// El contrato estático del gate multicategoría (`runtime-reserved-quota-verified`)
// como FUNCIÓN PURA sobre el texto de dos ficheros: el evaluador y la batería
// que lo alimenta.
//
// Es una función pura por la misma razón que sus cuatro predecesoras:
// `tests/multicategory-gate-mutation.test.ts` tiene que ejecutar exactamente
// este código sobre copias rotas a propósito. Un gate que vive dentro de una
// aserción que lee el disco no se puede mostrar en rojo, y un gate que nunca se
// ha visto en rojo es indistinguible de uno que no puede estarlo.
//
// QUÉ JUZGA, Y QUÉ NO. Juzga la ESTRUCTURA de la evidencia: que el evaluador
// exija cada propiedad, que la batería MIDA cada campo en vez de declararlo, y
// que los eventos vengan del runtime. No juzga si el sistema es correcto — eso
// lo mide el E2E contra una base real, y ninguna cantidad de texto lo
// sustituye.

import { REQUIRED_CATEGORIES } from '@/tests/eval/stella-release/multicategory-release-gate'

export const GATE_MODULE = 'tests/eval/stella-release/multicategory-release-gate.ts'
export const GATE_SUITE = 'tests/e2e/stella-multicategory-quota.e2e.test.ts'

export const MULTICATEGORY_GATE_FILES = [GATE_MODULE, GATE_SUITE] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/**
 * Los campos del informe cuya ausencia de comprobación deja el gate tautológico.
 *
 * Escritos aquí como DATO y comparados contra el evaluador: un campo añadido al
 * informe y no comprobado es un campo que el gate acepta sea cual sea su valor.
 */
export const LOAD_BEARING_FIELDS = [
  'ledgerAttributionCorrect',
  'siblingReservationRejected',
  'siblingNeverExecuted',
  'crossActorVisibility',
  'crossProjectSharedPool',
  'categoryBindingRejected',
  'scopeBindingRejected',
  'attacksChargedNothing',
  'retryChargedNothing',
  'newOperationCharged',
  'abortChargedNothing',
  'expirationReleased',
  'periodConsistent',
  'directWriteRejected',
  'unticketedConsumptionRejected',
  'invariantHeld',
  'disposableDatabaseGuarded',
] as const

export function evaluateMulticategoryGateContract(input: Sources): Violation[] {
  const violations: Violation[] = []
  const add = (gate: string, detail: string) => violations.push({ gate, detail })

  const gate = input[GATE_MODULE] ?? ''
  const suite = input[GATE_SUITE] ?? ''
  if (gate === '') add('gate-module-present', `${GATE_MODULE} está vacío o falta`)
  if (suite === '') add('gate-suite-present', `${GATE_SUITE} está vacío o falta`)
  if (gate === '' || suite === '') return violations

  /* ---------------------------------------------------------------------- */
  /* (1) El evaluador exige TODAS las categorías                             */
  /* ---------------------------------------------------------------------- */
  for (const category of REQUIRED_CATEGORIES) {
    if (!gate.includes(`'${category}'`)) {
      add(
        'gate-requires-every-category',
        `el evaluador no nombra ${category}: una categoría que no exige es una categoría que podría no compartir la capacidad`,
      )
    }
  }
  if (!gate.includes('REQUIRED_CATEGORIES.filter')) {
    add(
      'gate-requires-every-category',
      'el evaluador no compara las categorías alcanzadas contra las exigidas',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (2) Cada campo portante se comprueba                                    */
  /* ---------------------------------------------------------------------- */
  // Acotado a la TABLA que decide, nunca al fichero entero: el nombre de cada
  // campo aparece además en la interfaz del informe y en la lista de claves, así
  // que un `includes` sobre el módulo lo encuentra aunque la comprobación que
  // lo usaba se haya borrado. La primera versión de esta línea hacía eso y cinco
  // mutantes la atravesaron.
  const decisionTable =
    /const BOOLEANS: readonly \(readonly \[keyof MulticategoryQuotaEvidence, string\]\)\[\] = \[[\s\S]*?\n {2}\]/.exec(
      gate,
    )?.[0] ?? ''
  if (decisionTable === '') {
    add('gate-checks-every-field', 'el evaluador no declara la tabla de campos booleanos que decide')
  }
  for (const field of LOAD_BEARING_FIELDS) {
    if (!decisionTable.includes(`'${field}'`)) {
      add('gate-checks-every-field', `el evaluador acepta cualquier valor de ${field}`)
    }
  }
  if (!gate.includes('if (evidence[key] !== true) reasons.push(why)')) {
    add(
      'gate-checks-every-field',
      'el evaluador no exige que los campos booleanos sean exactamente true — un `truthy` aceptaría una cadena vacía invertida o un objeto',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (3) El ledger se inspecciona, y con suficientes filas                   */
  /* ---------------------------------------------------------------------- */
  if (!gate.includes('ledgerRowsInspected >= REQUIRED_CATEGORIES.length')) {
    add(
      'gate-requires-ledger-inspection',
      'el evaluador no exige una fila inspeccionada por categoría: un informe con cero filas pasaría',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (4) Los eventos exigidos vienen del vocabulario del runtime             */
  /* ---------------------------------------------------------------------- */
  if (!gate.includes('REQUIRED_EVENTS.filter')) {
    add(
      'gate-requires-runtime-events',
      'el evaluador no comprueba qué eventos se emitieron: la observabilidad dejaría de ser evidencia',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (5) FAIL-CLOSED: la conjunción y todas las razones                      */
  /* ---------------------------------------------------------------------- */
  if (!gate.includes('verified: reasons.length === 0')) {
    add(
      'gate-fail-closed',
      'el veredicto no es la conjunción de todas las razones: un gate que decide por otra vía puede pasar con huecos',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (6) El evaluador es PURO                                                */
  /* ---------------------------------------------------------------------- */
  for (const [needle, why] of [
    ["from '@/db/", 'importa el runtime de base de datos'],
    ["from '@/app/", 'importa una server action'],
    ['process.env', 'lee el entorno'],
  ] as const) {
    if (gate.includes(needle)) {
      add('gate-is-pure', `el evaluador ${why}: dejaría de ser una función de su informe`)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* (7) La batería MIDE, no declara                                         */
  /* ---------------------------------------------------------------------- */
  const report = /const evidence: MulticategoryQuotaEvidence = \{[\s\S]*?\n {4}\}/.exec(suite)?.[0] ?? ''
  if (report === '') {
    add('suite-builds-report', 'la batería no construye un informe de evidencia')
  } else {
    const declared = [...report.matchAll(/^\s*(\w+):\s*(?:true|false),\s*$/gm)].map((m) => m[1]!)
    for (const field of declared) {
      add(
        'suite-measures-every-field',
        `${field} se DECLARA en el informe en vez de medirse — es la tautología que el tren 4.3 archivó dos veces como MINOR`,
      )
    }
  }

  /* ---------------------------------------------------------------------- */
  /* (8) La batería captura eventos REALES                                   */
  /* ---------------------------------------------------------------------- */
  if (!suite.includes("args[0] === '[stella-ticket]'")) {
    add(
      'suite-captures-runtime-events',
      'la batería no captura lo que `emitTicketEvent` escribe: los eventos serían fabricados',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (9) La batería prueba la escritura directa y el teardown                */
  /* ---------------------------------------------------------------------- */
  if (!suite.includes('SET LOCAL ROLE uellix_app')) {
    add(
      'suite-probes-direct-write',
      'la batería nunca intenta una escritura directa del ledger: `directWriteRejected` sería una afirmación sin prueba',
    )
  }
  if (
    !suite.includes('UELLIX_MULTICATEGORY_TEARDOWN_GUARDED') ||
    !suite.includes("(CONTAINER_URL ?? '').includes('127.0.0.1:56322')")
  ) {
    add(
      'suite-probes-teardown',
      'la batería no mide que la base sea la desechable aislada: el campo quedaría sin origen',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (10) El control negativo por campo existe                               */
  /* ---------------------------------------------------------------------- */
  if (!suite.includes('MULTICATEGORY_EVIDENCE_KEYS')) {
    add(
      'suite-has-negative-controls',
      'la batería no recorre las claves del informe para probar que retirar cualquiera baja el gate',
    )
  }

  return violations
}
