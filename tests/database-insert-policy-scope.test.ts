// tests/database-insert-policy-scope.test.ts
//
// WHO CAN APPEND TO THE APPEND-ONLY TABLES? (reaudit finding M1)
//
// stella_0005 created the two INSERT policies with no TO clause — TO PUBLIC.
// Combined with the pre-cutover `GRANT SELECT, INSERT ... TO authenticated,
// service_role` on `audit_logs` and `stella_interactions`, that let a caller
// holding a valid user JWT INSERT into both tables DIRECTLY through PostgREST,
// bypassing the application entirely. stella_0005c closes it with two
// independent layers:
//
//   1. the policies are scoped `TO uellix_app`;
//   2. the INSERT grants of `authenticated` and `service_role` are revoked
//      (service_role holds BYPASSRLS locally, so for it the grant IS the fence).
//
// This suite pins both layers using the canonical combination the closure
// mandate names: ACL, policy roles, WITH CHECK text, has_table_privilege, and
// direct probes as the runtime role. Every write ends in ROLLBACK.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sql as drizzleSql } from 'drizzle-orm'
import { withDatabaseIdentityContext } from '@/db/identity-context'
import {
  RUNTIME_CONNECTION,
  runtimeSql,
  readRlsFixture,
  type RlsFixture,
} from './helpers/local-runtime'

const LIVE = RUNTIME_CONNECTION.available
const ROOT = process.cwd()

const APPEND_ONLY_POLICIES = [
  ['audit_logs', 'audit_logs_insert_member_or_admin'],
  ['stella_interactions', 'stella_interactions_insert_member_or_admin'],
  ['stella_suggestion_decisions', 'stella_suggestion_decisions_insert_member_or_admin'],
] as const

/** The two tables that carried the stray PostgREST INSERT grants. */
const GRANT_SCOPED_TABLES = ['audit_logs', 'stella_interactions'] as const

let fixture: RlsFixture | null = null

beforeAll(async () => {
  if (LIVE) fixture = await readRlsFixture()
})

/* -------------------------------------------------------------------------- */
/* Offline: the prepared script says what this suite enforces                 */
/* -------------------------------------------------------------------------- */

describe('stella_0005c — the prepared script and its rollback exist and match', () => {
  const forward = readFileSync(
    path.join(ROOT, 'db', 'prepared', 'stella_0005c_runtime_policy_scope.sql'),
    'utf8'
  )
  const rollback = readFileSync(
    path.join(ROOT, 'db', 'prepared', 'stella_0005c_rollback.sql'),
    'utf8'
  )
  const decisions = readFileSync(
    path.join(ROOT, 'db', 'prepared', 'stella_0003_suggestion_decisions.sql'),
    'utf8'
  )
  const cutover = readFileSync(
    path.join(ROOT, 'db', 'prepared', 'stella_0005_runtime_cutover.sql'),
    'utf8'
  )
  const cutoverRollback = readFileSync(
    path.join(ROOT, 'db', 'prepared', 'stella_0005_rollback.sql'),
    'utf8'
  )

  it('rescopes only the two stella_0005 policies and preserves the canonical decision policy', () => {
    expect(forward.match(/FOR INSERT\s+TO uellix_app/g)).toHaveLength(2)
    expect(forward).not.toMatch(/DROP POLICY IF EXISTS stella_suggestion_decisions_insert_member_or_admin/)
    expect(forward).not.toMatch(/CREATE POLICY stella_suggestion_decisions_insert_member_or_admin/)
    expect(decisions).toMatch(/CREATE POLICY stella_suggestion_decisions_insert_member_or_admin[\s\S]*FOR INSERT\s+TO uellix_app/)
    expect(decisions).toMatch(/current_setting\('app\.organization_id', true\)::uuid/)
    expect(decisions).toMatch(/decided_by = auth\.uid\(\)/)
  })

  it('requires the unmodified decision contract before and after stella_0005', () => {
    for (const script of [cutover, cutoverRollback, forward, rollback]) {
      expect(script).toMatch(/stella_suggestion_decisions_insert_member_or_admin/)
      expect(script).toMatch(/polroles = ARRAY\['uellix_app'::regrole::oid\]/)
      expect(script).toMatch(/app\.organization_id/)
      expect(script).toMatch(/current_user_org_ids/)
      expect(script).toMatch(/auth\.uid\(\)/)
    }
  })

  it('revokes INSERT from authenticated and service_role on both tables', () => {
    for (const table of GRANT_SCOPED_TABLES) {
      expect(forward).toContain(`REVOKE INSERT ON public.${table} FROM authenticated;`)
      expect(forward).toContain(`REVOKE INSERT ON public.${table} FROM service_role;`)
    }
  })

  it('drops the NULL-actor branch for audit_logs', () => {
    // The forward script may MENTION the removed predicate in prose, but the
    // policy body itself must not carry it.
    const policyBody = forward.slice(forward.indexOf('CREATE POLICY audit_logs_insert_member_or_admin'))
    const upToSemicolon = policyBody.slice(0, policyBody.indexOf(';'))
    expect(upToSemicolon).toContain('actor_user_id = auth.uid()')
    expect(upToSemicolon).not.toContain('actor_user_id IS NULL')
  })

  it('grants nothing — it only revokes and rescopes', () => {
    expect(forward).not.toMatch(/^\s*GRANT /m)
  })

  it('the rollback restores only the two legacy policies and preserves the decision policy', () => {
    expect(rollback).toContain('GRANT INSERT ON public.audit_logs TO authenticated;')
    expect(rollback).toContain('GRANT INSERT ON public.stella_interactions TO service_role;')
    expect(rollback).toContain('actor_user_id IS NULL OR actor_user_id = auth.uid()')
    expect(rollback).not.toMatch(/DROP POLICY IF EXISTS stella_suggestion_decisions_insert_member_or_admin/)
    expect(rollback).not.toMatch(/CREATE POLICY stella_suggestion_decisions_insert_member_or_admin/)
    expect(rollback).toMatch(/polroles = ARRAY\['uellix_app'::regrole::oid\]/)
    expect(rollback).toMatch(/app\.organization_id/)
  })
})

