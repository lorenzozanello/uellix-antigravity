// tests/database-migrator-path.test.ts
//
// THE MIGRATION PATH: uellix_migrator -> SET ROLE uellix_owner -> DDL.
//
// The property under test is not "migrations work". It is that privilege is
// only ever REACHED, never HELD:
//
//   * `uellix_migrator` authenticates, and on its own can do nothing — no
//     CREATE, no table access, no BYPASSRLS;
//   * `uellix_owner` owns everything and cannot authenticate at all;
//   * the only bridge is an explicit `SET ROLE` inside a transaction, which
//     ends when the transaction does.
//
// A migration wrapper that merely worked would satisfy none of that. The tests
// below check each link independently, including the failure modes — a script
// that errors halfway, a session that forgot to SET ROLE, and the runtime
// credential used by mistake.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertMigratorSession,
  assertOwnerRoleActive,
  verifyOwnershipAndAcl,
  applyPreparedScript,
  MigratorError,
} from '@/db/migrator'
import { MIGRATOR_DATABASE_ROLE, OWNER_DATABASE_ROLE } from '@/db/safety/database-role'
import { MIGRATOR_CONNECTION, migratorSql, runtimeSql, RUNTIME_CONNECTION } from './helpers/local-runtime'

const LIVE = MIGRATOR_CONNECTION.available
const REPO_ROOT = resolve(import.meta.dirname, '..')
const PREPARED = resolve(REPO_ROOT, 'db', 'prepared')

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    if (error instanceof MigratorError) return error.code
    return `unexpected:${(error as Error).message}`
  }
}

/* -------------------------------------------------------------------------- */
/* Offline: the scripts exist and refuse the wrong identity in their own SQL   */
/* -------------------------------------------------------------------------- */

describe('stella_0005 scripts refuse the wrong applying identity in SQL, not just in TS', () => {
  const forward = resolve(PREPARED, 'stella_0005_runtime_cutover.sql')
  const rollback = resolve(PREPARED, 'stella_0005_rollback.sql')
  const bootstrap = resolve(PREPARED, 'stella_0005b_admin_bootstrap.sql')

  it('all three scripts and both rollbacks exist', () => {
    for (const file of [
      forward,
      rollback,
      bootstrap,
      resolve(PREPARED, 'stella_0005b_rollback.sql'),
    ]) {
      expect(existsSync(file), file).toBe(true)
    }
  })

  it.each([
    ['stella_0005_runtime_cutover.sql', forward],
    ['stella_0005_rollback.sql', rollback],
  ])('%s asserts current_user = uellix_owner AND session_user = uellix_migrator', (_n, file) => {
    const sql = readFileSync(file, 'utf8')
    expect(sql).toMatch(/current_user\s*<>\s*'uellix_owner'/)
    expect(sql).toMatch(/session_user\s*<>\s*'uellix_migrator'/)
  })

  it('the owner-scoped script contains no password and no role attribute change', () => {
    const sql = readFileSync(forward, 'utf8')
    expect(sql).not.toMatch(/PASSWORD\s+'/i)
    // ALTER ROLE at all would fail: uellix_owner has no CREATEROLE. Its absence
    // is what forced the administrative half into a separate script.
    expect(sql).not.toMatch(/^\s*ALTER ROLE /im)

    // The words BYPASSRLS and CREATEROLE DO appear in this file — in the
    // preconditions that refuse to run if the runtime role has them, and in the
    // error text that says so. A bare `not.toMatch(/BYPASSRLS/)` would fail on
    // the check itself, which is the opposite of the property wanted here. What
    // must be absent is a statement that CONFERS either attribute.
    expect(sql).not.toMatch(/ALTER\s+ROLE[^;]*BYPASSRLS/i)
    expect(sql).not.toMatch(/ALTER\s+ROLE[^;]*CREATEROLE/i)
    expect(sql).not.toMatch(/CREATE\s+ROLE/i)
  })

  it('the admin bootstrap sets no password either', () => {
    const sql = readFileSync(bootstrap, 'utf8')
    expect(sql).not.toMatch(/PASSWORD\s+'/i)
  })

  it('neither script grants anything to anon, PUBLIC or service_role', () => {
    for (const file of [forward, bootstrap]) {
      const sql = readFileSync(file, 'utf8')
      // Comments are stripped first: both files DISCUSS these roles at length.
      const code = sql.replace(/^\s*--.*$/gm, '')
      expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i)
      expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\bservice_role\b/i)
      expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\bPUBLIC\b/i)
    }
  })
})

