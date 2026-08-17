// tests/hosted/prechain-ownership.test.ts
// M-2 — the offline contract of the prechain OWNERSHIP reconciliation.
//
// The behavioural half is not linted, it is MEASURED: both canonical
// certifications provision the managed shape, apply this package as the
// administrative identity, and then apply the governed chain as
// `uellix_migrator`. What this file pins is the set of properties a diff can
// change silently — that it is not a chain member, that it transfers and does
// nothing else, and that the reasons it carries are reasons rather than shrugs.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  PRECHAIN_ADMINISTRATIVE_UNITS,
  PRECHAIN_OWNERSHIP,
  PRECHAIN_RUNTIME_HELPER_CONTRACT,
  PRECHAIN_STORAGE_TABLE_READ,
  PRECHAIN_STORAGE_USAGE,
  sha256OfPreparedSql,
} from '@/db/hosted/prechain-ownership'
import { PRECHAIN_REMEDIATION } from '@/db/hosted/prechain-remediation'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import { WITNESSED_PACKAGES } from '@/db/hosted/package-witnesses'
import { forwardOnlyPackage } from '@/db/hosted/forward-only-packages'

const ROOT = path.resolve(process.cwd())
const sql = readFileSync(path.join(ROOT, PRECHAIN_OWNERSHIP.sourceFile), 'utf8')

/** Strip -- line comments and single-quoted strings, as the sibling suites do. */
const stripSqlSurface = (s: string): string =>
  s.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''")

const executable = stripSqlSurface(sql)

/** The RT-01 package, and a reader for the two local packages it converges to. */
const runtimeHelperSql = readFileSync(
  path.join(ROOT, PRECHAIN_RUNTIME_HELPER_CONTRACT.sourceFile),
  'utf8'
)
const read = (name: string): string =>
  readFileSync(path.join(ROOT, 'db/prepared', name), 'utf8')

/** Comments only. The header of RT-01 QUOTES the statements it must not issue --
 *  a GRANT to uellix_app, an ALTER FUNCTION ... OWNER TO -- because explaining
 *  what a package deliberately does not do is half its contract. A check that
 *  read the raw file would fail on the explanation instead of on the code. */
const runtimeHelperExec = runtimeHelperSql.replace(/--[^\n]*/g, '')

/** Comments AND single-quoted literals stripped, as the sibling suites do. The
 *  §3 refusal messages NAME the statements the package must not issue — "this
 *  package issues no ALTER FUNCTION ... OWNER TO" — so a check that only removed
 *  comments would fail on the error text that proves the property. */
const runtimeHelperStatements = stripSqlSurface(runtimeHelperSql)

describe('the package is registered, pinned, and is NOT a chain package', () => {
  it('exists at the path the registry names', () => {
    expect(existsSync(path.join(ROOT, PRECHAIN_OWNERSHIP.sourceFile))).toBe(true)
  })

  it('matches its pinned digest', () => {
    expect(sha256OfPreparedSql(sql)).toBe(PRECHAIN_OWNERSHIP.sourceSha256)
  })

  it('normalizes line endings before hashing, so a CRLF checkout still matches', () => {
    expect(sha256OfPreparedSql(sql.replace(/\n/g, '\r\n'))).toBe(PRECHAIN_OWNERSHIP.sourceSha256)
  })

  it('is NOT in HOSTED_CHAIN and takes no chain witness', () => {
    // The load-bearing assertion of this file. A prechain unit that drifted
    // into the chain would be reported as an installed link — and the chain's
    // installed count would become a number no single identity can produce,
    // because every link is applied by uellix_migrator and this one cannot be.
    expect(HOSTED_CHAIN).not.toContain(PRECHAIN_OWNERSHIP.id)
    expect(WITNESSED_PACKAGES).not.toContain(PRECHAIN_OWNERSHIP.id)
  })

  it('has an identity distinct from the other prechain unit', () => {
    expect(PRECHAIN_OWNERSHIP.id).not.toBe(PRECHAIN_REMEDIATION.id)
    expect(PRECHAIN_OWNERSHIP.kind).not.toBe(PRECHAIN_REMEDIATION.kind)
  })

  it('ships no rollback script, and says why in a reviewable sentence', () => {
    const entry = forwardOnlyPackage(PRECHAIN_OWNERSHIP.id)
    expect(entry, 'the forward-only registry does not declare it').not.toBeNull()
    expect(entry!.reason.length).toBeGreaterThan(200)
    expect(entry!.reversalPath.length).toBeGreaterThan(40)
    expect(existsSync(path.join(ROOT, 'db/prepared/stella_hosted_0003_rollback.sql'))).toBe(false)
  })
})

