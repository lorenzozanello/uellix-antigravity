// tests/hosted/hosted-managed-role-attributes.test.ts
//
// THE TEST THAT WOULD HAVE CAUGHT T1 BEFORE STAGING, AND IT IS AN EXECUTION.
//
// ---------------------------------------------------------------------------
// WHAT WENT WRONG, AND WHY NO TEXTUAL TEST COULD SEE IT
// ---------------------------------------------------------------------------
// `grounding_0002` failed on its first real application with SQLSTATE 42501,
// "permission denied to alter role", on
//
//   ALTER ROLE uellix_cap_grounding
//     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
//
// Everything about that statement READS as safe. It targets a role the package
// created one statement earlier, it only ever NEGATES attributes, and the
// canonical file had been reviewed repeatedly. What no reading reveals is that
// PostgreSQL gates the attribute KEYWORDS rather than the target: naming
// SUPERUSER at all requires the caller to BE a superuser, and from PostgreSQL 16
// the same holds for CREATEDB, REPLICATION and BYPASSRLS against an installer
// that does not itself hold them.
//
// A grep for "ALTER ROLE" would have found the statement and told you nothing
// about whether it runs. So this test RUNS IT, as a role with exactly the shape
// managed Supabase gives the applying identity: LOGIN, CREATEROLE, and none of
// the four privileged attributes.
//
// ---------------------------------------------------------------------------
// WHY `docker exec` AND NOT A CONNECTION STRING
// ---------------------------------------------------------------------------
// The same reason `scripts/baseline-rehearsal-local.ts` gives: every other guard
// in this repository answers "is this URL local?", a question with a wrong
// answer available. `docker exec` into a container on this machine has no
// hostname to mistype and no remote database reachable by that path at all. The
// database is created by this file, named with a fixed prefix, and dropped by
// it; it never touches the stack's own `postgres` database.
//
// It SKIPS rather than fails when no local stack is running: this is a
// reproduction harness, and a machine without Docker is not a machine where the
// hosted chain regressed.

import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildHostedArtefacts } from '@/db/hosted/artefacts'
import { HOSTED_PACKAGE_MANIFEST } from '@/db/hosted/hosted-package-manifest'

/** Fixed prefix. Only databases matching it are ever dropped. */
const DB = 'uellix_roleattr_probe'
const INSTALLER = 'uellix_roleattr_installer'
const PASSWORD = 'roleattr-probe-local-only'

function docker(args: readonly string[], stdin?: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync('docker', [...args], {
        encoding: 'utf8',
        input: stdin,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      }),
    }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** The local Supabase database container, or null when there is no local stack. */
function findContainer(): string | null {
  const listed = docker(['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}'])
  if (listed.code !== 0) return null
  const name = listed.out.split('\n').map((l) => l.trim()).filter(Boolean)[0]
  return name ?? null
}

const CONTAINER = findContainer()

const asPostgres = (sql: string, db = DB) =>
  docker(['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', db, '-q', '-v', 'ON_ERROR_STOP=1'], sql)

/** Runs SQL as the NON-SUPERUSER installer, in one transaction, like the operator. */
const asInstaller = (sql: string) =>
  docker(
    ['exec', '-i', '-e', `PGPASSWORD=${PASSWORD}`, CONTAINER!, 'psql', '-U', INSTALLER,
     '-h', '127.0.0.1', '-d', DB, '-q', '-1', '-v', 'ON_ERROR_STOP=1'],
    sql,
  )

const attributesOf = (role: string): string =>
  docker(
    ['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', DB, '-q', '-t', '-A', '-F', '|', '-c',
     `SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='${role}'`],
  ).out.trim()

/**
 * Packages the rewrite rules actually own.
 *
 * `stella_hosted_0001` is `native-hosted`: it is WRITTEN for managed Supabase
 * and passes through the generator untouched BY DESIGN, because rewriting it
 * would produce a shim that calls itself. It is therefore outside what any rule
 * can fix — and it is pinned separately below rather than quietly skipped,
 * because it carries the same defect in a branch that has not run yet.
 */
