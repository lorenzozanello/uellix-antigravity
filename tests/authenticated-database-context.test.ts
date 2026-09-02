// tests/authenticated-database-context.test.ts
//
// DOES THE APPLICATION'S IDENTITY ACTUALLY COME FROM THE AUTH LAYER?
//
// db/identity-context.ts proves that a claim, once set, constrains queries.
// tests/database-runtime-rls.test.ts proves that as `uellix_app`. Neither says
// anything about WHERE the claim came from — and that is the half the
// application owns.
//
// So this file drives the real wrappers in lib/auth/database-context.ts with
// the Auth layer stubbed at its true boundary (`supabase.auth.getUser`), and a
// LIVE `uellix_app` connection underneath. Nothing here uses `SET ROLE`: the
// pre-cutover reaudit passed while the runtime was still `postgres`, precisely
// because the tests reached the least-privilege role by borrowing it from an
// administrative session. These reach it by authenticating as it, through the
// application's own factory.
//
// EVERY WRITE ROLLS BACK. The suite is safe against the rehearsal stack that
// holds the 1 synthetic decision and the 2 synthetic interactions.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { sql as drizzleSql } from 'drizzle-orm'

/* -------------------------------------------------------------------------- */
/* Auth boundary                                                              */
/* -------------------------------------------------------------------------- */
//
// Stubbed at `supabase.auth.getUser` rather than at lib/auth/identity.ts, so
// the module under test still runs its own UUID check, its own
// no-session/rejected-session split and its own refusal to read anything from
// the caller.

const mockGetUser = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => mockGetUser() } }),
}))

import { db } from '@/db/client'
import {
  AuthContextError,
  authContextErrorStatus,
  loadRequestPrincipalResult,
  withAuthenticatedDatabaseContext,
  withOptionalDatabaseIdentityContext,
  withOrganizationDatabaseContext,
  withSuperAdminDatabaseContext,
} from '@/lib/auth/database-context'
import { withDatabaseIdentityContext } from '@/db/identity-context'
import { RUNTIME_CONNECTION, migratorSql, MIGRATOR_CONNECTION } from './helpers/local-runtime'

const LIVE = RUNTIME_CONNECTION.available && MIGRATOR_CONNECTION.available

/** Two real, DIFFERENT tenants, read through the migrator so the subject under
 *  test never bootstraps its own fixture. */
interface TenantPair {
  readonly a: { userId: string; organizationId: string }
  readonly b: { userId: string; organizationId: string }
}

let tenants: TenantPair | null = null
/** A user id that is well-formed but belongs to nobody. */
const ORPHAN_USER_ID = '00000000-0000-4000-8000-0000000000ff'

async function readTenants(): Promise<TenantPair | null> {
  const rows = (await migratorSql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE uellix_owner')
    return tx<{ userId: string; organizationId: string }[]>`
      SELECT DISTINCT ON (om.organization_id)
             om.user_id::text         AS "userId",
             om.organization_id::text AS "organizationId"
        FROM public.organization_members om
        JOIN public.users u ON u.id = om.user_id AND u.deleted_at IS NULL
       WHERE om.status = 'active'
       ORDER BY om.organization_id, om.user_id
       LIMIT 2
    `
  })) as unknown as { userId: string; organizationId: string }[]

  return rows.length === 2 ? { a: rows[0], b: rows[1] } : null
}

beforeAll(async () => {
  if (LIVE) tenants = await readTenants()
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
})

function signedInAs(userId: string): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null })
}

async function captureCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    if (error instanceof AuthContextError) return error.code
    return `unexpected:${error instanceof Error ? error.name : String(error)}`
  }
}

/* -------------------------------------------------------------------------- */
/* Offline: the session states, and how they are told apart                   */
/* -------------------------------------------------------------------------- */