describe('stella_0003 follows the same governed migration path', () => {
  const forward = resolve(PREPARED, 'stella_0003_suggestion_decisions.sql')

  it('requires uellix_migrator as the session user and uellix_owner as the effective owner', () => {
    const sql = readFileSync(forward, 'utf8')
    expect(sql).toMatch(/current_user\s*<>\s*'uellix_owner'/)
    expect(sql).toMatch(/session_user\s*<>\s*'uellix_migrator'/)
    expect(sql).toMatch(/OWNER TO uellix_owner/)
  })

  it('checks, rather than mutates, the runtime role topology', () => {
    const sql = readFileSync(forward, 'utf8')
    expect(sql).toMatch(/pg_auth_members/)
    expect(sql).toMatch(/m\.member = app_oid/)
    expect(sql).toMatch(/m\.roleid = writer_oid/)
    expect(sql).toMatch(/NOT m\.set_option/)
    expect(sql).not.toMatch(/^\s*(ALTER|CREATE)\s+ROLE\b/im)
    expect(sql).not.toMatch(/^\s*GRANT\s+uellix_writer\s+TO\s+uellix_app/im)
  })
})

/* -------------------------------------------------------------------------- */
/* Live                                                                       */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('live migration path', () => {
  it('the migration credential authenticates as uellix_migrator and nothing more', async () => {
    const identity = await assertMigratorSession(migratorSql)
    expect(identity.session_user).toBe(MIGRATOR_DATABASE_ROLE)
    expect(identity.is_superuser).toBe(false)
    expect(identity.is_bypassrls).toBe(false)
    expect(identity.is_createrole).toBe(false)
  })

  it('the migrator on its own cannot create anything', async () => {
    const [row] = await migratorSql<{ can_create: boolean }[]>`
      SELECT has_schema_privilege(session_user, 'public', 'CREATE') AS can_create
    `
    expect(row.can_create).toBe(false)
  })

  it('the migrator on its own cannot read application tables', async () => {
    // The owner is BORROWED for DDL; it is not inherited. `inherit_option` on
    // the membership is false, so a migrator session that forgets SET ROLE has
    // no more access than a stranger.
    let denied = false
    try {
      await migratorSql`SELECT 1 FROM public.organizations LIMIT 1`
    } catch (error) {
      denied = (error as { code?: string }).code === '42501'
    }
    expect(denied).toBe(true)
  })

  it('SET LOCAL ROLE reaches the owner, and the owner does not outlive the transaction', async () => {
    const inside = await migratorSql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${OWNER_DATABASE_ROLE}`)
      const [row] = await tx<{ current_user: string; session_user: string }[]>`
        SELECT current_user::text AS current_user, session_user::text AS session_user
      `
      return row
    })
    expect((inside as unknown as { current_user: string }).current_user).toBe(OWNER_DATABASE_ROLE)
    expect((inside as unknown as { session_user: string }).session_user).toBe(MIGRATOR_DATABASE_ROLE)

    const [after] = await migratorSql<{ current_user: string }[]>`
      SELECT current_user::text AS current_user
    `
    expect(after.current_user).toBe(MIGRATOR_DATABASE_ROLE)
  })

  it('assertOwnerRoleActive fails on a session that forgot to SET ROLE', async () => {
    const code = await codeOf(() => assertOwnerRoleActive(migratorSql))
    expect(code).toBe('DB_MIGRATOR_SET_ROLE_FAILED')
  })

  it('objects created as the owner belong to the owner, with no PUBLIC access', async () => {
    // A table, a sequence, a function and a type — the four object classes
    // whose defaults differ. Functions and types are the dangerous pair:
    // PostgreSQL's built-in default for both is a grant to PUBLIC.
    const report = await migratorSql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${OWNER_DATABASE_ROLE}`)
      await tx.unsafe('CREATE TABLE public.migrator_probe_tbl (id int)')
      await tx.unsafe('CREATE SEQUENCE public.migrator_probe_seq')
      await tx.unsafe('CREATE TYPE public.migrator_probe_type AS (a int)')
      await tx.unsafe(
        'CREATE FUNCTION public.migrator_probe_fn() RETURNS int LANGUAGE sql AS $x$ SELECT 1 $x$'
      )

      const [row] = await tx<
        {
          tbl_owner: string
          seq_owner: string
          fn_owner: string
          type_owner: string
          fn_public: boolean
          type_public: boolean
          writer_select: boolean
          writer_update: boolean
        }[]
      >`
        SELECT
          pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.migrator_probe_tbl'::regclass))  AS tbl_owner,
          pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.migrator_probe_seq'::regclass))  AS seq_owner,
          pg_get_userbyid((SELECT proowner FROM pg_proc  WHERE oid = 'public.migrator_probe_fn()'::regprocedure)) AS fn_owner,
          pg_get_userbyid((SELECT typowner FROM pg_type  WHERE oid = 'public.migrator_probe_type'::regtype))  AS type_owner,
          has_function_privilege('public', 'public.migrator_probe_fn()'::regprocedure, 'EXECUTE')             AS fn_public,
          has_type_privilege('public', 'public.migrator_probe_type'::regtype, 'USAGE')                        AS type_public,
          has_table_privilege('uellix_writer', 'public.migrator_probe_tbl'::regclass, 'SELECT')               AS writer_select,
          has_table_privilege('uellix_writer', 'public.migrator_probe_tbl'::regclass, 'UPDATE')               AS writer_update
      `

      // Everything is abandoned: this suite must not leave a probe table in a
      // database whose table count is an asserted invariant elsewhere.
      throw Object.assign(new Error('rollback'), { report: row })
    }).catch((error: unknown) => (error as { report?: Record<string, unknown> }).report)

    expect(report).toBeDefined()
    const r = report as Record<string, unknown>
    expect(r.tbl_owner).toBe(OWNER_DATABASE_ROLE)
    expect(r.seq_owner).toBe(OWNER_DATABASE_ROLE)
    expect(r.fn_owner).toBe(OWNER_DATABASE_ROLE)
    expect(r.type_owner).toBe(OWNER_DATABASE_ROLE)

    // stella_0004's global default privileges close PostgreSQL's own defaults.
    expect(r.fn_public).toBe(false)
    expect(r.type_public).toBe(false)

    // stella_0005 §3: future tables are readable and insertable by the runtime,
    // and NOT updatable. Append-only is the default; mutability is opt-in.
    expect(r.writer_select).toBe(true)
    expect(r.writer_update).toBe(false)
  })

  it('a script that errors halfway leaves nothing behind', async () => {
    const before = await migratorSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `
    let failed = false
    try {
      await migratorSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${OWNER_DATABASE_ROLE}`)
        await tx.unsafe('CREATE TABLE public.migrator_halfway_tbl (id int)')
        await tx.unsafe('SELECT 1 / 0')
      })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)

    const after = await migratorSql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `
    expect(after[0].count).toBe(before[0].count)
  })

  it('the drizzle bookkeeping chain now belongs to the owner', async () => {
    const rows = await migratorSql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${OWNER_DATABASE_ROLE}`)
      return tx<{ schema_owner: string; table_owner: string }[]>`
        SELECT
          pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'drizzle')) AS schema_owner,
          pg_get_userbyid((SELECT relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations')) AS table_owner
      `
    })
    const row = (rows as unknown as { schema_owner: string; table_owner: string }[])[0]
    expect(row.schema_owner).toBe(OWNER_DATABASE_ROLE)
    expect(row.table_owner).toBe(OWNER_DATABASE_ROLE)
  })

  it('everything in public is owned by the owner and nothing is PUBLIC-reachable', async () => {
    const report = await migratorSql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${OWNER_DATABASE_ROLE}`)
      return verifyOwnershipAndAcl(tx as never)
    })
    const r = report as unknown as Awaited<ReturnType<typeof verifyOwnershipAndAcl>>
    expect(r.tablesNotOwnedByOwner).toEqual([])
    expect(r.functionsNotOwnedByOwner).toEqual([])
    expect(r.sequencesNotOwnedByOwner).toEqual([])
    expect(r.typesNotOwnedByOwner).toEqual([])
    expect(r.publicExecutableFunctions).toEqual([])
    expect(r.publicUsableTypes).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Live: the wrong credential is refused                                      */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE || !RUNTIME_CONNECTION.available)('wrong credential is refused', () => {
  it('the RUNTIME connection cannot be used as a migrator connection', async () => {
    const code = await codeOf(() => assertMigratorSession(runtimeSql))
    expect(code).toBe('DB_MIGRATOR_WRONG_SESSION_ROLE')
  })

  it('applying a prepared script through the runtime client is refused before it runs', async () => {
    const code = await codeOf(() =>
      applyPreparedScript(resolve(PREPARED, 'stella_0005_runtime_cutover.sql'), {
        client: RUNTIME_CONNECTION.client!,
        dryRun: true,
      })
    )
    expect(code).toBe('DB_MIGRATOR_WRONG_SESSION_ROLE')
  })

  it('a dry run of the applied script is idempotent and still passes its postconditions', async () => {
    const result = await applyPreparedScript(
      resolve(PREPARED, 'stella_0005_runtime_cutover.sql'),
      { client: MIGRATOR_CONNECTION.client!, dryRun: true, log: () => undefined }
    )
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.report.tablesNotOwnedByOwner).toEqual([])
  })
})
