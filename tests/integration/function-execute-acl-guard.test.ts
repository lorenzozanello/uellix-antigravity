// MUST be the first import: fail-closed target gate that does not depend
// on which vitest config selected this file. See tests/integration/_guard.ts.
import './_guard'

// tests/integration/function-execute-acl-guard.test.ts
//
// COMMERCIAL_V1_POST_INTEGRATION_MAINTENANCE_AUTHORITY_v1.0.0.json (M2).
//
// Known PostgreSQL behaviour: `CREATE OR REPLACE FUNCTION` preserves an
// existing ACL, but `DROP FUNCTION` + `CREATE FUNCTION` resets it to the
// PostgreSQL default — which restores PUBLIC EXECUTE. Migration 0061
// (db/migrations/0061_fib_disposition_governance_function_execute_revocation.sql)
// revoked PUBLIC EXECUTE from two governed functions:
//   - public.uellix_guard_disposition_run_approval()
//   - public.uellix_lock_run_dispositions_on_approval()
// The existing postcondition B0-17-function-execute-grants
// (db/hosted/baseline-postconditions.ts) already detects a reopened ACL
// correctly — its probe uses `COALESCE(proacl, acldefault('f', proowner))`
// so a NULL ACL (the exact state DROP+CREATE produces) reads as PUBLIC
// EXECUTE, never as "no privilege". But until this test, B0-17 only ran via
// manual/certification paths (`pnpm baseline:rehearsal:local`,
// `pnpm b0:status:*`) — never through ordinary CI. `tests/hosted/checkpoint-
// b0.test.ts` exercises the SAME check function, but only against synthetic
// in-memory fixtures, never a real `pg_proc`.
//
// This file changes nothing about the check — it reuses B0_17.check() and
// B0_17.probeSql verbatim (imported, not re-implemented) — and runs it
// against the real disposable Postgres p1a-validation.yml already starts
// for `pnpm test:integration` on every ordinary pull request. That is the
// entire fix: getting a proven check onto a path CI already runs.
import { describe, it, expect, afterAll } from 'vitest'
import { createMigratorClient } from '@/db/migrator'
import { BASELINE_POSTCONDITIONS, type BaselineObservation, type ExpectedBaselineState } from '@/db/hosted/baseline-postconditions'
import { ownerRows } from './_owner'

const B0_17 = BASELINE_POSTCONDITIONS.find((p) => p.id === 'B0-17-function-execute-grants')
if (!B0_17) {
  throw new Error('B0-17-function-execute-grants postcondition not found in db/hosted/baseline-postconditions.ts — has it been renamed or removed?')
}

// B0-17's check() reads only `observed.functionGrants` (verified by reading
// its implementation) — every other BaselineObservation field is unused by
// this postcondition, so an empty placeholder is honest here, not a
// stand-in for a derivation this test never performs.
const EMPTY_EXPECTED: ExpectedBaselineState = { tables: [], functions: [], triggers: [], rlsEnabledTables: [], policies: [] }

function emptyObservationWith(functionGrants: readonly string[]): BaselineObservation {
  return {
    schemas: [],
    tables: [],
    columns: {},
    constraints: [],
    functions: [],
    triggers: [],
    rlsEnabledTables: [],
    policies: [],
    roles: [],
    grants: [],
    rowCounts: {},
    extensions: [],
    storageBuckets: [],
    storagePolicies: [],
    environmentSecretNames: null,
    functionGrants,
    journal: null,
  }
}

/** B0_17.probeSql is one unaliased computed column ("grantee:PRIVILEGE:schema.function"); Postgres names it `?column?`, so take the row's only value rather than a fixed key. */
function toFunctionGrants(rows: readonly Record<string, string>[]): string[] {
  return rows.map((r) => Object.values(r)[0])
}

const TARGET_FUNCTION = 'public.uellix_guard_disposition_run_approval'
const OTHER_PROTECTED_FUNCTION = 'public.uellix_lock_run_dispositions_on_approval'

