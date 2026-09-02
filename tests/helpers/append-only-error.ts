/**
 * Desenvoltura de errores de PostgreSQL para las pruebas de tablas append-only.
 *
 * Motivo (ensayo G3 local, 2026-08-01): `db.execute()` de drizzle-orm 0.45.2
 * lanza un `DrizzleQueryError` cuyo `.message` es literalmente
 * `"Failed query: <sql>\nparams: "`; el error real del driver (`PostgresError`
 * de postgres-js 3.4.9, con `code`, `severity` y el mensaje del trigger) queda
 * colgado en `.cause`. Una aserción del estilo
 * `expect(...).rejects.toThrow(/append-only/)` compara sólo contra `.message`,
 * así que **nunca** puede ver el mensaje del trigger y produce un rojo falso
 * aunque la base sí haya bloqueado la mutación.
 *
 * Forma real observada:
 *   depth 0  DrizzleQueryError  code=undefined  message="Failed query: …"
 *   depth 1  PostgresError      code="42501"    message="append-only: UPDATE on stella_interactions is not permitted"
 *
 * Este helper recorre la cadena `cause` de forma defensiva (profundidad
 * limitada + detección de ciclos) y exige de forma CONJUNTA el SQLSTATE, el
 * texto `append-only`, la operación y la tabla. No acepta cualquier 42501: un
 * `permission denied for table …` (mismo SQLSTATE, otra causa) es rechazado.
 */

/** Profundidad máxima de la cadena `cause` que se recorre antes de abortar. */
export const MAX_CAUSE_DEPTH = 10

/** Operaciones que los triggers `uellix_forbid_mutation()` rechazan. */
export type AppendOnlyOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'

export interface AppendOnlyRejectionSpec {
  /** Operación que se esperaba que el trigger rechazara. */
  operation: AppendOnlyOperation
  /** Tabla (sin esquema) sobre la que debía dispararse el trigger. */
  table: string
}

/** Subconjunto de `PostgresError` en el que se apoyan las aserciones. */
export interface PostgresErrorLike {
  code: string
  message: string
}

/**
 * El trigger formatea siempre `'append-only: % on % is not permitted'` con
 * `TG_OP` y `TG_TABLE_NAME` (ver `public.uellix_forbid_mutation()`).
 */
const APPEND_ONLY_MESSAGE = /^append-only:\s+([A-Z]+)\s+on\s+([A-Za-z0-9_]+)\s+is not permitted\b/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Recorre `error.cause` hasta encontrar el primer eslabón con un `code` de
 * SQLSTATE. Lanza si la cadena está vacía, es circular o es demasiado profunda:
 * un error sin causa reconocible es un hallazgo, no algo que tolerar.
 */
export function findPostgresError(error: unknown): PostgresErrorLike {
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!isObject(current)) break

    if (seen.has(current)) {
      throw new Error('append-only: la cadena de causas del error es circular')
    }
    seen.add(current)

    const { code, message } = current
    if (typeof code === 'string' && code.length > 0) {
      return { code, message: typeof message === 'string' ? message : '' }
    }

    current = current.cause
  }

  if (isObject(current)) {
    throw new Error(
      `append-only: la cadena de causas supera la profundidad máxima (${MAX_CAUSE_DEPTH})`,
    )
  }

  throw new Error(
    'append-only: el error no expone ninguna causa de PostgreSQL con SQLSTATE ' +
      '(se recorrió toda la cadena `cause` sin encontrar un `code`)',
  )
}

/**
 * Exige que `error` sea el rechazo de un trigger append-only para la operación
 * y la tabla indicadas. Verifica de forma conjunta SQLSTATE, texto, operación y
 * tabla — fallar cualquiera de los cuatro es un fallo de la aserción.
 */
export function assertAppendOnlyRejection(error: unknown, spec: AppendOnlyRejectionSpec): void {
  const pgError = findPostgresError(error)

  if (pgError.code !== '42501') {
    throw new Error(
      `append-only: se esperaba SQLSTATE 42501 (insufficient_privilege) y se recibió ` +
        `${pgError.code} — mensaje: ${pgError.message}`,
    )
  }

  if (!pgError.message.includes('append-only')) {
    throw new Error(
      `append-only: SQLSTATE 42501 correcto pero el mensaje no proviene del trigger ` +
        `append-only — mensaje: ${pgError.message}`,
    )
  }

  const match = APPEND_ONLY_MESSAGE.exec(pgError.message)
  if (!match) {
    throw new Error(
      `append-only: el mensaje no tiene la forma emitida por uellix_forbid_mutation() — ` +
        `mensaje: ${pgError.message}`,
    )
  }

  const [, operation, table] = match
  if (operation !== spec.operation) {
    throw new Error(
      `append-only: se esperaba que el trigger rechazara ${spec.operation} y rechazó ${operation}`,
    )
  }
  if (table !== spec.table) {
    throw new Error(
      `append-only: se esperaba el rechazo sobre ${spec.table} y ocurrió sobre ${table}`,
    )
  }
}

/**
 * Ejecuta `run()` y exige que sea rechazado por el trigger append-only descrito
 * en `spec`. Si la consulta tiene éxito, falla explícitamente: un append-only
 * que deja pasar la mutación es el peor resultado posible de este gate.
 */
export async function expectAppendOnlyRejection(
  run: () => Promise<unknown>,
  spec: AppendOnlyRejectionSpec,
): Promise<void> {
  let thrown: unknown
  let threw = false

  try {
    await run()
  } catch (error) {
    threw = true
    thrown = error
  }

  if (!threw) {
    throw new Error(
      `append-only: se esperaba que ${spec.operation} sobre ${spec.table} fuera rechazado, ` +
        'pero la consulta terminó con éxito',
    )
  }

  assertAppendOnlyRejection(thrown, spec)
}