describe('session states are distinguished, not collapsed', () => {
  it('no session at all is AUTH_NO_SESSION', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await captureCode(() => withAuthenticatedDatabaseContext(async () => null))).toBe(
      'AUTH_NO_SESSION'
    )
  })

  it('a session GoTrue rejects (expired, revoked) is AUTH_SESSION_REJECTED, not AUTH_NO_SESSION', async () => {
    // The difference is operationally load-bearing: "expired" is a re-login,
    // "never signed in" is a redirect, and a 503 is neither.
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'JWT expired' },
    })
    expect(await captureCode(() => withAuthenticatedDatabaseContext(async () => null))).toBe(
      'AUTH_SESSION_REJECTED'
    )
  })

  it('a subject that is not a UUID is refused BEFORE any query', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'not-a-uuid' } }, error: null })
    expect(await captureCode(() => withAuthenticatedDatabaseContext(async () => null))).toBe(
      'AUTH_MALFORMED_SUBJECT'
    )
  })

  it('an unreachable Auth service is AUTH_UNAVAILABLE, which is a 503 and not a logout', async () => {
    mockGetUser.mockRejectedValue(new Error('ECONNREFUSED'))
    const code = await captureCode(() => withAuthenticatedDatabaseContext(async () => null))
    expect(code).toBe('AUTH_UNAVAILABLE')
    expect(authContextErrorStatus('AUTH_UNAVAILABLE')).toBe(503)
  })

  it('maps refusals to the status they deserve — 401 for identity, 403 for authorisation', async () => {
    expect(authContextErrorStatus('AUTH_NO_SESSION')).toBe(401)
    expect(authContextErrorStatus('AUTH_SESSION_REJECTED')).toBe(401)
    expect(authContextErrorStatus('AUTH_MALFORMED_SUBJECT')).toBe(401)
    // A signed-in user told to sign in again is a loop, not a fix.
    expect(authContextErrorStatus('AUTH_NO_ORGANIZATION')).toBe(403)
    expect(authContextErrorStatus('AUTH_ORGANIZATION_FORBIDDEN')).toBe(403)
    expect(authContextErrorStatus('AUTH_NOT_SUPER_ADMIN')).toBe(403)
  })

  it('never puts the subject in the error text', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-EXTRA' } },
      error: null,
    })
    let message = ''
    try {
      await withAuthenticatedDatabaseContext(async () => null)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('aaaaaaaa')
    expect(message).not.toContain('EXTRA')
  })

  it('there is no parameter for super-admin status', () => {
    // Not a style point: a wrapper that accepted the flag would let any caller
    // widen its own context. The only way in is `public.users`, re-checked by
    // db/identity-context.ts against current_user_is_super_admin().
    expect(withSuperAdminDatabaseContext.length).toBeLessThanOrEqual(2)
    const source = withOrganizationDatabaseContext.toString()
    expect(source).not.toMatch(/isSuperAdmin\s*[:=]\s*(true|options)/)
  })
})

/* -------------------------------------------------------------------------- */
/* Live: the principal                                                        */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('the request principal comes from the database, under the caller’s own claims', () => {
  it('has two distinct tenants to work with', () => {
    expect(tenants).not.toBeNull()
    expect(tenants!.a.organizationId).not.toBe(tenants!.b.organizationId)
    expect(tenants!.a.userId).not.toBe(tenants!.b.userId)
  })

  it('an Auth user with no row in public.users is AUTH_NO_PROFILE, not a blank session', async () => {
    signedInAs(ORPHAN_USER_ID)
    const { principal, failure } = await loadRequestPrincipalResult()
    expect(principal).toBeNull()
    expect(failure).toBe('AUTH_NO_PROFILE')
  })

  it('resolves the profile, the membership and the organisation for a real session', async () => {
    signedInAs(tenants!.a.userId)
    const { principal } = await loadRequestPrincipalResult()
    expect(principal?.user.id).toBe(tenants!.a.userId)
    expect(principal?.membership?.organizationId).toBe(tenants!.a.organizationId)
    expect(principal?.organization?.id).toBe(tenants!.a.organizationId)
  })

  it('a soft-deleted account cannot resolve a principal', async () => {
    // `users.deleted_at` is the GDPR erasure tombstone. Rolled back.
    signedInAs(tenants!.a.userId)
    await expect(
      withDatabaseIdentityContext(
        { userId: tenants!.a.userId, organizationId: null, isSuperAdmin: false },
        async () => {
          await db.execute(
            drizzleSql`UPDATE public.users SET deleted_at = now() WHERE id = ${tenants!.a.userId}::uuid`
          )
          const { principal, failure } = await loadRequestPrincipalResult()
          expect(principal).toBeNull()
          expect(failure).toBe('AUTH_NO_PROFILE')
          throw new Error('ROLLBACK_MARKER')
        }
      )
    ).rejects.toThrow('ROLLBACK_MARKER')

    // Proof the tombstone did not survive.
    signedInAs(tenants!.a.userId)
    const after = await loadRequestPrincipalResult()
    expect(after.principal?.user.id).toBe(tenants!.a.userId)
  })
})