describe('it transfers ownership, and does NOTHING else', () => {
  it('emits exactly the two ALTER FUNCTION statements the registry declares', () => {
    const alters = [...executable.matchAll(/ALTER FUNCTION\s+([^\s]+\([^)]*\))\s+OWNER TO\s+(\w+)/gi)]
    expect(alters).toHaveLength(2)
    for (const [, , owner] of alters) expect(owner).toBe(PRECHAIN_OWNERSHIP.destinationOwner)

    // Compared against the REGISTRY list rather than a second transcription, so
    // the SQL and the declaration cannot drift into naming different functions.
    const normalise = (s: string) => s.replace(/\s+/g, '')
    expect(alters.map(([, sig]) => normalise(sig)).sort()).toEqual(
      PRECHAIN_OWNERSHIP.normalisedFunctions.map(normalise).sort(),
    )
  })

  it('normalises BOTH helpers, because stella_0019 asserts the owner of both', () => {
    expect(PRECHAIN_OWNERSHIP.normalisedFunctions).toHaveLength(2)
    const t11 = readFileSync(path.join(ROOT, 'db/prepared/stella_0019_storage_write_roles.sql'), 'utf8')
    // The guard that makes normalising only one of them insufficient.
    expect(t11).toMatch(/can_read_evidence_object is owned by %, not uellix_owner/)
    expect(t11).toMatch(/can_write_evidence_object is owned by %, not uellix_owner/)
  })

  it('issues no GRANT, no REVOKE and no CREATE/DROP of anything', () => {
    expect(executable).not.toMatch(/^\s*GRANT\b/im)
    expect(executable).not.toMatch(/^\s*REVOKE\b/im)
    expect(executable).not.toMatch(/\b(CREATE|DROP)\s+(FUNCTION|TABLE|POLICY|ROLE|SCHEMA|TRIGGER|INDEX)\b/i)
    expect(executable).not.toMatch(/CREATE OR REPLACE/i)
  })

  it('does not grant uellix_owner USAGE on schema storage — that is a separate question', () => {
    // stella_0005d's job locally, and open on the hosted side. If this package
    // ever appeared to have settled it, the next audit would credit the wrong
    // unit. It only REPORTS the state.
    expect(executable).not.toMatch(/USAGE\s+ON\s+SCHEMA\s+storage/i)
    expect(sql).toMatch(/stella_0005d/)
  })

  it('pins search_path to public as its first statement and runs in one transaction', () => {
    expect(sql).toMatch(/^SET search_path = public;$/m)
    expect(sql).toMatch(/-1 -v ON_ERROR_STOP=1/)
    expect(executable).not.toMatch(/CONCURRENTLY/i)
  })
})

