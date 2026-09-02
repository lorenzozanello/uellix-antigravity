// tests/helpers/multicategory-gate-mutations.ts
//
// El catálogo de roturas deliberadas del gate multicategoría (tren 4.3c).
//
// Cada entrada nombra UNA propiedad del cierre, la edición que la quita, y el
// gate de `tests/helpers/multicategory-gate-gates.ts` que tiene que negarse.
// `tests/multicategory-gate-mutation.test.ts` las aplica a una copia en memoria
// — nada de aquí escribe en `tests/eval/**` ni en `tests/e2e/**`.
//
// Las tres reglas vienen de los cuatro catálogos anteriores:
//
//   1. Una mutación tiene que CAMBIAR el texto. Un anclaje obsoleto no coincide
//      con nada, produce una fuente sin mutar, y da una ejecución sin
//      violaciones que se lee como un aprobado.
//   2. No basta con que ALGO objetara. Tiene que dispararse el gate DUEÑO de la
//      propiedad, o el día que ese gate se debilite la suite seguirá verde
//      porque un espectador todavía se da cuenta.
//   3. Una mutación NO se detecta porque el resultado no compile. Detección
//      significa: un gate nombrado devolvió una violación, offline, del texto.
//
// IDS. K-127 en adelante, continuando los cuatro catálogos SQL y el de
// stella_0018 en vez de reiniciar — la suite afirma que los cinco conjuntos son
// disjuntos, así que «K-112» sólo puede significar una cosa.

import { GATE_MODULE, GATE_SUITE } from './multicategory-gate-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** La cláusula de la fase del cierre de la que viene la propiedad. */
  readonly clause: string
  readonly change: string
  readonly breaks: string
  readonly expectedGate: readonly string[]
  readonly apply: (source: string) => string
}

const sub = (from: string, to: string) => (source: string) => source.replace(from, () => to)

