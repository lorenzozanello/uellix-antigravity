// tests/eval/stella-release/multicategory-release-gate.ts
// RELEASE — Tren 4.3c. El gate `runtime-reserved-quota-verified`.
//
// ---------------------------------------------------------------------------
// QUÉ ES ESTE FICHERO, Y QUÉ NO ES
// ---------------------------------------------------------------------------
// Es una FUNCIÓN PURA sobre un informe de evidencia. No abre conexión, no
// importa el runtime y no sabe SQL. Su único trabajo es decidir si una
// ejecución MEDIDA satisface la propiedad que el tren 4.3 exige:
//
//     todas las categorías Stella comparten UNA capacidad, y ninguna puede
//     ignorar una reserva, consumir sin ticket, usar una categoría distinta,
//     cobrar dos veces, devolver una respuesta sin cargo, ni registrar un
//     cargo bajo proyecto o categoría incorrectos.
//
// NO es un modelo de referencia. `tests/eval/stella-release/reserved-quota-protocol.ts`
// es un oráculo: describe qué HARÍA un sistema correcto, y es útil para razonar
// sobre el protocolo. Alimentar este gate con su salida sería usar la respuesta
// como prueba. El único productor legítimo de `MulticategoryQuotaEvidence` es
// `tests/e2e/stella-multicategory-quota.e2e.test.ts`, que lo construye a partir
// de filas COMMITEADAS, privilegios del catálogo y eventos que el runtime
// escribió — y `tests/cross-workstream/multicategory-quota.test.ts` afirma que
// no hay otro.
//
// ---------------------------------------------------------------------------
// FAIL-CLOSED, Y POR QUÉ CADA CAMPO ES OBLIGATORIO
// ---------------------------------------------------------------------------
// El veredicto es una CONJUNCIÓN: cualquier campo ausente, falso, vacío o
// insuficiente devuelve `verified: false` con una razón nombrada. No hay
// campo opcional, no hay valor por defecto y no hay «suficientemente bueno».
//
// La razón es la que el tren 4.3 aprendió midiendo: R6a se archivó como MINOR
// porque el argumento era «la base ya es segura», y R6b porque «no hay
// llamantes». Los dos eran falsos, y los dos habrían pasado cualquier gate que
// aceptara una afirmación en vez de una medición. Así que este gate no acepta
// afirmaciones: acepta CONTEOS y BOOLEANOS que sólo una ejecución real puede
// producir, y la batería que los produce lleva un control negativo por campo.

/** Las siete categorías que `operation_tickets_category_check` admite. */
export const REQUIRED_CATEGORIES = [
  'grounded_query',
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
] as const

/**
 * Los eventos que una ejecución multicategoría TIENE que haber emitido.
 *
 * No es la lista completa de `TICKET_LIFECYCLE_EVENT_NAMES`: `operation_ticket_expired`
 * y los cuatro `grounded_query_*` son alcanzables pero no obligatorios en un
 * recorrido feliz, y exigirlos convertiría el gate en una prueba de que la
 * batería hizo un rodeo concreto en vez de una prueba de la propiedad.
 */
export const REQUIRED_EVENTS = [
  'operation_ticket_issued',
  'operation_ticket_bound',
  'quota_reservation_created',
  'quota_reservation_converted',
  'quota_consumed',
] as const

/** El número de funciones gobernadas que la cadena 0013…0018 deja instaladas. */
export const GOVERNED_FUNCTION_COUNT = 8

/**
 * Lo que una ejecución real tiene que reportar.
 *
 * Cada campo se corresponde con un caso obligatorio de la fase 4, y ninguno es
 * derivable de otro: un informe que sólo contase filas no podría distinguir «un
 * cargo por operación» de «un cargo por reintento», y uno que sólo contase
 * rechazos no podría distinguir «rechazado» de «rechazado ANTES de ejecutar».
 */