/* -------------------------------------------------------------------------- */
/* Live: catalog state                                                        */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('live catalog — policy roles, ACL and effective privileges', () => {
  it.each(APPEND_ONLY_POLICIES)(
    '%s: the INSERT policy applies to uellix_app and to no one else',
    async (table, policy) => {
      const rows = await runtimeSql<{ roles: string }[]>`
        SELECT roles::text AS roles
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table} AND policyname = ${policy}
          AND cmd = 'INSERT'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].roles).toBe('{uellix_app}')
    }
  )

  it('audit_logs WITH CHECK binds the actor to the claims and accepts no NULL actor', async () => {
    const [row] = await runtimeSql<{ check: string }[]>`
      SELECT with_check AS check FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'audit_logs_insert_member_or_admin'
    `
    expect(row.check).toContain('actor_user_id = auth.uid()')
    expect(row.check).not.toContain('actor_user_id IS NULL')
    expect(row.check).toContain('current_user_org_ids')
  })

  it.each(GRANT_SCOPED_TABLES)(
    '%s: authenticated, anon, service_role and PUBLIC hold no effective INSERT',
    async (table) => {
      // has_table_privilege resolves through role membership, so an INSERT
      // reached via a granted intermediate role would still show up here.
      const [row] = await runtimeSql<
        { authenticated: boolean; anon: boolean; service_role: boolean; public_acl: boolean }[]
      >`
        SELECT
          has_table_privilege('authenticated', ${'public.' + table}, 'INSERT') AS authenticated,
          has_table_privilege('anon',          ${'public.' + table}, 'INSERT') AS anon,
          has_table_privilege('service_role',  ${'public.' + table}, 'INSERT') AS service_role,
          EXISTS (
            SELECT 1 FROM pg_class c
            CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
            WHERE c.oid = ${'public.' + table}::regclass AND acl.grantee = 0
          ) AS public_acl
      `
      expect(row.authenticated).toBe(false)
      expect(row.anon).toBe(false)
      // service_role carries BYPASSRLS in the local stack: for it the ABSENT
      // GRANT is the only fence, which is exactly why this must stay false.
      expect(row.service_role).toBe(false)
      expect(row.public_acl).toBe(false)
    }
  )

  it('the runtime keeps governed INSERT on all three tables, and no UPDATE/DELETE', async () => {
    const [row] = await runtimeSql<Record<string, boolean>[]>`
      SELECT
        has_table_privilege('uellix_app', 'public.audit_logs', 'INSERT')                  AS a,
        has_table_privilege('uellix_app', 'public.stella_interactions', 'INSERT')         AS b,
        has_table_privilege('uellix_app', 'public.stella_suggestion_decisions', 'INSERT') AS c,
        has_table_privilege('uellix_app', 'public.audit_logs', 'UPDATE')                  AS d,
        has_table_privilege('uellix_app', 'public.audit_logs', 'DELETE')                  AS e,
        has_table_privilege('uellix_app', 'public.stella_interactions', 'UPDATE')         AS f
    `
    expect(row.a).toBe(true)
    expect(row.b).toBe(true)
    expect(row.c).toBe(true)
    expect(row.d).toBe(false)
    expect(row.e).toBe(false)
    expect(row.f).toBe(false)
  })

  it('PostgREST reads survive: authenticated keeps SELECT on both tables', async () => {
    const [row] = await runtimeSql<{ a: boolean; b: boolean }[]>`
      SELECT
        has_table_privilege('authenticated', 'public.audit_logs', 'SELECT')          AS a,
        has_table_privilege('authenticated', 'public.stella_interactions', 'SELECT') AS b
    `
    expect(row.a).toBe(true)
    expect(row.b).toBe(true)
  })

  it('the policy inventory is still 107 — three replaced, none added or lost', async () => {
    const [row] = await runtimeSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_policies WHERE schemaname = 'public'
    `
    expect(row.count).toBe('107')
  })
})

