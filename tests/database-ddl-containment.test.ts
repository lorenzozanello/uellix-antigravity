// tests/database-ddl-containment.test.ts
//
// WHAT THE RUNTIME CANNOT DO.
//
// The reaudit that triggered this cutover
// (STELLA_DATABASE_PRIVILEGE_REAUDIT_BLOCKED_DDL_ESCALATION) demonstrated a
// working escalation chain from the runtime role to `uellix_owner`, and the
// creation of a SECURITY DEFINER function callable by `anon`. Both were
// possible because the runtime was `postgres`.
//
// Each operation below is one link of that chain, executed with the REAL
// runtime credential and expected to fail with SQLSTATE 42501
// (insufficient_privilege). Testing the error CODE rather than the message
// matters: a message can change with a PostgreSQL release, and a test that
// matched on text would start passing for the wrong reason — or begin failing
// while the property still held.
//
// Everything runs inside a transaction that is rolled back, so an operation
// that unexpectedly SUCCEEDS still leaves nothing behind.

import { describe, it, expect } from 'vitest'
import { RUNTIME_CONNECTION, runtimeSql } from './helpers/local-runtime'
import { OWNER_DATABASE_ROLE, RUNTIME_DATABASE_ROLE } from '@/db/safety/database-role'

const LIVE = RUNTIME_CONNECTION.available
const INSUFFICIENT_PRIVILEGE = '42501'

/**
 * Run one forbidden statement and return its SQLSTATE.
 *
 * `'ALLOWED'` is returned rather than thrown so the assertion reads as a
 * comparison and the failure output names the operation.
 */
async function attempt(statement: string): Promise<string> {
  try {
    await runtimeSql.begin(async (tx) => {
      await tx.unsafe(statement)
      throw Object.assign(new Error('allowed'), { allowed: true })
    })
    return 'ALLOWED'
  } catch (error) {
    if ((error as { allowed?: boolean }).allowed === true) return 'ALLOWED'
    const code = (error as { code?: string }).code
    return code ?? `unknown:${(error as Error).message}`
  }
}

describe.skipIf(!LIVE)(
  `DDL containment for ${RUNTIME_DATABASE_ROLE} (stack ${LIVE ? 'reachable' : 'unreachable'})`,
  () => {
    it.each([
      ['ALTER ROLE owner LOGIN', `ALTER ROLE ${OWNER_DATABASE_ROLE} LOGIN`],
      ['ALTER ROLE owner PASSWORD', `ALTER ROLE ${OWNER_DATABASE_ROLE} PASSWORD 'x'`],
      ['ALTER ROLE self BYPASSRLS', `ALTER ROLE ${RUNTIME_DATABASE_ROLE} BYPASSRLS`],
      ['ALTER ROLE self CREATEROLE', `ALTER ROLE ${RUNTIME_DATABASE_ROLE} CREATEROLE`],
      ['SET ROLE owner', `SET ROLE ${OWNER_DATABASE_ROLE}`],
      ['CREATE TABLE in public', 'CREATE TABLE public.ddl_probe_tbl (id int)'],
      [
        'CREATE FUNCTION in public',
        'CREATE FUNCTION public.ddl_probe_fn() RETURNS int LANGUAGE sql AS $x$ SELECT 1 $x$',
      ],
      [
        'CREATE SECURITY DEFINER function',
        'CREATE FUNCTION public.ddl_probe_sd() RETURNS int LANGUAGE sql SECURITY DEFINER ' +
          'AS $x$ SELECT 1 $x$',
      ],
      ['DROP POLICY', 'DROP POLICY projects_select_member_or_admin ON public.projects'],
      ['DISABLE ROW LEVEL SECURITY', 'ALTER TABLE public.projects DISABLE ROW LEVEL SECURITY'],
      [
        'DISABLE TRIGGER',
        'ALTER TABLE public.stella_interactions DISABLE TRIGGER trg_stella_interactions_append_only',
      ],
      ['session_replication_role = replica', "SET session_replication_role = 'replica'"],
      ['TRUNCATE an append-only table', 'TRUNCATE public.stella_interactions'],
      ['DROP the owner role', `DROP ROLE ${OWNER_DATABASE_ROLE}`],
      ['GRANT the owner role to self', `GRANT ${OWNER_DATABASE_ROLE} TO ${RUNTIME_DATABASE_ROLE}`],
    ])('%s is denied with 42501', async (_label, statement) => {
      expect(await attempt(statement)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('cannot create a schema to escape the public-schema restriction', async () => {
      expect(await attempt('CREATE SCHEMA ddl_probe_schema')).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('cannot reach the drizzle migration bookkeeping table', async () => {
      // Not 42501 necessarily — without USAGE on the schema PostgreSQL may
      // report 3F000 (invalid_schema_name) instead. Either is a denial; what
      // matters is that it is never ALLOWED.
      const outcome = await attempt('SELECT count(*) FROM drizzle.__drizzle_migrations')
      expect(outcome).not.toBe('ALLOWED')
    })

    it('the owner role remains NOLOGIN, so there is no credential to steal', async () => {
      const [row] = await runtimeSql<{ can_login: boolean }[]>`
        SELECT rolcanlogin AS can_login FROM pg_roles WHERE rolname = ${OWNER_DATABASE_ROLE}
      `
      expect(row.can_login).toBe(false)
    })
  }
)
