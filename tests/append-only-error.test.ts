import { describe, it, expect } from 'vitest'
import {
  MAX_CAUSE_DEPTH,
  assertAppendOnlyRejection,
  expectAppendOnlyRejection,
  findPostgresError,
} from './helpers/append-only-error'

/**
 * Réplica de la forma real que produce drizzle-orm 0.45.2 sobre postgres-js
 * 3.4.9: el wrapper no lleva `code` y el error de PostgreSQL cuelga de `.cause`.
 */
function drizzleQueryError(cause: unknown): Error {
  const error = new Error("Failed query: UPDATE public.stella_interactions SET x = 1\nparams: ")
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', name: 'PostgresError' })
}

const UPDATE_ON_INTERACTIONS = {
  operation: 'UPDATE',
  table: 'stella_interactions',
} as const

describe('findPostgresError', () => {
  it('encuentra el error de PostgreSQL detrás del wrapper de drizzle', () => {
    const pg = postgresError('42501', 'append-only: UPDATE on stella_interactions is not permitted')
    expect(findPostgresError(drizzleQueryError(pg))).toEqual({
      code: '42501',
      message: 'append-only: UPDATE on stella_interactions is not permitted',
    })
  })

  it('atraviesa causas anidadas a varios niveles', () => {
    const pg = postgresError('42501', 'append-only: DELETE on stella_interactions is not permitted')
    const nested = drizzleQueryError(drizzleQueryError(pg))
    expect(findPostgresError(nested).code).toBe('42501')
  })

  it('lanza si el error no tiene ninguna causa con SQLSTATE', () => {
    expect(() => findPostgresError(new Error('boom'))).toThrow(/no expone ninguna causa de PostgreSQL/)
  })

  it('lanza si la cadena de causas es circular', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(() => findPostgresError(a)).toThrow(/circular/)
  })

  it('lanza si la cadena de causas es excesivamente profunda', () => {
    let chain: unknown = new Error('hoja sin code')
    for (let i = 0; i <= MAX_CAUSE_DEPTH + 2; i += 1) chain = drizzleQueryError(chain)
    expect(() => findPostgresError(chain)).toThrow(/profundidad máxima/)
  })
})

describe('assertAppendOnlyRejection', () => {
  it('acepta el rechazo real del trigger', () => {
    const error = drizzleQueryError(
      postgresError('42501', 'append-only: UPDATE on stella_interactions is not permitted'),
    )
    expect(() => assertAppendOnlyRejection(error, UPDATE_ON_INTERACTIONS)).not.toThrow()
  })

  it('rechaza un SQLSTATE distinto de 42501', () => {
    const error = drizzleQueryError(
      postgresError('23503', 'insert or update on table violates foreign key constraint'),
    )
    expect(() => assertAppendOnlyRejection(error, UPDATE_ON_INTERACTIONS)).toThrow(/se esperaba SQLSTATE 42501/)
  })

  it('rechaza un 42501 que NO viene del trigger append-only', () => {
    const error = drizzleQueryError(
      postgresError('42501', 'permission denied for table stella_interactions'),
    )
    expect(() => assertAppendOnlyRejection(error, UPDATE_ON_INTERACTIONS)).toThrow(
      /no proviene del trigger append-only/,
    )
  })

  it('rechaza una operación distinta de la esperada', () => {
    const error = drizzleQueryError(
      postgresError('42501', 'append-only: DELETE on stella_interactions is not permitted'),
    )
    expect(() => assertAppendOnlyRejection(error, UPDATE_ON_INTERACTIONS)).toThrow(
      /rechazara UPDATE y rechazó DELETE/,
    )
  })

  it('rechaza una tabla distinta de la esperada', () => {
    const error = drizzleQueryError(
      postgresError('42501', 'append-only: UPDATE on audit_logs is not permitted'),
    )
    expect(() => assertAppendOnlyRejection(error, UPDATE_ON_INTERACTIONS)).toThrow(
      /sobre stella_interactions y ocurrió sobre audit_logs/,
    )
  })

  it('rechaza un error sin causa', () => {
    expect(() => assertAppendOnlyRejection(new Error('Failed query: …'), UPDATE_ON_INTERACTIONS)).toThrow(
      /no expone ninguna causa de PostgreSQL/,
    )
  })
})

describe('expectAppendOnlyRejection', () => {
  it('pasa cuando la consulta es rechazada por el trigger', async () => {
    await expect(
      expectAppendOnlyRejection(
        () =>
          Promise.reject(
            drizzleQueryError(
              postgresError('42501', 'append-only: TRUNCATE on stella_suggestion_decisions is not permitted'),
            ),
          ),
        { operation: 'TRUNCATE', table: 'stella_suggestion_decisions' },
      ),
    ).resolves.toBeUndefined()
  })

  it('falla ruidosamente si la consulta NO es rechazada', async () => {
    await expect(
      expectAppendOnlyRejection(() => Promise.resolve('ok'), UPDATE_ON_INTERACTIONS),
    ).rejects.toThrow(/pero la consulta terminó con éxito/)
  })
})