const DERIVED = HOSTED_PACKAGE_MANIFEST.filter((e) => e.hostedCompatibility !== 'native-hosted').map(
  (e) => `${e.name}.hosted.sql`,
)

/** Every `ALTER ROLE` line the DERIVED artefacts contain, with its package. */
function alterRoleStatements(): { packageName: string; statement: string }[] {
  const out: { packageName: string; statement: string }[] = []
  for (const artefact of buildHostedArtefacts()) {
    if (!DERIVED.includes(artefact.fileName)) continue
    for (const line of artefact.sql.split('\n')) {
      const trimmed = line.trim()
      if (!/^ALTER\s+(ROLE|USER)\b/i.test(trimmed)) continue
      out.push({ packageName: artefact.fileName.replace('.hosted.sql', ''), statement: trimmed })
    }
  }
  return out
}

describe.skipIf(CONTAINER === null)('a managed, non-superuser installer can run what the chain asks of it', () => {
  beforeAll(() => {
    docker(['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-c',
            `DROP DATABASE IF EXISTS ${DB}`])
    docker(['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-c',
            `CREATE DATABASE ${DB}`])
    // THE PROFILE MANAGED SUPABASE ACTUALLY GIVES: LOGIN and CREATEROLE, and
    // none of SUPERUSER / CREATEDB / REPLICATION / BYPASSRLS. Getting this wrong
    // in the permissive direction would make the test pass for the wrong reason,
    // so it is stated explicitly rather than inherited from `postgres`.
    asPostgres(
      `DROP ROLE IF EXISTS ${INSTALLER};\n` +
        `CREATE ROLE ${INSTALLER} LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${PASSWORD}';\n` +
        `GRANT CREATE ON DATABASE ${DB} TO ${INSTALLER};\n`,
    )
  })

  afterAll(() => {
    docker(['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-c',
            `DROP DATABASE IF EXISTS ${DB}`])
    docker(['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-c',
            `DROP ROLE IF EXISTS ${INSTALLER}`])
  })

  it('the installer really lacks the four attributes — otherwise this whole file proves nothing', { timeout: 120_000 }, () => {
    const row = docker(
      ['exec', '-i', CONTAINER!, 'psql', '-U', 'postgres', '-d', DB, '-q', '-t', '-A', '-F', '|', '-c',
       `SELECT rolsuper,rolcreatedb,rolreplication,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname='${INSTALLER}'`],
    ).out.trim()
    expect(row).toBe('f|f|f|f|t')
  })

  it('EVERY ALTER ROLE the generated artefacts contain executes as that installer', { timeout: 300_000 }, () => {
    const statements = alterRoleStatements()
    // Three packages mint a capability role. If that number changes, this test
    // should be read again rather than quietly covering more or less.
    expect(statements.map((s) => s.packageName)).toEqual([
      'grounding_0002_document_versions',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
    ])

    for (const { packageName, statement } of statements) {
      const role = /^ALTER\s+ROLE\s+(\w+)/i.exec(statement)![1]!
      expect(asPostgres(`DROP ROLE IF EXISTS ${role};`).code, role).toBe(0)
      // The package creates the role before altering it; reproduce that order.
      expect(asInstaller(`CREATE ROLE ${role};`).code, `${packageName}: CREATE ROLE`).toBe(0)

      const applied = asInstaller(`${statement}\n`)
      expect(applied.code, `${packageName}: ${statement}\n${applied.out}`).toBe(0)
      expect(applied.out, packageName).not.toMatch(/permission denied/i)

      // AND THE END STATE IS THE ONE THE CANONICAL STATEMENT GUARANTEED. The
      // rewrite is only safe if the seven attributes are still all false; three
      // are now SET and four are ASSERTED, and this is what proves the pair adds
      // up to what the single statement used to do.
      expect(attributesOf(role), `${packageName}: ${role}`).toBe('f|f|f|f|f|f|f')
      asPostgres(`DROP ROLE IF EXISTS ${role};`)
    }
  })

  it('NEGATIVE CONTROL: the canonical seven-attribute statement still fails, exactly as it did in staging', { timeout: 180_000 }, () => {
    // If a future edit reverted the rewrite, this is the case that goes red —
    // with the same message the operator saw.
    asPostgres('DROP ROLE IF EXISTS uellix_cap_regression;')
    expect(asInstaller('CREATE ROLE uellix_cap_regression;').code).toBe(0)

    const refused = asInstaller(
      'ALTER ROLE uellix_cap_regression\n' +
        '  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;\n',
    )
    expect(refused.code).not.toBe(0)
    expect(refused.out).toMatch(/permission denied to alter role/i)
    expect(refused.out).toMatch(/SUPERUSER/)
    asPostgres('DROP ROLE IF EXISTS uellix_cap_regression;')
  })

  it('CREATE ROLE with the same negated attributes is permitted — which is why the bootstrap passed', { timeout: 180_000 }, () => {
    // Measured, and it explains the whole history: stella_hosted_0001 carries the
    // same seven-attribute shape in an ELSE branch, and applied cleanly in
    // staging only because none of its five roles existed, so every branch took
    // CREATE. See the finding recorded with this fix.
    asPostgres('DROP ROLE IF EXISTS uellix_cap_createprobe;')
    const created = asInstaller(
      'CREATE ROLE uellix_cap_createprobe WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;\n',
    )
    expect(created.code).toBe(0)

    const altered = asInstaller(
      'ALTER ROLE uellix_cap_createprobe WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;\n',
    )
    expect(altered.code).not.toBe(0)
    expect(altered.out).toMatch(/permission denied to alter role/i)
    asPostgres('DROP ROLE IF EXISTS uellix_cap_createprobe;')
  })

  it('the generated ASSERTION refuses a widened role, by name, instead of failing on a permission', { timeout: 180_000 }, () => {
    const artefact = buildHostedArtefacts().find(
      (a) => a.fileName === 'grounding_0002_document_versions.hosted.sql',
    )!
    const start = artefact.sql.indexOf('DO $$', artefact.sql.indexOf('-- 1. Capability role and schema'))
    const block = artefact.sql.slice(start, artefact.sql.indexOf('CREATE SCHEMA IF NOT EXISTS uellix_grounding'))

    asPostgres('DROP ROLE IF EXISTS uellix_cap_grounding;')
    asPostgres('CREATE ROLE uellix_cap_grounding BYPASSRLS;')

    const refused = asInstaller(block)
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain('grounding_0002_document_versions aborted')
    expect(refused.out).toContain('BYPASSRLS')
    // NOT a bare permission error: the operator is told which attribute is wrong.
    expect(refused.out).not.toMatch(/permission denied to alter role/i)

    asPostgres('DROP ROLE IF EXISTS uellix_cap_grounding;')
  })

  it('and the same block applies cleanly against a role that is not widened', { timeout: 180_000 }, () => {
    const artefact = buildHostedArtefacts().find(
      (a) => a.fileName === 'grounding_0002_document_versions.hosted.sql',
    )!
    const start = artefact.sql.indexOf('DO $$', artefact.sql.indexOf('-- 1. Capability role and schema'))
    const block = artefact.sql.slice(start, artefact.sql.indexOf('CREATE SCHEMA IF NOT EXISTS uellix_grounding'))

    asPostgres('DROP ROLE IF EXISTS uellix_cap_grounding;')
    const applied = asInstaller(block)
    expect(applied.code, applied.out).toBe(0)
    expect(attributesOf('uellix_cap_grounding')).toBe('f|f|f|f|f|f|f')
    asPostgres('DROP ROLE IF EXISTS uellix_cap_grounding;')
  })
})

