// tests/database-runtime-rls.test.ts
//
// DOES ROW-LEVEL SECURITY ACTUALLY CONSTRAIN THE RUNTIME?
//
// Connecting as `uellix_app` makes RLS apply. It does not make RLS work: with
// no claims set, `auth.uid()` is NULL and every policy evaluates false, so the
// application connects fine and sees nothing. The identity context
// (db/identity-context.ts) is what closes that gap, and this file is where the
// closing is checked against real rows.
//
// The four states that matter, all exercised below:
//
//   no context      -> zero rows (fail closed, not fail open)
//   valid context   -> exactly the caller's own organisation
//   foreign context -> zero rows
//   forged claim    -> refused before any query runs
//
// Every write runs inside a transaction that ends in ROLLBACK. Nothing here
// leaves a row behind, which is why it is safe to run against the rehearsal
// stack that holds the 1 synthetic decision and 2 synthetic interactions.

import { describe, it, expect, beforeAll } from 'vitest'
import { sql as drizzleSql } from 'drizzle-orm'
import {
  withDatabaseIdentityContext,
  getBoundDatabaseContext,
  IdentityContextError,
} from '@/db/identity-context'
import { db } from '@/db/client'
import {
  RUNTIME_CONNECTION,
  runtimeSql,
  readRlsFixture,
  type RlsFixture,
} from './helpers/local-runtime'

const LIVE = RUNTIME_CONNECTION.available

let fixture: RlsFixture | null = null

beforeAll(async () => {
  if (LIVE) fixture = await readRlsFixture()
})

async function captureCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error instanceof IdentityContextError ? error.code : `unexpected:${String(error)}`
  }
}

/* -------------------------------------------------------------------------- */
/* Offline: input validation                                                  */
/* -------------------------------------------------------------------------- */