/* -------------------------------------------------------------------------- */
/* Live: direct probes as the runtime role (all rolled back)                  */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('live probes as uellix_app — the governed path still works', () => {
  it('has a fixture to work with', () => {
    expect(fixture, 'no active membership in the local stack').not.toBeNull()
  })

  it('appends an audit row bound to the caller, inside a context (rolled back)', async () => {
    const f = fixture!
    const ok = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        const rows = await boundDb.execute<{ ok: boolean }>(drizzleSql`
          INSERT INTO audit_logs (organization_id, actor_user_id, entity_type, entity_id, action)
          VALUES (${f.organizationId}::uuid, ${f.userId}::uuid, 'test',
                  gen_random_uuid(), 'policy-scope-probe')
          RETURNING (id IS NOT NULL) AS ok
        `)
        const result = (rows as unknown as { ok: boolean }[])[0].ok
        // Append-only: no DELETE cleanup possible — abandon the transaction.
        throw Object.assign(new Error('rollback'), { probeResult: result })
      }
    ).catch((error: unknown) => (error as { probeResult?: boolean }).probeResult ?? null)
    expect(ok).toBe(true)
  })

  it('refuses an audit row with a NULL actor — the branch stella_0005c removed', async () => {
    const f = fixture!
    const outcome = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        try {
          await boundDb.execute(drizzleSql`
            INSERT INTO audit_logs (organization_id, actor_user_id, entity_type, entity_id, action)
            VALUES (${f.organizationId}::uuid, NULL, 'test', gen_random_uuid(), 'null-actor-probe')
          `)
          return 'ALLOWED'
        } catch {
          return 'denied'
        }
      }
    ).catch(() => 'denied')
    expect(outcome).toBe('denied')
  })

  it('refuses an audit row attributed to another user', async () => {
    const f = fixture!
    const outcome = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        try {
          await boundDb.execute(drizzleSql`
            INSERT INTO audit_logs (organization_id, actor_user_id, entity_type, entity_id, action)
            VALUES (${f.organizationId}::uuid, '00000000-0000-4000-8000-000000000000'::uuid,
                    'test', gen_random_uuid(), 'forged-actor-probe')
          `)
          return 'ALLOWED'
        } catch {
          return 'denied'
        }
      }
    ).catch(() => 'denied')
    expect(outcome).toBe('denied')
  })

  it('refuses every append with NO context — zero-claim inserts stay dead', async () => {
    // Outside a context auth.uid() is NULL, so the actor binding can never
    // hold. This is the query shape a forgotten wrapper would produce.
    let outcome: string
    try {
      await runtimeSql`
        INSERT INTO public.audit_logs (organization_id, actor_user_id, entity_type, entity_id, action)
        SELECT o.id, '00000000-0000-4000-8000-000000000000'::uuid, 'test', gen_random_uuid(), 'x'
        FROM public.organizations o LIMIT 1
      `
      outcome = 'ALLOWED'
    } catch {
      outcome = 'denied'
    }
    // With no claims the SELECT feeding the INSERT sees zero rows, so even a
    // "successful" statement writes nothing; a policy error is also fine.
    if (outcome === 'ALLOWED') {
      const [row] = await runtimeSql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM public.audit_logs WHERE action = 'x'
      `
      expect(row.count).toBe('0')
    } else {
      expect(outcome).toBe('denied')
    }
  })
})