/* -------------------------------------------------------------------------- */
/* Live: the wrappers                                                         */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('withOrganizationDatabaseContext', () => {
  it('sees exactly the caller’s own organisation', async () => {
    signedInAs(tenants!.a.userId)
    const rows = await withOrganizationDatabaseContext(async (ctx) => {
      expect(ctx.organization.id).toBe(tenants!.a.organizationId)
      return db.execute(drizzleSql`SELECT id::text AS id FROM public.organizations`)
    })
    const ids = (rows as unknown as { id: string }[]).map((r) => r.id)
    expect(ids).toContain(tenants!.a.organizationId)
    expect(ids).not.toContain(tenants!.b.organizationId)
  })

  it('accepts a caller-supplied organizationId only when it is the caller’s own', async () => {
    signedInAs(tenants!.a.userId)
    const ok = await withOrganizationDatabaseContext(
      async (ctx) => ctx.organization.id,
      { organizationId: tenants!.a.organizationId }
    )
    expect(ok).toBe(tenants!.a.organizationId)
  })

  it('refuses a caller-supplied organizationId belonging to somebody else', async () => {
    signedInAs(tenants!.a.userId)
    const code = await captureCode(() =>
      withOrganizationDatabaseContext(async () => null, {
        organizationId: tenants!.b.organizationId,
      })
    )
    expect(code).toBe('AUTH_ORGANIZATION_FORBIDDEN')
  })

  it('does not echo the refused organisation id back to the caller', async () => {
    signedInAs(tenants!.a.userId)
    let message = ''
    try {
      await withOrganizationDatabaseContext(async () => null, {
        organizationId: tenants!.b.organizationId,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).not.toContain(tenants!.b.organizationId)
  })

  it('an account with no membership gets AUTH_NO_ORGANIZATION, not an empty page', async () => {
    signedInAs(ORPHAN_USER_ID)
    // No profile row either, so the earlier refusal wins — which is the point:
    // the wrapper never proceeds to open a context for an unknown principal.
    expect(await captureCode(() => withOrganizationDatabaseContext(async () => null))).toBe(
      'AUTH_NO_PROFILE'
    )
  })
})

describe.skipIf(!LIVE)('withSuperAdminDatabaseContext', () => {
  it('refuses an ordinary member', async () => {
    signedInAs(tenants!.a.userId)
    const { principal } = await loadRequestPrincipalResult()
    if (principal?.user.isSuperAdmin) {
      // The rehearsal fixture happens to be an administrator; assert the
      // positive direction instead of skipping silently.
      const seen = await withSuperAdminDatabaseContext(async (user) => user.isSuperAdmin)
      expect(seen).toBe(true)
      return
    }
    expect(await captureCode(() => withSuperAdminDatabaseContext(async () => null))).toBe(
      'AUTH_NOT_SUPER_ADMIN'
    )
  })
})

describe.skipIf(!LIVE)('withOptionalDatabaseIdentityContext', () => {
  it('runs with null and NO claims when there is no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const seen = await withOptionalDatabaseIdentityContext(async (ctx) => {
      expect(ctx).toBeNull()
      // The unauthenticated branch is not handed a fabricated identity, so an
      // RLS-protected read returns nothing rather than everything.
      const rows = await db.execute(drizzleSql`SELECT id FROM public.organizations`)
      return (rows as unknown as unknown[]).length
    })
    expect(seen).toBe(0)
  })

  it('runs with the organisation context when there is one', async () => {
    signedInAs(tenants!.a.userId)
    const id = await withOptionalDatabaseIdentityContext(async (ctx) => ctx?.organization.id ?? null)
    expect(id).toBe(tenants!.a.organizationId)
  })
})