describe('the guards that keep it from seizing or half-transferring', () => {
  it('refuses a split-ownership pair', () => {
    expect(sql).toMatch(/SPLIT ownership/)
    expect(sql).toMatch(/read_owner <> write_owner/)
  })

  it('refuses an owner the session cannot already act as', () => {
    // The anti-seizure guard, and it is written over pg_has_role rather than a
    // hardcoded 'postgres' so a differently-named administrative role is not
    // refused while nothing extra is accepted.
    expect(sql).toMatch(/pg_has_role\(current_user, read_owner, 'USAGE'\)/)
    expect(sql).toMatch(/will not seize a function owned by a principal it cannot already act as/)
    expect(sql).not.toMatch(/read_owner\s*(<>|=)\s*'postgres'/)
  })

  it('accepts uellix_owner as an already-normalised state, so re-application converges', () => {
    expect(sql).toMatch(/read_owner <> 'uellix_owner'\s*\n\s*AND NOT/)
  })

  it('tests the DESTINATION membership with SET, not USAGE', () => {
    // MEASURED on PG 17.6: stella_hosted_0001 §297 grants uellix_owner to
    // postgres WITH INHERIT FALSE, SET TRUE, so pg_has_role(...,'USAGE') is
    // FALSE and 'SET' is TRUE — and ALTER OWNER succeeds on SET alone.
    // Written as 'USAGE' this guard refused the one identity the package exists
    // for, on a database where the transfer was permitted: a 10/11 chain.
    expect(sql).toMatch(/pg_has_role\(current_user, 'uellix_owner', 'SET'\)/)
    expect(sql).not.toMatch(/pg_has_role\(current_user, 'uellix_owner', 'USAGE'\)/)
  })

  it('accepts EITHER USAGE or SET on the CURRENT owner', () => {
    // Ownership resolves through inherited privilege, but a SET-only session
    // reaches the same place via SET ROLE. Demanding one alone refuses a caller
    // for whom the operation is genuinely available.
    expect(sql).toMatch(/pg_has_role\(current_user, read_owner, 'USAGE'\)/)
    expect(sql).toMatch(/pg_has_role\(current_user, read_owner, 'SET'\)/)
  })

  it('measures the ACL as the NON-OWNER grantee set, which is the only true form', () => {
    // ALTER OWNER legitimately rewrites the owner's own entry — MEASURED — so a
    // raw ACL comparison would fail on every correct run. Both the capture and
    // the comparison must exclude the owner, and both are checked here because
    // excluding it on one side only would make the assertion vacuous.
    const excludes = [...sql.matchAll(/<> pg_catalog\.pg_get_userbyid\(p\.proowner\)/g)]
    expect(excludes.length).toBe(2)
    expect(sql).toMatch(/non-owner EXECUTE grants changed/)
  })

  it('asserts the body, definer flag and search_path are unchanged', () => {
    expect(sql).toMatch(/md5\(p\.prosrc\)/)
    expect(sql).toMatch(/a function body, its SECURITY DEFINER flag or its search_path changed/)
  })

  it('asserts the storage policies were not recreated', () => {
    expect(sql).toMatch(/the policies on storage\.objects changed while this package ran/)
  })
})

describe('the registry states reasons, not shrugs', () => {
  it('carries a substantial purpose and unblocks statement', () => {
    expect(PRECHAIN_OWNERSHIP.purpose.length).toBeGreaterThan(200)
    expect(PRECHAIN_OWNERSHIP.unblocks.length).toBeGreaterThan(80)
    expect(PRECHAIN_OWNERSHIP.unblocks).toContain('stella_0019_storage_write_roles')
  })

  it('names the destination owner the chain is written against', () => {
    expect(PRECHAIN_OWNERSHIP.destinationOwner).toBe('uellix_owner')
  })
})