export interface MulticategoryQuotaEvidence {
  /** Categorías cuyo runtime real completó al menos una operación. */
  readonly categoriesReached: readonly string[]
  /** Filas de `stella_interactions` leídas por la SEGUNDA conexión. */
  readonly ledgerRowsInspected: number
  /** Cada fila lleva la organización, el proyecto y la identidad esperados. */
  readonly ledgerAttributionCorrect: boolean
  /** Una hermana fue rechazada por una reserva viva de otra categoría. */
  readonly siblingReservationRejected: boolean
  /** …y su ejecutor de dominio NUNCA llegó a invocarse. */
  readonly siblingNeverExecuted: boolean
  /** La reserva de un actor es visible para otro de la misma organización. */
  readonly crossActorVisibility: boolean
  /** Dos proyectos de una organización comparten el límite y cobran al suyo. */
  readonly crossProjectSharedPool: boolean
  /** Un ticket de otra categoría fue rechazado. */
  readonly categoryBindingRejected: boolean
  /** Un ticket de otro proyecto/organización/actor fue rechazado. */
  readonly scopeBindingRejected: boolean
  /** Ninguno de esos ataques movió el ledger. */
  readonly attacksChargedNothing: boolean
  /** Un reintento del mismo ticket no creó fila. */
  readonly retryChargedNothing: boolean
  /** Una operación nueva sí la creó. */
  readonly newOperationCharged: boolean
  /** Un fallo posterior a `bind` abortó sin cobrar. */
  readonly abortChargedNothing: boolean
  /** Una reserva expirada dejó de contar sin cron. */
  readonly expirationReleased: boolean
  /** Una reserva viva de otro periodo siguió contando, sin doble conteo. */
  readonly periodConsistent: boolean
  /** Toda escritura directa del ledger fue rechazada. */
  readonly directWriteRejected: boolean
  /** Ninguna superficie de consumo sin ticket es alcanzable por el runtime. */
  readonly unticketedConsumptionRejected: boolean
  /** Funciones en `uellix_stella_ops`, leídas del catálogo. */
  readonly governedFunctionCount: number
  /** Nombres de evento que el RUNTIME emitió durante la ejecución. */
  readonly observabilityEventsSeen: readonly string[]
  /** `Consumed + LiveReserved <= Limit` se sostuvo tras cada escenario. */
  readonly invariantHeld: boolean
  /**
   * La base que produjo esta evidencia es DESECHABLE y está aislada.
   *
   * NO dice «el contenedor fue destruido»: eso ocurre DESPUÉS de que el proceso
   * que construye este informe termine, así que ninguna medición hecha aquí
   * puede afirmarlo — lo señaló la revisión adversarial B, y tenía razón. Lo que
   * este campo afirma es lo que sí es medible desde dentro: que la conexión
   * apunta al contenedor efímero en loopback, y que el guion que la levantó
   * instaló su trap de destrucción antes de invocar la batería.
   *
   * La destrucción REAL y la ausencia de volúmenes las afirma el §6 de
   * `scripts/stella-multicategory-quota-e2e.sh`, que es el único punto de la
   * ejecución que puede verlas, y su fallo aborta el guion sea cual sea el
   * veredicto de la batería.
   */
  readonly disposableDatabaseGuarded: boolean
}

/**
 * Las claves del informe, como DATO.
 *
 * La batería las recorre para construir un control negativo por campo. Escrita
 * aquí y no allí para que un campo añadido al informe sin control negativo sea
 * un fallo de `tests/cross-workstream/multicategory-quota.test.ts` en vez de un
 * hueco silencioso.
 */
export const MULTICATEGORY_EVIDENCE_KEYS = [
  'categoriesReached',
  'ledgerRowsInspected',
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
  'governedFunctionCount',
  'observabilityEventsSeen',
  'invariantHeld',
  'disposableDatabaseGuarded',
] as const satisfies readonly (keyof MulticategoryQuotaEvidence)[]

export interface MulticategoryQuotaVerdict {
  readonly verified: boolean
  /** Vacío si y sólo si `verified` es true. Una razón por campo insuficiente. */
  readonly reasons: readonly string[]
}