describe('withDatabaseIdentityContext — malformed identity never reaches the database', () => {
  it('refuses a userId that is not a UUID', async () => {
    const code = await captureCode(() =>
      withDatabaseIdentityContext(
        { userId: 'not-a-uuid', organizationId: null, isSuperAdmin: false },
        async () => null
      )
    )
    expect(code).toBe('DB_IDENTITY_INVALID_USER_ID')
  })

  it('refuses an organizationId that is not a UUID', async () => {
    const code = await captureCode(() =>
      withDatabaseIdentityContext(
        {
          userId: '00000000-0000-4000-8000-000000000000',
          organizationId: 'drop table users',
          isSuperAdmin: false,
        },
        async () => null
      )
    )
    expect(code).toBe('DB_IDENTITY_INVALID_ORGANIZATION_ID')
  })

  it('does not echo the rejected identifier in the error', async () => {
    try {
      await withDatabaseIdentityContext(
        { userId: 'leaky-value-12345', organizationId: null, isSuperAdmin: false },
        async () => null
      )
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as Error).message).not.toContain('leaky-value-12345')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Live                                                                       */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('live RLS behaviour as uellix_app', () => {
  it('has a fixture to work with', () => {
    expect(fixture, 'no active organization_admin membership in the local stack').not.toBeNull()
  })

  it('WITHOUT a context, the shared client sees zero rows — it does not see everything', async () => {
    // The pre-cutover behaviour of this exact query was "every row in the
    // table", because the connection was `postgres`. Fail-closed is the whole
    // difference.
    expect(getBoundDatabaseContext()).toBeUndefined()

    const [{ count }] = await runtimeSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.organizations
    `
    expect(count).toBe('0')
  })

  it('WITH a valid context, sees its own organisation and no other', async () => {
    const f = fixture!
    const visible = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        const rows = await boundDb.execute<{ id: string }>(
          drizzleSql`SELECT id::text AS id FROM organizations`
        )
        return rows as unknown as { id: string }[]
      }
    )

    expect(visible.length).toBeGreaterThan(0)
    expect(visible.every((row) => row.id === f.organizationId)).toBe(true)
  })

  it('the ambient `db` export resolves to the bound transaction inside a context', async () => {
    const f = fixture!
    const seen = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async () => {
        // Deliberately NOT the handle the callback was given: this is the
        // import that 115 modules already use.
        const rows = await db.execute<{ id: string }>(
          drizzleSql`SELECT id::text AS id FROM organizations`
        )
        return rows as unknown as { id: string }[]
      }
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((row) => row.id === f.organizationId)).toBe(true)
  })

  it('refuses an organisation the user is not a member of (cross-org)', async () => {
    const f = fixture!
    if (f.otherOrganizationId === null) return
    const code = await captureCode(() =>
      withDatabaseIdentityContext(
        { userId: f.userId, organizationId: f.otherOrganizationId, isSuperAdmin: false },
        async () => null
      )
    )
    expect(code).toBe('DB_IDENTITY_ORGANIZATION_NOT_A_MEMBER')
  })

  it('refuses an inflated super-admin claim', async () => {
    const f = fixture!
    const code = await captureCode(() =>
      withDatabaseIdentityContext(
        { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: true },
        async () => null
      )
    )
    expect(code).toBe('DB_IDENTITY_SUPER_ADMIN_CLAIM_REJECTED')
  })

  it('a well-formed but unknown user sees nothing', async () => {
    const rows = await withDatabaseIdentityContext(
      {
        userId: '00000000-0000-4000-8000-000000000000',
        organizationId: null,
        isSuperAdmin: false,
      },
      async (boundDb) => {
        const result = await boundDb.execute<{ count: string }>(
          drizzleSql`SELECT count(*)::text AS count FROM organizations`
        )
        return result as unknown as { count: string }[]
      }
    )
    expect(rows[0].count).toBe('0')
  })

  it('refuses to nest a DIFFERENT identity inside an open context', async () => {
    const f = fixture!
    const code = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async () =>
        captureCode(() =>
          withDatabaseIdentityContext(
            {
              userId: '00000000-0000-4000-8000-000000000000',
              organizationId: null,
              isSuperAdmin: false,
            },
            async () => null
          )
        )
    )
    expect(code).toBe('DB_IDENTITY_NESTED_MISMATCH')
  })

  it('re-entering with the SAME identity reuses the open transaction', async () => {
    const f = fixture!
    const identity = { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false }
    const same = await withDatabaseIdentityContext(identity, async (outer) =>
      withDatabaseIdentityContext(identity, async (inner) => inner === outer)
    )
    expect(same).toBe(true)
  })

  it('the context does NOT survive on the pooled connection after the callback', async () => {
    const f = fixture!
    await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async () => null
    )

    // Same pool, next query, no context: the claim must be gone. A
    // session-scoped setting here would be a cross-tenant leak with no code
    // path to blame it on.
    const [row] = await runtimeSql<{ claims: string | null }[]>`
      SELECT nullif(current_setting('request.jwt.claims', true), '') AS claims
    `
    expect(row.claims).toBeNull()
    expect(getBoundDatabaseContext()).toBeUndefined()
  })

  it('rolls back — and clears the claim — when the callback throws', async () => {
    const f = fixture!
    await expect(
      withDatabaseIdentityContext(
        { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
        async () => {
          throw new Error('boom')
        }
      )
    ).rejects.toThrow('boom')

    const [row] = await runtimeSql<{ claims: string | null }[]>`
      SELECT nullif(current_setting('request.jwt.claims', true), '') AS claims
    `
    expect(row.claims).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Live: writes                                                               */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('live write paths as uellix_app (all rolled back)', () => {
  it('allows operational DML inside the caller’s organisation', async () => {
    const f = fixture!
    const inserted = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        const rows = await boundDb.execute<{ ok: boolean }>(drizzleSql`
          INSERT INTO projects (organization_id, name, status, created_by)
          VALUES (${f.organizationId}::uuid, 'rls-suite-probe', 'draft', ${f.userId}::uuid)
          RETURNING (id IS NOT NULL) AS ok
        `)
        const result = (rows as unknown as { ok: boolean }[])[0]
        // Undo inside the same transaction the context opened, so the assertion
        // below runs on state this test created and nothing survives.
        await boundDb.execute(drizzleSql`DELETE FROM projects WHERE name = 'rls-suite-probe'`)
        return result.ok
      }
    )
    expect(inserted).toBe(true)
  })

  it('allows an append-only INSERT that stella_0005 made possible', async () => {
    const f = fixture!
    const ok = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        const project = await boundDb.execute<{ id: string }>(
          drizzleSql`SELECT id::text AS id FROM projects LIMIT 1`
        )
        const projectId = (project as unknown as { id: string }[])[0]?.id
        if (projectId === undefined) return null

        const rows = await boundDb.execute<{ ok: boolean }>(drizzleSql`
          INSERT INTO stella_interactions
            (organization_id, project_id, created_by, stella_role, pipeline_step,
             context_hash, response_json)
          VALUES (${f.organizationId}::uuid, ${projectId}::uuid, ${f.userId}::uuid,
                  'advisor', 'rls-suite-probe', repeat('b', 64), '{}'::jsonb)
          RETURNING (id IS NOT NULL) AS ok
        `)
        const result = (rows as unknown as { ok: boolean }[])[0].ok
        // An append-only table cannot be cleaned up with DELETE — the trigger
        // refuses it. The whole transaction is abandoned instead.
        throw Object.assign(new Error('rollback'), { probeResult: result })
      }
    ).catch((error: unknown) => (error as { probeResult?: boolean }).probeResult ?? null)

    if (ok === null) return
    expect(ok).toBe(true)
  })

  it('refuses to attribute an append-only row to another user', async () => {
    const f = fixture!
    const outcome = await withDatabaseIdentityContext(
      { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
      async (boundDb) => {
        const project = await boundDb.execute<{ id: string }>(
          drizzleSql`SELECT id::text AS id FROM projects LIMIT 1`
        )
        const projectId = (project as unknown as { id: string }[])[0]?.id
        if (projectId === undefined) return 'no-fixture'

        try {
          await boundDb.execute(drizzleSql`
            INSERT INTO stella_interactions
              (organization_id, project_id, created_by, stella_role, pipeline_step,
               context_hash, response_json)
            VALUES (${f.organizationId}::uuid, ${projectId}::uuid,
                    '00000000-0000-4000-8000-000000000000'::uuid,
                    'advisor', 'rls-suite-forgery', repeat('c', 64), '{}'::jsonb)
          `)
          return 'ALLOWED'
        } catch {
          return 'denied'
        }
      }
    ).catch(() => 'denied')

    if (outcome === 'no-fixture') return
    expect(outcome).toBe('denied')
  })

  it('blocks UPDATE and DELETE on append-only tables', async () => {
    for (const statement of [
      drizzleSql`UPDATE stella_interactions SET model_used = 'x'`,
      drizzleSql`DELETE FROM stella_interactions`,
    ]) {
      const f = fixture!
      const outcome = await withDatabaseIdentityContext(
        { userId: f.userId, organizationId: f.organizationId, isSuperAdmin: false },
        async (boundDb) => {
          try {
            await boundDb.execute(statement)
            return 'ALLOWED'
          } catch {
            return 'denied'
          }
        }
      ).catch(() => 'denied')
      expect(outcome).toBe('denied')
    }
  })
})