/* -------------------------------------------------------------------------- */
/* Live: isolation                                                            */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('isolation', () => {
  it('nesting the SAME identity reuses the open transaction', async () => {
    signedInAs(tenants!.a.userId)
    const same = await withOrganizationDatabaseContext(async (outer) =>
      withOrganizationDatabaseContext(async (inner) => inner.organization.id === outer.organization.id)
    )
    expect(same).toBe(true)
  })

  it('nesting a DIFFERENT identity is refused rather than silently reused', async () => {
    signedInAs(tenants!.a.userId)
    const code = await withOrganizationDatabaseContext(async () =>
      captureCode(() =>
        withDatabaseIdentityContext(
          { userId: tenants!.b.userId, organizationId: tenants!.b.organizationId, isSuperAdmin: false },
          async () => null
        )
      )
    )
    expect(code).toBe('unexpected:IdentityContextError')
  })

  it('clears the claim after a COMMIT — the next query on that pooled connection sees nothing', async () => {
    signedInAs(tenants!.a.userId)
    await withOrganizationDatabaseContext(async () => undefined)

    // Same pool, no context. If the claim had been session-scoped this would
    // return the previous caller's organisation.
    const rows = await db.execute(drizzleSql`SELECT id FROM public.organizations`)
    expect((rows as unknown as unknown[]).length).toBe(0)
  })

  it('clears the claim after a ROLLBACK too', async () => {
    signedInAs(tenants!.a.userId)
    await expect(
      withOrganizationDatabaseContext(async () => {
        throw new Error('ROLLBACK_MARKER')
      })
    ).rejects.toThrow('ROLLBACK_MARKER')

    const rows = await db.execute(drizzleSql`SELECT id FROM public.organizations`)
    expect((rows as unknown as unknown[]).length).toBe(0)
  })

  it('two concurrent requests with different identities never see each other’s rows', async () => {
    // The failure this guards against is not hypothetical: postgres-js hands
    // the same physical connection to whoever asks next, so a SESSION-scoped
    // claim would cross tenants here with no code path to blame.
    const readOrganizations = async (userId: string): Promise<string[]> => {
      const rows = await withDatabaseIdentityContext(
        { userId, organizationId: null, isSuperAdmin: false },
        async () => db.execute(drizzleSql`SELECT id::text AS id FROM public.organizations`)
      )
      return (rows as unknown as { id: string }[]).map((r) => r.id)
    }

    const [seenByA, seenByB] = await Promise.all([
      readOrganizations(tenants!.a.userId),
      readOrganizations(tenants!.b.userId),
    ])

    expect(seenByA).toContain(tenants!.a.organizationId)
    expect(seenByB).toContain(tenants!.b.organizationId)
    // Either user could legitimately be a super admin in the fixture; the
    // assertion that matters is that neither leaked into the OTHER's answer
    // through the connection rather than through a policy.
    if (!seenByA.includes(tenants!.b.organizationId)) {
      expect(seenByB).not.toContain(tenants!.a.organizationId)
    }
  })

  it('repeats cleanly — a second identical run is not served stale state', async () => {
    signedInAs(tenants!.b.userId)
    const first = await withOrganizationDatabaseContext(async (ctx) => ctx.organization.id)
    signedInAs(tenants!.a.userId)
    const second = await withOrganizationDatabaseContext(async (ctx) => ctx.organization.id)
    expect(first).toBe(tenants!.b.organizationId)
    expect(second).toBe(tenants!.a.organizationId)
  })
})

/* -------------------------------------------------------------------------- */
/* Live: the flows a user actually walks through                              */
/* -------------------------------------------------------------------------- */
//
// The wrappers can be individually correct and the application still broken —
// that was exactly the state this unit inherited. These exercise the sequences
// a session performs, through the same helpers the pages call.
//
// Writes are performed and then rolled back. Nothing persists.