/**
 * El veredicto, como función pura del informe.
 *
 * Devuelve TODAS las razones y no la primera: un informe con tres huecos y una
 * sola razón lleva a taparlos de uno en uno, y cada vuelta parece progreso.
 */
export function evaluateMulticategoryQuotaGate(
  evidence: MulticategoryQuotaEvidence,
): MulticategoryQuotaVerdict {
  const reasons: string[] = []

  const missingCategories = REQUIRED_CATEGORIES.filter(
    (c) => !evidence.categoriesReached?.includes(c),
  )
  if (missingCategories.length > 0) {
    reasons.push(
      `categorías sin runtime real ejecutado: ${missingCategories.join(', ')} — el gate mide que TODAS comparten la capacidad, y una ausente es precisamente la que podría no compartirla`,
    )
  }

  if (!(evidence.ledgerRowsInspected >= REQUIRED_CATEGORIES.length)) {
    reasons.push(
      `sólo se inspeccionaron ${evidence.ledgerRowsInspected ?? 0} filas del ledger; hacen falta al menos ${REQUIRED_CATEGORIES.length}, una por categoría`,
    )
  }

  const BOOLEANS: readonly (readonly [keyof MulticategoryQuotaEvidence, string])[] = [
    ['ledgerAttributionCorrect', 'alguna fila del ledger no lleva la organización, el proyecto o la identidad esperados'],
    ['siblingReservationRejected', 'ninguna hermana fue rechazada por una reserva viva de otra categoría — R1 no se midió'],
    ['siblingNeverExecuted', 'la hermana rechazada llegó a ejecutar su trabajo: el rechazo no fue gratuito'],
    ['crossActorVisibility', 'la reserva de un actor no resultó visible para otro de la misma organización (R1b)'],
    ['crossProjectSharedPool', 'no se midió que dos proyectos de una organización comparten límite y cobran al suyo'],
    ['categoryBindingRejected', 'no se midió el rechazo de un ticket de otra categoría (R6a)'],
    ['scopeBindingRejected', 'no se midió el rechazo de un ticket fuera de scope (R2-INT)'],
    ['attacksChargedNothing', 'algún ataque de categoría o de scope movió el ledger'],
    ['retryChargedNothing', 'un reintento del mismo ticket creó una fila'],
    ['newOperationCharged', 'una operación nueva no fue cobrada — la idempotencia se volvió supresión'],
    ['abortChargedNothing', 'un fallo posterior a bind dejó un cargo'],
    ['expirationReleased', 'una reserva expirada siguió contando'],
    ['periodConsistent', 'la transición de periodo produjo doble conteo o dejó de contar una reserva viva'],
    ['directWriteRejected', 'alguna escritura directa del ledger fue aceptada (R6-INT)'],
    ['unticketedConsumptionRejected', 'el runtime alcanza una superficie de consumo sin ticket (R6b)'],
    ['invariantHeld', 'Consumed + LiveReserved superó Limit en algún punto de la ejecución'],
    ['disposableDatabaseGuarded', 'la evidencia no se tomó contra una base desechable aislada: la siguiente ejecución heredaría el mundo de ésta'],
  ]
  for (const [key, why] of BOOLEANS) {
    if (evidence[key] !== true) reasons.push(why)
  }

  if (evidence.governedFunctionCount !== GOVERNED_FUNCTION_COUNT) {
    reasons.push(
      `uellix_stella_ops tiene ${evidence.governedFunctionCount ?? 0} funciones y la cadena 0013…0018 deja ${GOVERNED_FUNCTION_COUNT}: la evidencia no se tomó sobre la cadena completa`,
    )
  }

  const missingEvents = REQUIRED_EVENTS.filter((e) => !evidence.observabilityEventsSeen?.includes(e))
  if (missingEvents.length > 0) {
    reasons.push(
      `eventos de runtime ausentes: ${missingEvents.join(', ')} — sin ellos no hay traza de que la reserva se creara y se convirtiera`,
    )
  }

  return { verified: reasons.length === 0, reasons }
}