export const MULTICATEGORY_GATE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-127',
    file: GATE_MODULE,
    severity: 'CRITICAL',
    clause: 'FASE 9 — todas las categorías alcanzadas',
    change: 'una categoría desaparece de la lista que el gate exige',
    breaks:
      'El gate deja de mirar `audit_assistant` y una ejecución que nunca la tocó pasa a verificada. Es la forma exacta del defecto que este tren existe para cerrar: la propiedad es que TODAS las categorías comparten una capacidad, y la que no se mide es precisamente la que podría no compartirla.',
    expectedGate: ['gate-requires-every-category'],
    apply: sub("  'audit_assistant',\n] as const", '] as const'),
  },
  {
    id: 'K-128',
    file: GATE_MODULE,
    severity: 'CRITICAL',
    clause: 'FASE 6 — inspección del ledger',
    change: 'el gate deja de exigir filas de ledger inspeccionadas',
    breaks:
      'Un informe con cero filas inspeccionadas pasa. El gate volvería a decidir sobre códigos de retorno de las acciones —que es lo que la fase 6 prohíbe explícitamente— en vez de sobre filas COMMITEADAS leídas por una segunda conexión.',
    expectedGate: ['gate-requires-ledger-inspection'],
    apply: sub(
      '  if (!(evidence.ledgerRowsInspected >= REQUIRED_CATEGORIES.length)) {',
      '  if (false) {',
    ),
  },
  {
    id: 'K-129',
    file: GATE_MODULE,
    severity: 'CRITICAL',
    clause: 'FASE 4 (9) — el reintento no cobra',
    change: 'el gate deja de comprobar retryChargedNothing',
    breaks:
      'Un sistema en el que cada reintento acuña una unidad pasa el gate. La idempotencia es la mitad del contrato de identidad de operación —la otra es que una operación NUEVA sí cobre— y sin esta comprobación el informe puede decir cualquier cosa sobre ella.',
    expectedGate: ['gate-checks-every-field'],
    apply: sub(
      "    ['retryChargedNothing', 'un reintento del mismo ticket creó una fila'],\n",
      '',
    ),
  },
  {
    id: 'K-130',
    file: GATE_MODULE,
    severity: 'CRITICAL',
    clause: 'FASE 4 (10) — una operación nueva sí cobra',
    change: 'el gate deja de comprobar newOperationCharged',
    breaks:
      'La otra mitad, y la más silenciosa: un sistema que suprimiera TODO cargo pasaría los casos de reintento y de rechazo con nota perfecta. Sin este campo, «idempotente» y «no cobra nunca» son indistinguibles para el gate.',
    expectedGate: ['gate-checks-every-field'],
    apply: sub(
      "    ['newOperationCharged', 'una operación nueva no fue cobrada — la idempotencia se volvió supresión'],\n",
      '',
    ),
  },
  {
    id: 'K-131',
    file: GATE_MODULE,
    severity: 'CRITICAL',
    clause: 'FASE 4 (1-4) — la hermana rechazada no llega a ejecutar',
    change: 'el gate deja de comprobar siblingNeverExecuted',
    breaks:
      'Un rechazo que llega DESPUÉS de ejecutar sigue siendo un rechazo para el ledger y es trabajo regalado para la organización — exactamente la forma de R1 que dos paquetes se dedicaron a quitar. El campo `siblingReservationRejected` por sí solo no distingue «se negó» de «se negó tarde».',
    expectedGate: ['gate-checks-every-field'],
    apply: sub(
      "    ['siblingNeverExecuted', 'la hermana rechazada llegó a ejecutar su trabajo: el rechazo no fue gratuito'],\n",
      '',
    ),
  },
  {
    id: 'K-132',
    file: GATE_MODULE,
    severity: 'CRITICAL',
    clause: 'FASE 4 (15) — la escritura directa se prueba',
    change: 'el gate deja de comprobar directWriteRejected',
    breaks:
      'R6-INT vuelve a ser una afirmación. La aritmética de reservas es correcta sobre un número que cualquiera puede cambiar si el ledger tiene un escritor directo, y este campo es lo único del informe que dice que se intentó.',
    expectedGate: ['gate-checks-every-field'],
    apply: sub(
      "    ['directWriteRejected', 'alguna escritura directa del ledger fue aceptada (R6-INT)'],\n",
      '',
    ),
  },
  {
    id: 'K-133',
    file: GATE_MODULE,
    severity: 'MAJOR',
    clause: 'FASE 3 (14-15) — teardown y ausencia de residuos',
    change: 'el gate deja de comprobar disposableDatabaseGuarded',
    breaks:
      'Una batería que hubiera corrido contra un stack persistente pasaría el gate. La evidencia dejaría de ser reproducible: la siguiente ejecución heredaría el mundo de la anterior y mediría una base que nadie construyó, con filas de ledger y tickets que ningún escenario de esta batería creó.',
    expectedGate: ['gate-checks-every-field'],
    apply: sub(
      "    ['disposableDatabaseGuarded', 'la evidencia no se tomó contra una base desechable aislada: la siguiente ejecución heredaría el mundo de ésta'],\n",
      '',
    ),
  },
  {
    id: 'K-134',
    file: GATE_MODULE,
    severity: 'MAJOR',
    clause: 'FASE 7 — los eventos vienen del runtime',
    change: 'el gate deja de comprobar qué eventos se emitieron',
    breaks:
      'La observabilidad deja de ser evidencia y pasa a ser decoración: un informe con la lista vacía verifica igual, y la traza de que una reserva se creó y se convirtió —lo único que un operador puede leer en producción— ya no tiene quien la exija.',
    expectedGate: ['gate-requires-runtime-events'],
    apply: sub(
      '  const missingEvents = REQUIRED_EVENTS.filter((e) => !evidence.observabilityEventsSeen?.includes(e))',
      '  const missingEvents: string[] = []',
    ),
  },
  {
    id: 'K-135',
    file: GATE_MODULE,
    severity: 'MAJOR',
    clause: 'FASE 9 — fail-closed',
    change: 'el veredicto deja de ser la conjunción de las razones',
    breaks:
      'El gate devuelve `verified: true` con razones pendientes. Todas las comprobaciones siguen ahí, todas siguen produciendo su mensaje, y ninguna decide nada — que es la forma más difícil de ver de un gate roto, porque los informes de fallo siguen siendo correctos.',
    expectedGate: ['gate-fail-closed'],
    apply: sub(
      '  return { verified: reasons.length === 0, reasons }',
      '  return { verified: true, reasons }',
    ),
  },
  {
    id: 'K-136',
    file: GATE_SUITE,
    severity: 'CRITICAL',
    clause: 'FASE 9 — cada campo con evidencia MEDIDA',
    change: 'la batería declara `directWriteRejected: true` en vez de medirlo',
    breaks:
      'La tautología que este tren archivó dos veces como MINOR, escrita en una línea: el gate exige el campo, la batería lo afirma, y entre los dos no hay ninguna medición. Es exactamente lo que la primera versión de este bloque hacía con nueve campos.',
    expectedGate: ['suite-measures-every-field'],
    apply: sub('      directWriteRejected,\n', '      directWriteRejected: true,\n'),
  },
  {
    id: 'K-137',
    file: GATE_SUITE,
    severity: 'CRITICAL',
    clause: 'FASE 7 — los eventos proceden del runtime ejecutado',
    change: 'la batería deja de capturar lo que el emisor escribe',
    breaks:
      'Los eventos del informe pasarían a venir de donde sea que quede la lista — de un fixture, de un modelo, de nada. La fase 7 lo dice sin rodeos: la evidencia debe venir del runtime, no del evaluador, y ésta es la única línea del arnés que lo garantiza.',
    expectedGate: ['suite-captures-runtime-events'],
    apply: sub("args[0] === '[stella-ticket]'", "args[0] === '[never-emitted]'"),
  },
  {
    id: 'K-138',
    file: GATE_SUITE,
    severity: 'MAJOR',
    clause: 'FASE 9 — un control negativo por campo',
    change: 'la batería deja de recorrer las claves del informe',
    breaks:
      'El gate se queda sin la prueba de que cada campo es portante. Un campo que nadie comprueba —o uno que el evaluador dejó de mirar, como hacen K-129 a K-133— pasaría desapercibido: la evidencia completa seguiría verificando y nadie mediría qué pasa al retirarla.',
    expectedGate: ['suite-has-negative-controls'],
    // TODAS las apariciones: el import y el bucle. Sustituir sólo la primera
    // dejaría el bucle en pie y el mutante se leería como muerto mientras la
    // propiedad sigue ahí.
    apply: (source) => source.split('MULTICATEGORY_EVIDENCE_KEYS').join('EVIDENCE_KEYS_REMOVED'),
  },
]