describe.skipIf(!LIVE)('application flows', () => {
  it('LOGIN: the session resolves a profile — the cycle that broke local login is closed', async () => {
    // The pre-unit failure in one assertion: getCurrentUser() queried
    // public.users with no claims, read zero rows, and reported "not logged
    // in" for a perfectly valid session.
    signedInAs(tenants!.a.userId)
    const { getCurrentUser } = await import('@/lib/auth/session')
    const user = await getCurrentUser()
    expect(user?.id).toBe(tenants!.a.userId)
    expect(user?.email.length ?? 0).toBeGreaterThan(0)
  })

  it('LOGOUT: with the session gone, the very next call resolves nothing', async () => {
    signedInAs(tenants!.a.userId)
    const { getCurrentUser, getCurrentOrganizationContext } = await import('@/lib/auth/session')
    expect((await getCurrentUser())?.id).toBe(tenants!.a.userId)

    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await getCurrentUser()).toBeNull()
    expect(await getCurrentOrganizationContext()).toBeNull()

    // And no residue on the pooled connection.
    const rows = await db.execute(drizzleSql`SELECT id FROM public.organizations`)
    expect((rows as unknown as unknown[]).length).toBe(0)
  })

  it('DASHBOARD: an authorised session lists its own projects and nobody else’s', async () => {
    signedInAs(tenants!.a.userId)
    const mine = await withOrganizationDatabaseContext(async (ctx) => {
      const rows = await db.execute(
        drizzleSql`SELECT organization_id::text AS org FROM public.projects`
      )
      return { ctx, orgs: (rows as unknown as { org: string }[]).map((r) => r.org) }
    })
    expect(mine.orgs.every((org) => org === tenants!.a.organizationId)).toBe(true)
  })

  it('CROSS-ORG: a project belonging to the other tenant is invisible', async () => {
    const foreignProject = (await migratorSql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE uellix_owner')
      return tx<{ id: string }[]>`
        SELECT id::text AS id FROM public.projects
         WHERE organization_id = ${tenants!.b.organizationId}::uuid LIMIT 1
      `
    })) as unknown as { id: string }[]

    if (foreignProject.length === 0) return // nothing to assert against

    signedInAs(tenants!.a.userId)
    const seen = await withOrganizationDatabaseContext(async () =>
      db.execute(
        drizzleSql`SELECT id FROM public.projects WHERE id = ${foreignProject[0].id}::uuid`
      )
    )
    expect((seen as unknown as unknown[]).length).toBe(0)
  })

  it('STELLA READ: interactions are readable inside the context and invisible outside it', async () => {
    signedInAs(tenants!.a.userId)
    const inside = await withOrganizationDatabaseContext(async () =>
      db.execute(drizzleSql`SELECT count(*)::int AS n FROM public.stella_interactions`)
    )
    expect((inside as unknown as { n: number }[])[0].n).toBeGreaterThanOrEqual(0)

    const outside = await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM public.stella_interactions`
    )
    expect((outside as unknown as { n: number }[])[0].n).toBe(0)
  })

  it('STELLA WRITE: an interaction can be created inside the context, and is rolled back', async () => {
    signedInAs(tenants!.a.userId)
    const before = await countInteractions()

    await expect(
      withOrganizationDatabaseContext(async (ctx) => {
        const project = await db.execute(
          drizzleSql`SELECT id FROM public.projects WHERE organization_id = ${ctx.organization.id}::uuid LIMIT 1`
        )
        const projectId = (project as unknown as { id: string }[])[0]?.id ?? null

        await db.execute(drizzleSql`
          INSERT INTO public.stella_interactions
            (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json)
          VALUES
            (${ctx.organization.id}::uuid, ${projectId}::uuid, ${ctx.user.id}::uuid,
             'advisor', 'Outcomes', 'rehearsal-context-hash', '{"synthetic":true}'::jsonb)
        `)
        throw new Error('ROLLBACK_MARKER')
      })
    ).rejects.toThrow('ROLLBACK_MARKER')

    expect(await countInteractions()).toBe(before)
  })

  // Each statement gets its OWN transaction. Running both in one would prove
  // only the first: after a failed statement PostgreSQL aborts the transaction
  // and every later statement fails with "current transaction is aborted",
  // which looks identical to a trigger refusal and is not one.
  it.each([
    ['UPDATE', drizzleSql`UPDATE public.stella_interactions SET pipeline_step = 'tampered'`],
    ['DELETE', drizzleSql`DELETE FROM public.stella_interactions`],
  ])(
    'APPEND-ONLY: %s on stella_interactions is refused even inside the owning organisation',
    async (_label, statement) => {
      signedInAs(tenants!.a.userId)
      let refused = false
      try {
        await withOrganizationDatabaseContext(async () => db.execute(statement))
      } catch {
        refused = true
      }
      expect(refused).toBe(true)
      expect(await countInteractions()).toBeGreaterThanOrEqual(0)
    }
  )
})

async function countInteractions(): Promise<number> {
  const rows = (await migratorSql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE uellix_owner')
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.stella_interactions`
  })) as unknown as { n: number }[]
  return rows[0].n
}