describe('the corpus carries no privileged role statement a managed installer cannot run', () => {
  // Runs everywhere, Docker or not. Weaker than the execution above and stated
  // as weaker: it is the tripwire that fires on a NEW package introducing the
  // shape, on a machine where the execution test skips.
  const PRIVILEGED = /\b(NO)?(SUPERUSER|REPLICATION|BYPASSRLS|CREATEDB)\b/

  it('no ALTER ROLE in any DERIVED artefact names an attribute the installer may lack', () => {
    const offenders: string[] = []
    for (const artefact of buildHostedArtefacts()) {
      if (!DERIVED.includes(artefact.fileName)) continue
      for (const line of artefact.sql.split('\n')) {
        const trimmed = line.trim()
        if (!/^ALTER\s+(ROLE|USER)\b/i.test(trimmed)) continue
        if (PRIVILEGED.test(trimmed)) offenders.push(`${artefact.fileName}: ${trimmed}`)
      }
    }
    expect(
      offenders,
      'ALTER ROLE gates the attribute KEYWORD, not the target: naming SUPERUSER, CREATEDB, ' +
        'REPLICATION or BYPASSRLS — even negated — requires the caller to hold it. Managed Supabase ' +
        'grants none of the four. Assert the attribute instead of setting it.',
    ).toEqual([])
  })

  /*
   * THE BOOTSTRAP CARRIES THE SAME DEFECT, IN A BRANCH THAT HAS NOT RUN.
   *
   * `stella_hosted_0001` applied cleanly to staging, and this is why: each of
   * its five roles is minted as
   *
   *   IF NOT EXISTS (...) THEN CREATE ROLE x WITH ... NOSUPERUSER ...;
   *   ELSE                     ALTER  ROLE x WITH ... NOSUPERUSER ...;
   *
   * and CREATE ROLE with negated attributes IS permitted to a CREATEROLE
   * installer — measured above. On a fresh project none of the five existed, so
   * every branch took CREATE and the ELSE was never evaluated. The ELSE is the
   * package's own convergence path, and on managed Supabase it is unexecutable.
   *
   * It is NOT fixed here, and the reasons are stated rather than assumed:
   * the bootstrap is `native-hosted`, so no rewrite rule may touch it by design;
   * it is already applied; and this turn is scoped to T1. What is not acceptable
   * is leaving the hole undocumented, so the exact five statements are pinned.
   * If somebody re-runs the bootstrap over an existing role model — or
   * provisions a project where these role names already exist — it fails, and
   * this test is where the reason is written down.
   */
  it('KNOWN LATENT DEFECT: the bootstrap ELSE branch is unexecutable on managed Supabase', () => {
    const bootstrap = buildHostedArtefacts().find(
      (a) => a.fileName === 'stella_hosted_0001_managed_role_bootstrap.hosted.sql',
    )!
    const offenders = bootstrap.sql
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^ALTER\s+ROLE\b/i.test(l) && PRIVILEGED.test(l))

    // EXACTLY five, one per bootstrap role. A sixth means the surface grew and
    // this finding needs re-reading; fewer means somebody fixed it and this
    // test should be retired with them.
    expect(offenders).toHaveLength(5)
    for (const role of ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor']) {
      expect(offenders.join(' | '), role).toContain(role)
    }

    // And every one of them sits in an ELSE, which is why S1 passed.
    expect(bootstrap.sql).toContain('ELSE')
  })

  it('the three capability packages each rewrite exactly one such statement', () => {
    const withRule = HOSTED_PACKAGE_MANIFEST.filter(
      (e) => e.expectedRewrites['capability-role-attributes'] === 1,
    ).map((e) => e.name)
    expect(withRule).toEqual([
      'grounding_0002_document_versions',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
    ])
  })
})