describe('B0-17 function EXECUTE ACL guard — real PostgreSQL (M2)', () => {
  it('M2-P1: on the current corpus, PUBLIC/anon hold EXECUTE on NEITHER migration-0061-governed function', async () => {
    const rows = await ownerRows(B0_17.probeSql)
    const functionGrants = toFunctionGrants(rows)
    const observed = emptyObservationWith(functionGrants)

    const result = B0_17.check(observed, EMPTY_EXPECTED)
    expect(result.passed).toBe(true)

    for (const fn of [TARGET_FUNCTION, OTHER_PROTECTED_FUNCTION]) {
      expect(functionGrants).not.toContain(`PUBLIC:EXECUTE:${fn}`)
      expect(functionGrants).not.toContain(`anon:EXECUTE:${fn}`)
    }
  })

  describe('mutation controls — disposable transaction, ALWAYS rolled back, never committed', () => {
    let client: ReturnType<typeof createMigratorClient> | null = null

    afterAll(async () => {
      if (client) await client.close()
    })

    /** Thrown at the end of every mutation-control transaction to force `sql.begin` to roll back — see db/migrator.ts and tests/integration/_owner.ts for the same pattern. Never committed to the repository OR the database. */
    class DeliberateRollback extends Error {}

    it('M2-N1: a transient GRANT EXECUTE TO PUBLIC — the exact end-state a future DROP+CREATE without REVOKE would leave — makes B0-17 fail', async () => {
      if (!client) client = createMigratorClient()
      let functionGrants: string[] = []
      try {
        // DROP FUNCTION + CREATE FUNCTION resets the ACL to this same
        // PostgreSQL default (PUBLIC EXECUTE). Both functions are attached
        // trigger functions, so an exact DROP+CREATE here would CASCADE onto
        // their triggers; a direct GRANT reproduces the identical resulting
        // `proacl` state B0-17 observes — B0-17 is an END-STATE invariant,
        // it cannot distinguish "reset by DROP+CREATE" from "reset by
        // GRANT". The probe re-read happens INSIDE this same transaction so
        // it observes the uncommitted mutation before the rollback discards it.
        await client.sql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL ROLE uellix_owner')
          await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${TARGET_FUNCTION}() TO PUBLIC`)
          const rows = await tx.unsafe(B0_17!.probeSql)
          functionGrants = toFunctionGrants(rows as unknown as Record<string, string>[])
          throw new DeliberateRollback('M2-N1: never commit the reopened ACL')
        })
      } catch (err) {
        if (!(err instanceof DeliberateRollback)) throw err
      }

      expect(functionGrants).toContain(`PUBLIC:EXECUTE:${TARGET_FUNCTION}`)
      const result = B0_17.check(emptyObservationWith(functionGrants), EMPTY_EXPECTED)
      expect(result.passed).toBe(false)
      expect(result.detail).toContain(TARGET_FUNCTION)
    })

    it('M2-P2: an explicit REVOKE after the transient GRANT restores B0-17 to PASS, in the same transaction', async () => {
      if (!client) client = createMigratorClient()
      let functionGrants: string[] = []
      try {
        await client.sql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL ROLE uellix_owner')
          await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${TARGET_FUNCTION}() TO PUBLIC`)
          await tx.unsafe(`REVOKE EXECUTE ON FUNCTION ${TARGET_FUNCTION}() FROM PUBLIC`)
          const rows = await tx.unsafe(B0_17!.probeSql)
          functionGrants = toFunctionGrants(rows as unknown as Record<string, string>[])
          throw new DeliberateRollback('M2-P2: never commit, even though this state is conforming')
        })
      } catch (err) {
        if (!(err instanceof DeliberateRollback)) throw err
      }

      expect(functionGrants).not.toContain(`PUBLIC:EXECUTE:${TARGET_FUNCTION}`)
      const result = B0_17.check(emptyObservationWith(functionGrants), EMPTY_EXPECTED)
      expect(result.passed).toBe(true)
    })

    it('sanity: the rollback actually rolled back — a fresh read outside the transaction sees no PUBLIC EXECUTE on the target function', async () => {
      const rows = await ownerRows(B0_17.probeSql)
      const functionGrants = toFunctionGrants(rows)
      expect(functionGrants).not.toContain(`PUBLIC:EXECUTE:${TARGET_FUNCTION}`)
    })
  })
})