describe('the prechain TRIO, and the order that is load-bearing', () => {
  const usageSql = readFileSync(path.join(ROOT, PRECHAIN_STORAGE_USAGE.sourceFile), 'utf8')

  it('declares all four units in application order', () => {
    expect(PRECHAIN_ADMINISTRATIVE_UNITS.map((u) => u.id)).toEqual([
      PRECHAIN_OWNERSHIP.id,
      PRECHAIN_STORAGE_USAGE.id,
      PRECHAIN_STORAGE_TABLE_READ.id,
      // RT-01. Last because it depends on nothing the other three publish and
      // publishes nothing they need: it repairs the BASELINE helper contract for
      // the application runtime, where the first three repair the Storage helper
      // contract for the installer. Ordering it after them keeps the trio's own
      // argument — 0004 needs 0003, 0005 needs both — readable as a unit.
      PRECHAIN_RUNTIME_HELPER_CONTRACT.id,
    ])
  })

  it('pins the runtime helper contract and finds it on disk', () => {
    expect(existsSync(path.join(ROOT, PRECHAIN_RUNTIME_HELPER_CONTRACT.sourceFile))).toBe(true)
    expect(sha256OfPreparedSql(runtimeHelperSql)).toBe(
      PRECHAIN_RUNTIME_HELPER_CONTRACT.sourceSha256
    )
  })

  describe('RT-01 — the runtime helper contract', () => {
    // THE ASSERTION WHOSE ABSENCE LET THE DEFECT SHIP. Nothing in this
    // repository checked that the RUNTIME could execute the baseline RLS
    // helpers: every has_function_privilege('uellix_app', ...) test targets a
    // CAMPAIGN function (uellix_stella*, uellix_grounding*), and the local
    // stack has stella_0004 applied so it never diverged there. The hosted path
    // does not, and the two contracts drifted in silence for the whole cutover.
    it('grants EXECUTE to the writer and the auditor, and never to uellix_app', () => {
      expect(runtimeHelperSql).toMatch(
        /GRANT EXECUTE ON FUNCTION[\s\S]*?TO uellix_writer, uellix_auditor;/
      )
      // uellix_app must reach these BY INHERITANCE. A direct grant would be a
      // second way for one principal to hold one privilege, and only one of the
      // two would be measured.
      // The GRANT statement ITSELF, isolated: scanning the whole body would
      // match the §0.5 role list, which legitimately names uellix_app in order
      // to assert that the role exists.
      const grant = /GRANT EXECUTE ON FUNCTION[\s\S]*?;/.exec(runtimeHelperExec)?.[0] ?? ''
      expect(grant).toContain('uellix_writer, uellix_auditor')
      expect(grant).not.toContain('uellix_app')
    })

    it('asserts the EFFECTIVE privilege of uellix_app, not merely the grant', () => {
      // Asserting only the grant would pass on a database whose
      // uellix_app -> uellix_writer membership had been dropped, shipping a
      // contract that reaches nobody.
      expect(runtimeHelperSql).toContain("('uellix_writer'), ('uellix_auditor'), ('uellix_app')")
      expect(runtimeHelperSql).toContain("pg_has_role('uellix_app', 'uellix_writer', 'USAGE')")
    })

    it('hardens all three helper bodies against pg_temp shadowing', () => {
      for (const fn of PRECHAIN_RUNTIME_HELPER_CONTRACT.normalisedFunctions) {
        expect(runtimeHelperSql).toContain(fn.replace(/\(.*\)$/, ''))
      }
      // Three CREATE OR REPLACE, three empty search_paths, and both relations
      // schema-qualified everywhere they appear in a published body.
      expect(runtimeHelperExec.match(/CREATE OR REPLACE FUNCTION public\./g)).toHaveLength(3)
      // Counted inside the PUBLISHED bodies only: §3's refusal messages quote the
      // clause verbatim so an operator can read what is missing, and those quotes
      // are not statements.
      const bodies = runtimeHelperExec.match(
        /CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g
      ) ?? []
      expect(bodies).toHaveLength(3)
      for (const b of bodies) expect(b).toContain("SET search_path = ''")
      expect(runtimeHelperSql).toContain('FROM public.organization_members om')
      expect(runtimeHelperSql).toContain('FROM public.users u')
    })

    it('drives an ACTIVE pg_temp probe that refuses to pass vacuously', () => {
      // A structural check says the body LOOKS right. The package additionally
      // shadows both relations through pg_temp and requires the helpers to
      // ignore them — and first confirms auth.uid() resolves, because with a
      // NULL subject every assertion would pass without exercising anything.
      expect(runtimeHelperSql).toContain('CREATE TEMP TABLE users')
      expect(runtimeHelperSql).toContain('CREATE TEMP TABLE organization_members')
      expect(runtimeHelperSql).toContain('could not establish a subject')
    })

    it('classifies three prestates and refuses the third', () => {
      expect(runtimeHelperSql).toContain('VULNERABLE_PRESTATE')
      expect(runtimeHelperSql).toContain('HARDENED_PRESTATE')
      expect(runtimeHelperSql).toContain('is in a state this package cannot account for')
      // PG 17 stores SET search_path = '' as search_path="" — QUOTED. A check
      // that only knew the bare form would classify a hardened database as
      // vulnerable and republish bodies nobody asked it to touch.
      expect(runtimeHelperSql).toContain(`'search_path=""'`)
    })

    it('introduces no schema privilege, no policy change and no project reference', () => {
      expect(runtimeHelperStatements).not.toMatch(/GRANT\s+USAGE\s+ON\s+SCHEMA/i)
      expect(runtimeHelperStatements).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY/i)
      expect(runtimeHelperStatements).not.toMatch(/ALTER\s+FUNCTION[\s\S]{0,80}OWNER\s+TO/i)
      // LINE-ANCHORED, the idiom the sibling suites use for "issues no X": the
      // §3 refusal messages name CREATE ROLE and DROP ROLE in prose, and the
      // literal-stripper cannot be relied on to remove them — this package
      // writes `search_path = ''''`, whose doubled quotes desynchronise a
      // regex-based string scanner. A statement, unlike prose, starts a line.
      expect(runtimeHelperExec).not.toMatch(/^\s*(CREATE|DROP)\s+ROLE\b/im)
      expect(runtimeHelperExec).not.toMatch(/^\s*(CREATE|DROP)\s+SCHEMA\b/im)
      // A 20-lowercase-letter token is a Supabase project ref. The package must
      // be applicable to any affected environment, so it may name none.
      expect(runtimeHelperExec).not.toMatch(/\b[a-z]{20}\b/)
    })

    // CROSS-ENVIRONMENT CONTRACT. The local model and the hosted model must not
    // drift again on the two properties that drifted this time.
    it('publishes the same hardened bodies the local cutover publishes', () => {
      const local = read('stella_0005_runtime_cutover.sql')
      for (const marker of [
        'FROM public.organization_members om',
        'FROM public.users u',
        "SET search_path = ''",
      ]) {
        expect(local).toContain(marker)
        expect(runtimeHelperSql).toContain(marker)
      }
    })

    it('grants the same helpers to the same roles the local role separation does', () => {
      const local = read('stella_0004_role_separation.sql')
      // stella_0004 §6b — the statement this package reproduces for hosted.
      expect(local).toMatch(
        /GRANT EXECUTE ON FUNCTION\s+public\.current_user_org_ids\(\),\s+public\.current_user_is_super_admin\(\),\s+public\.current_user_role_in_org\(uuid\)\s+TO uellix_writer, uellix_auditor;/
      )
      expect(runtimeHelperSql).toMatch(
        /GRANT EXECUTE ON FUNCTION\s+public\.current_user_org_ids\(\),\s+public\.current_user_is_super_admin\(\),\s+public\.current_user_role_in_org\(uuid\)\s+TO uellix_writer, uellix_auditor;/
      )
    })
  })

  it('pins the storage-usage unit and finds it on disk', () => {
    expect(existsSync(path.join(ROOT, PRECHAIN_STORAGE_USAGE.sourceFile))).toBe(true)
    expect(sha256OfPreparedSql(usageSql)).toBe(PRECHAIN_STORAGE_USAGE.sourceSha256)
  })

  it('neither unit is in HOSTED_CHAIN or takes a chain witness', () => {
    for (const unit of PRECHAIN_ADMINISTRATIVE_UNITS) {
      expect(HOSTED_CHAIN, unit.id).not.toContain(unit.id)
      expect(WITNESSED_PACKAGES, unit.id).not.toContain(unit.id)
    }
  })

  it('the ORDER is enforced by the package, not by the harness loop', () => {
    // stella_hosted_0004 refuses unless a SECURITY DEFINER helper is already
    // owned by uellix_owner. If it were ever applied first it would abort rather
    // than grant a privilege to a role that does not yet need it, so a harness
    // that reordered the two would get a refusal instead of a silent swap.
    expect(usageSql).toMatch(/apply stella_hosted_0003_storage_helper_ownership\.sql first/)
    expect(usageSql).toMatch(/pg_get_userbyid\(p\.proowner\) = 'uellix_owner'/)
  })

  it('grants ONE privilege on ONE schema, and no table privilege', () => {
    const executableUsage = stripSqlSurface(usageSql)
    const grants = [...executableUsage.matchAll(/^\s*GRANT\s+([\s\S]*?);/gim)]
    expect(grants).toHaveLength(1)
    expect(grants[0]![1].replace(/\s+/g, ' ').trim()).toBe('USAGE ON SCHEMA storage TO uellix_owner')
    expect(executableUsage).not.toMatch(/^\s*REVOKE/im)
    // The three facts stella_0005d asserts, carried across verbatim.
    expect(usageSql).toMatch(/gained a table privilege on storage\.objects/)
    expect(usageSql).toMatch(/storage\.foldername\(text\)/)
    expect(usageSql).toMatch(/uellix_app/)
  })

  it('all three are declared forward-only with substantial reasons', () => {
    for (const unit of PRECHAIN_ADMINISTRATIVE_UNITS) {
      const entry = forwardOnlyPackage(unit.id)
      expect(entry, unit.id).not.toBeNull()
      expect(entry!.reason.length, unit.id).toBeGreaterThan(200)
    }
  })
})

/**
 * M-2 — the TABLE-READ unit, and the ways a diff could widen it.
 *
 * Fable's final blocker. `uellix_owner` owned both helpers and held USAGE on
 * schema storage, and every one of the nine role-matrix cases was still refused,
 * on read as well as on write, because the definer could not SELECT
 * public.organization_members and the bodies swallow their own permission error.
 *
 * Every `it` below is an attack that must fail on a widened package.
 */
describe('the prechain TABLE-READ unit grants exactly one privilege on one table', () => {
  const readSql = readFileSync(path.join(ROOT, PRECHAIN_STORAGE_TABLE_READ.sourceFile), 'utf8')
  const executableRead = stripSqlSurface(readSql)

  it('exists at the path the registry names, and hashes to its pin', () => {
    expect(existsSync(path.join(ROOT, PRECHAIN_STORAGE_TABLE_READ.sourceFile))).toBe(true)
    expect(sha256OfPreparedSql(readSql)).toBe(PRECHAIN_STORAGE_TABLE_READ.sourceSha256)
  })

  it('pins the LF-normalized bytes, so a CRLF checkout is not a different package', () => {
    expect(sha256OfPreparedSql(readSql.replace(/\n/g, '\r\n'))).toBe(
      PRECHAIN_STORAGE_TABLE_READ.sourceSha256,
    )
  })

  it('is NOT a chain member and takes no chain witness', () => {
    expect(HOSTED_CHAIN).not.toContain(PRECHAIN_STORAGE_TABLE_READ.id)
    expect(WITNESSED_PACKAGES).not.toContain(PRECHAIN_STORAGE_TABLE_READ.id)
  })

  it('issues exactly ONE GRANT, for SELECT, on organization_members, to uellix_owner', () => {
    // The attack this closes: a second GRANT, a wider privilege list, or a
    // different role smuggled into a package whose contract says "one".
    const grants = [...executableRead.matchAll(/^\s*GRANT\s+([\s\S]*?);/gim)]
    expect(grants).toHaveLength(1)
    expect(grants[0]![1].replace(/\s+/g, ' ').trim()).toBe(
      'SELECT ON TABLE public.organization_members TO uellix_owner',
    )
  })

  it('issues no REVOKE, no ALTER, no CREATE and no DROP', () => {
    // A package that granted and revoked in one breath would pass a naive
    // "one GRANT" check. So would one that altered an owner on the way past.
    expect(executableRead).not.toMatch(/^\s*REVOKE\b/im)
    expect(executableRead).not.toMatch(/^\s*ALTER\s+(TABLE|FUNCTION|ROLE|POLICY|SCHEMA)\b/im)
    expect(executableRead).not.toMatch(/^\s*CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|POLICY|ROLE|TABLE)\b/im)
    expect(executableRead).not.toMatch(/^\s*DROP\b/im)
  })

  it('grants no WRITE privilege, in the SQL or in its contract', () => {
    expect(executableRead).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i)
    // And §2 asserts the absence of all six, not just the obvious three.
    for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(readSql, priv).toContain(`('${priv}')`)
    }
  })

  it('grants no GRANT OPTION, and asserts it did not', () => {
    expect(executableRead).not.toMatch(/GRANT[^;]*WITH\s+GRANT\s+OPTION/i)
    expect(readSql).toMatch(/is_grantable/)
  })

  it('names uellix_owner and no other grantee', () => {
    // The wrong-role attack: `TO uellix_app` would hand the RUNTIME role a read
    // of the membership table, which is a different and much larger change.
    const grantTargets = [...executableRead.matchAll(/GRANT[^;]*?\bTO\s+([a-z_ ,]+)/gi)].map((m) =>
      m[1].trim(),
    )
    expect(grantTargets).toEqual(['uellix_owner'])
    expect(executableRead).not.toMatch(/GRANT[^;]*TO[^;]*\b(uellix_app|uellix_migrator|authenticated|anon|PUBLIC|service_role)\b/i)
  })

  it('refuses when applied out of order — before ownership, or before storage USAGE', () => {
    // The ordering is enforced by the PACKAGE, so a harness that reordered the
    // three gets a refusal rather than a silent swap.
    expect(readSql).toMatch(/apply stella_hosted_0003_storage_helper_ownership\.sql first/i)
    expect(readSql).toMatch(/apply stella_hosted_0004_storage_schema_usage\.sql first/i)
    expect(readSql).toMatch(/has_schema_privilege\('uellix_owner', 'storage', 'USAGE'\)/)
    expect(readSql).toMatch(/pg_get_userbyid\(p\.proowner\) = 'uellix_owner'/)
  })

  it('asserts BOTH helpers, not only the write one', () => {
    // The read helper was equally dead, and a package that only checked the
    // write side would have certified half a repair.
    expect(readSql).toContain('can_read_evidence_object')
    expect(readSql).toContain('can_write_evidence_object')
  })

  it('asserts projects rather than granting it — the complete surface, one owner each', () => {
    expect(readSql).toMatch(/has_table_privilege\('uellix_owner', 'public\.projects', 'SELECT'\)/)
    expect(executableRead).not.toMatch(/GRANT[^;]*public\.projects/i)
    expect(readSql).toContain('stella_hosted_0001')
  })

  it('asserts the RLS helper functions the SELECT policies invoke', () => {
    // Measured: both tables have RLS enabled, uellix_owner owns neither and
    // holds no BYPASSRLS, so the policies run for the definer. A missing
    // EXECUTE there fails for SOME callers, which is harder to find than a
    // total outage.
    expect(readSql).toContain('current_user_org_ids()')
    expect(readSql).toContain('current_user_is_super_admin()')
  })

  it('aborts on an unknown posture instead of normalising it', () => {
    expect(readSql).toMatch(/already holds a WRITE privilege/i)
  })

  it('proves scope as a measured DELTA, not against a hand-picked canary list', () => {
    // A literal list would have been WRONG here: uellix_owner owns
    // public.stella_interactions and therefore reads it implicitly, so a canary
    // asserting "no other SELECT" would fail on a correct database.
    expect(readSql).toContain('stella_hosted_0005.select_surface')
    expect(readSql).toMatch(/EXCEPT/)
    expect(readSql).toMatch(/LOST SELECT/)
  })

  it('fingerprints the helpers and the storage policies, and compares them after', () => {
    // The "new package changes function body/ACL/owner" attack.
    expect(readSql).toContain('stella_hosted_0005.helpers')
    expect(readSql).toContain('stella_hosted_0005.storage_policies')
    expect(readSql).toMatch(/pg_get_functiondef/)
    expect(readSql).toMatch(/proacl/)
  })

  it('declares what it is for, and names the guard it unblocks', () => {
    expect(PRECHAIN_STORAGE_TABLE_READ.purpose.length).toBeGreaterThan(200)
    expect(PRECHAIN_STORAGE_TABLE_READ.unblocks).toContain('stella_0019_storage_write_roles')
    expect(PRECHAIN_STORAGE_TABLE_READ.destinationOwner).toBe('uellix_owner')
    // It normalises no function — that was 0003's job and it says so.
    expect(PRECHAIN_STORAGE_TABLE_READ.normalisedFunctions).toHaveLength(0)
  })
})
