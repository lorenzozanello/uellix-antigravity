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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  ADMINISTRATIVE_UNIT_CONTRACT_VIOLATION,
  ADMINISTRATIVE_UNITS,
  assertAdministrativeUnitContract,
  forwardOnlyReasonOf,
  POSTCHAIN_ADMINISTRATIVE_UNITS,
  PRECHAIN_ADMINISTRATIVE_UNITS,
  PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY,
  PRECHAIN_LEDGER_MODEL_DEFAULT,
  PRECHAIN_OWNERSHIP,
  PRECHAIN_RUNTIME_HELPER_CONTRACT,
  PRECHAIN_RUNTIME_TABLE_ACL,
  PRECHAIN_STORAGE_TABLE_READ,
  PRECHAIN_STORAGE_USAGE,
  sha256OfPreparedSql,
  type PrechainOwnershipPackage,
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

  it('declares all seven units in application order', () => {
    expect(ADMINISTRATIVE_UNITS.map((u) => u.id)).toEqual([
      PRECHAIN_OWNERSHIP.id,
      PRECHAIN_STORAGE_USAGE.id,
      PRECHAIN_STORAGE_TABLE_READ.id,
      // RT-01. Fourth because it depends on nothing the first three publish and
      // publishes nothing they need: it repairs the BASELINE helper contract for
      // the application runtime, where the first three repair the Storage helper
      // contract for the installer. Ordering it after them keeps the trio's own
      // argument — 0004 needs 0003, 0005 needs both — readable as a unit.
      PRECHAIN_RUNTIME_HELPER_CONTRACT.id,
      // RT-02. Its position IS load-bearing, unlike RT-01's: its §0.3b refuses
      // unless uellix_app can already execute the three RLS helpers, because
      // every policy on the tables it grants calls them and a table privilege
      // without them buys nothing.
      PRECHAIN_RUNTIME_TABLE_ACL.id,
      // G1-B. After RT-02 and enforced by the package: its §0.3 refuses unless
      // uellix_app already holds the INSERT privilege RT-02 grants.
      PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY.id,
      // G1-B. Last, and the only member whose WINDOW is postchain: its
      // dead-default proof cannot pass until stella_0017 (T8) has withdrawn the
      // baseline INSERT grant from authenticated and service_role.
      PRECHAIN_LEDGER_MODEL_DEFAULT.id,
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

  /**
   * RT-02 — the TABLE half, and the CROSS-ENVIRONMENT CONTRACT.
   *
   * THE ASSERTION WHOSE ABSENCE LET THIS SHIP TWICE. Nothing in this repository
   * compared the local table-privilege contract against the hosted one, so
   * stella_0004 §6a/§6b/§6c could be — and were — omitted from hosted entirely
   * while 7925 tests stayed green. Every test that mentioned uellix_writer
   * asserted against the LOCAL stack, where stella_0004 is applied.
   *
   * The block below is that comparison, and it is deliberately an EQUALITY with
   * a DECLARED amendment list rather than a subset check: a hosted contract that
   * is quietly narrower is the same class of defect as one that is quietly
   * absent, and an amendment is only legitimate when a package that is ACTUALLY
   * INSTALLED on the hosted chain justifies it.
   */
  describe('RT-02 — the runtime table ACL contract, against the local canon', () => {
    const tableAclSql = readFileSync(
      path.join(ROOT, PRECHAIN_RUNTIME_TABLE_ACL.sourceFile),
      'utf8'
    )
    const canonSql = read('stella_0004_role_separation.sql')

    /** Top-level GRANTs only: $$-bodies are collapsed so the §5 conditional
     *  literals and every refusal message inside a DO block are out of scope. */
    const topLevelGrants = (sql: string) => {
      const code = sql.replace(/--[^\n]*/g, '').replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$body$$')
      return code
        .split(';')
        .map((s) => s.trim())
        .filter((s) => /^GRANT\b/i.test(s))
        .map((s) => /^GRANT\s+([\s\S]*?)\s+ON\s+([\s\S]*?)\s+TO\s+([\s\S]*)$/i.exec(s))
        .filter((m): m is RegExpExecArray => m !== null)
        .filter((m) => !/^\s*FUNCTION\b/i.test(m[2]))
        .map((m) => ({
          privs: m[1].split(',').map((p) => p.trim().toUpperCase()).sort(),
          tables: [...new Set(m[2].match(/public\.[a-z_]+/g) ?? [])].sort(),
          grantees: m[3].split(',').map((g) => g.trim()).sort(),
        }))
    }

    /** table -> sorted privilege list, for one grantee, across every GRANT. */
    const contractFor = (sql: string, grantee: string): Record<string, string[]> => {
      const out: Record<string, string[]> = {}
      for (const g of topLevelGrants(sql)) {
        if (!g.grantees.includes(grantee)) continue
        for (const t of g.tables) {
          out[t] = [...new Set([...(out[t] ?? []), ...g.privs])].sort()
        }
      }
      return out
    }

    const hostedWriter = contractFor(tableAclSql, 'uellix_writer')
    const hostedAuditor = contractFor(tableAclSql, 'uellix_auditor')
    const canonWriter = contractFor(canonSql, 'uellix_writer')
    const canonAuditor = contractFor(canonSql, 'uellix_auditor')

    /**
     * Every deliberate difference between the two, and the INSTALLED package
     * that makes it correct. A difference not listed here fails the equality
     * below; a package named here that is not on the hosted chain fails too.
     */
    const AMENDMENTS = [
      {
        table: 'public.stella_interactions',
        canon: ['INSERT', 'SELECT'],
        hosted: ['SELECT'],
        supersededBy: 'stella_0017_governed_stella_consumption',
        because:
          'R6-INT: INSERT, UPDATE, DELETE and TRUNCATE were revoked from uellix_writer AND ' +
          'uellix_app; the ledger is charged through the governed ticket protocol.',
      },
      {
        table: 'public.stella_suggestion_decisions',
        canon: ['INSERT', 'SELECT'],
        hosted: null, // conditional — granted by §5 only where the table exists
        supersededBy: null,
        because:
          'PACKAGE_NOT_INSTALLED: no baseline unit creates it, it is absent from ' +
          'hosted-package-manifest.ts, and stella_0003 has never been applied hosted.',
      },
    ] as const

    it('is registered, pinned, and found on disk', () => {
      expect(existsSync(path.join(ROOT, PRECHAIN_RUNTIME_TABLE_ACL.sourceFile))).toBe(true)
      expect(sha256OfPreparedSql(tableAclSql)).toBe(PRECHAIN_RUNTIME_TABLE_ACL.sourceSha256)
      expect(sha256OfPreparedSql(tableAclSql.replace(/\n/g, '\r\n'))).toBe(
        PRECHAIN_RUNTIME_TABLE_ACL.sourceSha256
      )
    })

    it('is NOT a chain member and takes no chain witness', () => {
      expect(HOSTED_CHAIN).not.toContain(PRECHAIN_RUNTIME_TABLE_ACL.id)
      expect(WITNESSED_PACKAGES).not.toContain(PRECHAIN_RUNTIME_TABLE_ACL.id)
    })

    it('every amendment is justified by a package INSTALLED on the hosted chain', () => {
      // The load-bearing guard against "amend the contract to make it pass".
      for (const a of AMENDMENTS) {
        if (a.supersededBy === null) continue
        expect(HOSTED_CHAIN, `${a.table}: ${a.supersededBy} is not on the hosted chain`).toContain(
          a.supersededBy
        )
        expect(a.because.length).toBeGreaterThan(60)
      }
    })

    it('CROSS-ENV: the hosted writer contract equals the local canon, amendments aside', () => {
      const amended = new Map(AMENDMENTS.map((a) => [a.table as string, a.hosted]))
      const canonTables = Object.keys(canonWriter).sort()
      const hostedTables = Object.keys(hostedWriter).sort()

      // (a) Nothing the canon grants may be silently missing, and nothing the
      //     hosted package grants may be absent from the canon.
      const expectedHosted = canonTables.filter((t) => !amended.has(t) || amended.get(t) !== null)
      expect(hostedTables, 'the hosted table SET diverges from stella_0004 §6a/§6b').toEqual(
        expectedHosted.sort()
      )

      // (b) And per table, the privilege set must match exactly — this is what
      //     catches a missing SELECT, a missing write privilege, and an
      //     append-only widening, in one comparison.
      for (const t of hostedTables) {
        const want = amended.has(t) ? (amended.get(t) as readonly string[]) : canonWriter[t]
        expect(hostedWriter[t], `${t} diverges from the canon`).toEqual([...want].sort())
      }
    })

    it('CROSS-ENV: the hosted auditor contract equals the local canon, amendments aside', () => {
      const conditional = new Set(
        AMENDMENTS.filter((a) => a.hosted === null).map((a) => a.table as string)
      )
      const expected = Object.keys(canonAuditor)
        .filter((t) => !conditional.has(t))
        .sort()
      expect(Object.keys(hostedAuditor).sort()).toEqual(expected)
      for (const t of expected) {
        expect(hostedAuditor[t], `auditor ${t}`).toEqual(['SELECT'])
      }
    })

    it('classifies every granted table exactly once, into a known class', () => {
      const appendOnly = Object.entries(hostedWriter)
        .filter(([, p]) => p.join() === 'INSERT,SELECT')
        .map(([t]) => t)
      const governedRead = Object.entries(hostedWriter)
        .filter(([, p]) => p.join() === 'SELECT')
        .map(([t]) => t)
      const operational = Object.entries(hostedWriter)
        .filter(([, p]) => p.join() === 'DELETE,INSERT,SELECT,UPDATE')
        .map(([t]) => t)

      expect(appendOnly).toHaveLength(3)
      expect(governedRead).toEqual(['public.stella_interactions'])
      expect(operational).toHaveLength(33)
      // No fourth shape: every table falls in exactly one of the three.
      expect(appendOnly.length + governedRead.length + operational.length).toBe(
        Object.keys(hostedWriter).length
      )
    })

    it('grants NOTHING on the two capability-only tables, and says so', () => {
      // grounding_0002/0003 revoke ALL from uellix_writer BY NAME and grant
      // SELECT to uellix_app directly. A GRANT here would silently reverse a
      // governed decision.
      for (const t of ['public.evidence_chunks', 'public.evidence_document_versions']) {
        expect(hostedWriter[t], `${t} must not be granted to the writer`).toBeUndefined()
        expect(hostedAuditor[t], `${t} must not be granted by THIS package`).toBeUndefined()
      }
      expect(tableAclSql).toContain('grounding_0002_document_versions')
      expect(tableAclSql).toContain('grounding_0003_evidence_chunks')
    })

    it('never grants a STRUCTURAL privilege, to anyone, anywhere', () => {
      for (const g of topLevelGrants(tableAclSql)) {
        for (const forbidden of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'ALL']) {
          expect(g.privs, `a GRANT names ${forbidden}`).not.toContain(forbidden)
        }
      }
    })

    it('never names uellix_app as a grantee — the runtime inherits', () => {
      for (const g of topLevelGrants(tableAclSql)) {
        expect(g.grantees, 'uellix_app must never be a direct grantee').not.toContain('uellix_app')
      }
      // ...and it asserts the EFFECTIVE privilege instead of only the grant.
      expect(tableAclSql).toContain("has_table_privilege('uellix_app'")
      expect(tableAclSql).toContain("pg_has_role('uellix_app', 'uellix_writer', 'USAGE')")
    })

    it('issues no REVOKE, no DDL and no policy change', () => {
      const executableAcl = stripSqlSurface(tableAclSql).replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$b$$')
      expect(executableAcl).not.toMatch(/^\s*REVOKE\b/im)
      expect(executableAcl).not.toMatch(/^\s*(CREATE|DROP|ALTER)\s+(TABLE|POLICY|ROLE|SCHEMA|FUNCTION)\b/im)
      expect(executableAcl).not.toMatch(/^\s*(CREATE|DROP|ALTER)\s+POLICY\b/im)
      expect(executableAcl).not.toMatch(/ROW LEVEL SECURITY/i)
    })

    it('depends on RT-01 and enforces the order itself', () => {
      expect(tableAclSql).toContain('Apply stella_hosted_0006_runtime_rls_helper_contract.sql first')
      expect(tableAclSql).toContain("has_function_privilege('uellix_app'")
      // Stated as a RELATIVE order rather than as "last" and "second to last".
      // The absolute form was written when RT-02 was the final unit, and it
      // asserted the length of the list as a side effect: G1-B appending two
      // units broke it without weakening anything it was defending. What is
      // load-bearing is that RT-02 follows RT-01, and it stays checked.
      const idx = (id: string) => ADMINISTRATIVE_UNITS.findIndex((u) => u.id === id)
      expect(idx(PRECHAIN_RUNTIME_HELPER_CONTRACT.id)).toBeGreaterThanOrEqual(0)
      expect(idx(PRECHAIN_RUNTIME_TABLE_ACL.id)).toBeGreaterThan(
        idx(PRECHAIN_RUNTIME_HELPER_CONTRACT.id),
      )
    })

    it('classifies three prestates and refuses the third', () => {
      expect(tableAclSql).toContain('MISSING_RUNTIME_ACL')
      expect(tableAclSql).toContain('CANONICAL_RUNTIME_ACL')
      expect(tableAclSql).toContain('MIXED states')
      expect(tableAclSql).toContain('cannot account for')
    })

    it('returns the session after its SET LOCAL ROLE, and asserts it did', () => {
      // The one grant that needs uellix_owner. A package that changed role and
      // did not change back would measure the OWNER's privileges in §6.
      expect(tableAclSql).toMatch(/SET LOCAL ROLE uellix_owner;/)
      expect(tableAclSql).toMatch(/^RESET ROLE;$/m)
      expect(tableAclSql).toContain('current_user <> session_user')
    })

    it('handles the absent fifth append-only table without failing or ignoring it', () => {
      expect(tableAclSql).toContain('PACKAGE_NOT_INSTALLED')
      expect(tableAclSql).toContain("to_regclass('public.stella_suggestion_decisions') IS NULL")
      expect(tableAclSql).toContain('STELLA_DECISIONS_PERSISTENCE_ENABLED')
      // It is NOT in db/migrations, which is what makes the absence legitimate.
      expect(
        readdirSync(path.join(ROOT, 'db/migrations'))
          .filter((f) => f.endsWith('.sql'))
          .some((f) =>
            /CREATE TABLE\s+(IF NOT EXISTS\s+)?(public\.)?stella_suggestion_decisions/i.test(
              readFileSync(path.join(ROOT, 'db/migrations', f), 'utf8')
            )
          ),
        'a baseline migration creates it after all — the absence would then be DRIFT'
      ).toBe(false)
    })

    it('is declared forward-only with a substantial reason', () => {
      const entry = forwardOnlyPackage(PRECHAIN_RUNTIME_TABLE_ACL.id)
      expect(entry).not.toBeNull()
      expect(entry!.reason.length).toBeGreaterThan(200)
      expect(entry!.reversalPath.length).toBeGreaterThan(40)
      expect(existsSync(path.join(ROOT, 'db/prepared/stella_hosted_0007_rollback.sql'))).toBe(false)
    })
  })

  it('pins the storage-usage unit and finds it on disk', () => {
    expect(existsSync(path.join(ROOT, PRECHAIN_STORAGE_USAGE.sourceFile))).toBe(true)
    expect(sha256OfPreparedSql(usageSql)).toBe(PRECHAIN_STORAGE_USAGE.sourceSha256)
  })

  it('neither unit is in HOSTED_CHAIN or takes a chain witness', () => {
    for (const unit of ADMINISTRATIVE_UNITS) {
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

  it('the reversibility contract holds for the real registry, and REFUSES the five bad shapes', () => {
    // F-4A. TypeScript can say `string | null` on three fields; it cannot say
    // "exactly one side of this is populated". The invariant is a function so
    // it runs at module load over the real registry — and so the refusals can
    // be exercised here rather than reasoned about.
    expect(() => assertAdministrativeUnitContract(ADMINISTRATIVE_UNITS)).not.toThrow()

    const withRollback = ADMINISTRATIVE_UNITS.find((u) => u.rollbackFile !== null)!
    const forwardOnly = ADMINISTRATIVE_UNITS.find((u) => u.rollbackFile === null)!
    const bad: readonly [string, PrechainOwnershipPackage][] = [
      ['rollbackFile without a digest', { ...withRollback, rollbackSha256: null }],
      ['a digest without a rollbackFile', { ...withRollback, rollbackFile: null }],
      [
        'forward-only carrying a rollback digest',
        { ...forwardOnly, rollbackSha256: 'a'.repeat(64) },
      ],
      [
        'all three null',
        { ...forwardOnly, forwardOnlyNoRollbackReason: null },
      ],
      [
        'all three non-null',
        { ...withRollback, forwardOnlyNoRollbackReason: 'a reason it must not have' },
      ],
    ]
    for (const [label, unit] of bad) {
      expect(() => assertAdministrativeUnitContract([unit]), label).toThrow(
        new RegExp(ADMINISTRATIVE_UNIT_CONTRACT_VIOLATION),
      )
    }
  })

  it('every unit declares EITHER a rollback OR a forward-only reason, never both', () => {
    // The invariant that replaced "prechain implies forward-only" when G1-B
    // added the first two units that reverse exactly. Checked in BOTH
    // directions: a unit declaring both would be a unit whose author had not
    // decided, and a unit declaring neither would be one nobody had asked.
    for (const unit of ADMINISTRATIVE_UNITS) {
      const shipsRollback = unit.rollbackFile !== null
      const declaresReason = unit.forwardOnlyNoRollbackReason !== null
      expect(shipsRollback !== declaresReason, `${unit.id}: exactly one of the two`).toBe(true)
    }
  })

  it('a forward-only unit is in the forward-only registry with a substantial reason', () => {
    for (const unit of ADMINISTRATIVE_UNITS.filter((u) => u.rollbackFile === null)) {
      const entry = forwardOnlyPackage(unit.id)
      expect(entry, unit.id).not.toBeNull()
      expect(entry!.reason.length, unit.id).toBeGreaterThan(200)
    }
  })

  it('a unit that SHIPS a rollback is absent from the forward-only registry, and the file exists', () => {
    // The other half, and the one a copy-paste would get wrong: adding a new
    // unit by duplicating a forward-only entry would declare "no rollback"
    // beside a rollback script that is right there on disk.
    const withRollback = ADMINISTRATIVE_UNITS.filter((u) => u.rollbackFile !== null)
    expect(withRollback.length, 'G1-B added two').toBeGreaterThanOrEqual(2)
    for (const unit of withRollback) {
      expect(forwardOnlyPackage(unit.id), unit.id).toBeNull()
      expect(existsSync(path.join(ROOT, unit.rollbackFile!)), unit.rollbackFile!).toBe(true)
    }
  })

  it('forwardOnlyReasonOf REFUSES a unit that ships a rollback', () => {
    // The derivation forward-only-packages.ts performs. It must fail loudly
    // rather than contribute an empty reason to a registry whose whole content
    // is reasons.
    expect(() => forwardOnlyReasonOf(PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY)).toThrow(
      /PRECHAIN_UNIT_SHIPS_A_ROLLBACK/,
    )
    expect(forwardOnlyReasonOf(PRECHAIN_OWNERSHIP).length).toBeGreaterThan(200)
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

/**
 * G1-B — the two units that made this registry stop meaning "forward-only".
 *
 * Their SQL contracts are pinned by their own suites
 * (tests/stella-audit-log-write-capability.test.ts,
 * tests/stella-db-model-default.test.ts). What this block pins is the thing
 * whose ABSENCE was the finding: that they are governed at all — registered,
 * digest-pinned to the bytes on disk, and not quietly promoted into the chain.
 */
describe('the G1-B prechain units are governed, pinned and outside the chain', () => {
  const G1B_UNITS = [PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY, PRECHAIN_LEDGER_MODEL_DEFAULT] as const

  it.each(G1B_UNITS.map((u) => [u.id, u] as const))(
    '%s: exists at the path the registry names',
    (_id, unit) => {
      expect(existsSync(path.join(ROOT, unit.sourceFile))).toBe(true)
    },
  )

  it.each(G1B_UNITS.map((u) => [u.id, u] as const))(
    '%s: the pinned digest is the digest of the bytes on disk',
    (_id, unit) => {
      // The assertion the previous revision could not make, because nothing
      // pinned these files at all: an operator running `pnpm artefact:verify`
      // had no governed digest to paste, only one somebody had computed.
      const sql = readFileSync(path.join(ROOT, unit.sourceFile), 'utf8')
      expect(sha256OfPreparedSql(sql)).toBe(unit.sourceSha256)
    },
  )

  it.each(G1B_UNITS.map((u) => [u.id, u] as const))(
    '%s: normalizes line endings before hashing, so a CRLF checkout still matches',
    (_id, unit) => {
      const sql = readFileSync(path.join(ROOT, unit.sourceFile), 'utf8')
      expect(sha256OfPreparedSql(sql.replace(/\n/g, '\r\n'))).toBe(unit.sourceSha256)
    },
  )

  it.each(G1B_UNITS.map((u) => [u.id, u] as const))(
    '%s: is NOT in HOSTED_CHAIN and takes no chain witness',
    (_id, unit) => {
      // stella_0020 is the one a reader will question, so the reason lives in
      // its registry entry: HOSTED_CHAIN *is* the manifest, so a manifest entry
      // is a governed chain link with a T-number, an authority window and
      // `uellix_migrator` as its only applying identity — and it would move
      // A1_EXPECTED_PACKAGE_COUNT, reclassifying an installation already
      // certified at 11/11 as incomplete.
      expect(HOSTED_CHAIN).not.toContain(unit.id)
      expect(WITNESSED_PACKAGES).not.toContain(unit.id)
    },
  )

  it('both rollbacks are PINNED to the bytes on disk', () => {
    // F-4. The forward file was pinned from the first revision and the rollback
    // was not, which left the reversal path — the thing an operator reaches for
    // while something is already wrong — as the only ungoverned bytes in the
    // unit. `pnpm artefact:verify` had no digest to compare against, so "this is
    // the rollback that was reviewed" was a hope.
    for (const unit of G1B_UNITS) {
      expect(unit.rollbackSha256, unit.id).not.toBeNull()
      const sql = readFileSync(path.join(ROOT, unit.rollbackFile!), 'utf8')
      expect(sha256OfPreparedSql(sql), unit.rollbackFile!).toBe(unit.rollbackSha256)
    }
  })

  it('the rollback pin is LF-normalized, so a CRLF checkout is not a different file', () => {
    for (const unit of G1B_UNITS) {
      const sql = readFileSync(path.join(ROOT, unit.rollbackFile!), 'utf8')
      expect(sha256OfPreparedSql(sql.replace(/\n/g, '\r\n')), unit.rollbackFile!).toBe(
        unit.rollbackSha256,
      )
    }
  })

  it('a rollback edited without re-pinning FAILS — the tripwire, exercised', () => {
    // The property the two tests above only assert for today's bytes. Here the
    // bytes are perturbed in memory and the pin must reject them, so "the pin
    // would have caught it" is measured rather than assumed.
    for (const unit of G1B_UNITS) {
      const sql = readFileSync(path.join(ROOT, unit.rollbackFile!), 'utf8')
      expect(sha256OfPreparedSql(`${sql}\n-- an edit nobody re-pinned\n`)).not.toBe(
        unit.rollbackSha256,
      )
    }
  })

  it('both are declared with a rollback, and it is the sibling of the forward file', () => {
    for (const unit of G1B_UNITS) {
      expect(unit.rollbackFile, unit.id).not.toBeNull()
      expect(unit.forwardOnlyNoRollbackReason, unit.id).toBeNull()
      // Naming convention, asserted rather than trusted: the source-of-truth
      // suite derives `<family>_<NNNN>_rollback.sql` from the forward name, and
      // a registry pointing somewhere else would satisfy this registry while
      // failing that one.
      const family = /^(.+_\d{4})_/.exec(path.basename(unit.sourceFile))
      expect(family, unit.sourceFile).not.toBeNull()
      expect(unit.rollbackFile).toBe(`db/prepared/${family![1]}_rollback.sql`)
    }
  })

  it('both registry entries state a purpose and what they unblock', () => {
    for (const unit of G1B_UNITS) {
      expect(unit.purpose.length, unit.id).toBeGreaterThan(200)
      expect(unit.unblocks.length, unit.id).toBeGreaterThan(80)
      expect(unit.unblocks, unit.id).toContain('G1-B')
    }
  })

  it('neither declares a normalised function — neither transfers ownership', () => {
    // The field the registry was named for. Empty here, and empty for RT-01 and
    // RT-02 before them: the kind is the CHANNEL, not the operation.
    for (const unit of G1B_UNITS) expect(unit.normalisedFunctions, unit.id).toEqual([])
  })
})

/**
 * THE APPLY WINDOW, and the measurement that forced it to exist.
 *
 * The first attempt at G1-B governance put stella_0020 in the prechain list.
 * `pnpm certify:pg176` applied it there and it ABORTED, naming `authenticated`
 * and `service_role` — Supabase default privileges on the baseline table, which
 * stella_0017 (T8, a CHAIN link) is what withdraws. The package was right and
 * the list was wrong, so the WINDOW became data instead of an assumption.
 */
describe('the apply window is recorded, and the two lists are derived from it', () => {
  it('every unit declares a window, and the two lists partition the whole set', () => {
    for (const unit of ADMINISTRATIVE_UNITS) {
      expect(['prechain', 'postchain'], unit.id).toContain(unit.applyWindow)
    }
    expect([...PRECHAIN_ADMINISTRATIVE_UNITS, ...POSTCHAIN_ADMINISTRATIVE_UNITS]).toHaveLength(
      ADMINISTRATIVE_UNITS.length,
    )
    // Derived, never transcribed: a hand-kept second list is how a unit ends up
    // in one and not the other.
    expect(PRECHAIN_ADMINISTRATIVE_UNITS.every((u) => u.applyWindow === 'prechain')).toBe(true)
    expect(POSTCHAIN_ADMINISTRATIVE_UNITS.every((u) => u.applyWindow === 'postchain')).toBe(true)
  })

  it('the five installed units and stella_hosted_0008 are prechain', () => {
    // The window PRECHAIN_CLEAN describes. stella_hosted_0008 belongs here and
    // it is measured, not assumed: certify:pg176 applies it before T1, exit 0.
    expect(PRECHAIN_ADMINISTRATIVE_UNITS.map((u) => u.id)).toEqual([
      PRECHAIN_OWNERSHIP.id,
      PRECHAIN_STORAGE_USAGE.id,
      PRECHAIN_STORAGE_TABLE_READ.id,
      PRECHAIN_RUNTIME_HELPER_CONTRACT.id,
      PRECHAIN_RUNTIME_TABLE_ACL.id,
      PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY.id,
    ])
  })

  it('stella_0020 is the only postchain unit, and says why in its own type doc', () => {
    expect(POSTCHAIN_ADMINISTRATIVE_UNITS.map((u) => u.id)).toEqual([
      PRECHAIN_LEDGER_MODEL_DEFAULT.id,
    ])
    const registry = readFileSync(path.join(ROOT, 'db/hosted/prechain-ownership.ts'), 'utf8')
    expect(registry).toMatch(/applyWindow/)
    expect(registry).toContain('stella_0017')
    expect(registry).toContain('authenticated, service_role')
  })

  it('the two operator runbooks name ADMINISTRATIVE_UNITS as the authoritative registry', () => {
    // F-3. The partitions are DERIVED. A runbook that called
    // PRECHAIN_ADMINISTRATIVE_UNITS "the authoritative registry" would send a
    // reader to a list that is six of seven units by construction.
    const prechainRunbook = readFileSync(
      path.join(ROOT, 'docs/ops/staging/STELLA_PRECHAIN_OPERATOR_RUNBOOK.md'),
      'utf8',
    )
    expect(prechainRunbook).toMatch(
      /El registro autoritativo es \*\*?`?ADMINISTRATIVE_UNITS`?\*\*?|\*\*El registro autoritativo es `ADMINISTRATIVE_UNITS`\*\*/,
    )
    expect(prechainRunbook).toContain('particiones derivadas')
    expect(prechainRunbook).not.toMatch(
      /El registro autoritativo es\s*\n?`PRECHAIN_ADMINISTRATIVE_UNITS`/,
    )
  })

  it('neither runbook calls stella_0020 a prechain unit, or puts the two in one window', () => {
    // F-3. The family is "administrative unit"; the window is the thing that
    // differs. A sentence that collapses the two is how an operator applies a
    // postchain unit before T1 and gets an abort they cannot explain.
    for (const doc of [
      'docs/ops/staging/STELLA_PRECHAIN_OPERATOR_RUNBOOK.md',
      'docs/ops/runbooks/G1_B_GOVERNED_PREVIEW_RUNBOOK.md',
    ]) {
      const text = readFileSync(path.join(ROOT, doc), 'utf8')
      expect(text, doc).not.toMatch(/stella_0020[^\n]{0,80}sigue siendo prechain/)
      expect(text, doc).not.toMatch(/Los dos son \*\*unidades administrativas prechain\*\*/)
      // and where both are named together, the window distinction is present
      if (text.includes('stella_0020') && text.includes('stella_hosted_0008')) {
        expect(text, doc).toMatch(/applyWindow/)
        expect(text, doc).toMatch(/postchain/)
      }
    }
  })

  it('R1.5 states the chain-11/11 precondition INLINE, not behind a link', () => {
    // F-3. An operator reading R1.5 must learn that stella_0020 needs a
    // complete chain without following a cross-reference to find out.
    const g1b = readFileSync(
      path.join(ROOT, 'docs/ops/runbooks/G1_B_GOVERNED_PREVIEW_RUNBOOK.md'),
      'utf8',
    )
    const r15 = g1b.slice(g1b.indexOf('### R1.5'), g1b.indexOf('### R1.6'))
    expect(r15.length).toBeGreaterThan(500)
    expect(r15).toMatch(/11\/11/)
    expect(r15).toMatch(/stella_0017/)
    expect(r15).toMatch(/postchain/)
  })

  it('no operator command carries a corrupted line continuation', () => {
    // F-2. The R1.5 block lived inside a markdown blockquote and its `\`
    // continuation collapsed, leaving the quote marker INSIDE the command:
    //
    //     psql ... -v ON_ERROR_STOP=1 >      -f <file>
    //
    // which a shell reads as a redirect into a file named `-f`. The gate is
    // mechanical because the corruption was invisible in review.
    // Scanned inside FENCED BLOCKS only. The prose deliberately quotes the
    // broken form so the next reader knows what to look for, and a scanner that
    // could not tell an example from a command would be passed by deleting the
    // explanation — the same trap the SQL suites already resolve this way.
    for (const doc of [
      'docs/ops/staging/STELLA_PRECHAIN_OPERATOR_RUNBOOK.md',
      'docs/ops/runbooks/G1_B_GOVERNED_PREVIEW_RUNBOOK.md',
    ]) {
      const text = readFileSync(path.join(ROOT, doc), 'utf8')
      const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) =>
        m[1]!.split('\n'),
      )
      const offenders = fenced.filter(
        (line) => /ON_ERROR_STOP=\S*\s+>\s/.test(line) || /\s>\s+-f\s/.test(line),
      )
      expect(offenders, `${doc}: a quote marker landed inside a command`).toEqual([])
    }
  })

  it('the PowerShell operator blocks use backticks, never a bash backslash', () => {
    // F-2. `\` at end of line is a bash continuation and is NOT one in
    // PowerShell — it would run the first line alone and then fail on the rest.
    const g1b = readFileSync(
      path.join(ROOT, 'docs/ops/runbooks/G1_B_GOVERNED_PREVIEW_RUNBOOK.md'),
      'utf8',
    )
    const blocks = [...g1b.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) => m[1]!)
    expect(blocks.length, 'R1.5 must carry PowerShell blocks').toBeGreaterThan(0)
    const applyBlock = blocks.find((b) => b.includes('stella_hosted_0008_audit_log_write_capability'))
    expect(applyBlock, 'the apply block must be PowerShell').toBeDefined()
    expect(applyBlock!).toContain('$Psql')
    expect(applyBlock!).toContain('& $Psql')
    expect(applyBlock!).toContain('$env:UELLIX_STAGING_ADMIN_URL')
    for (const block of blocks) {
      expect(block, 'a bash line continuation in a PowerShell block').not.toMatch(/\\\s*\n/)
    }
    // The packages manage their own identity: no SET ROLE on the command line.
    expect(applyBlock!).not.toMatch(/SET ROLE/i)
  })

  it('the prechain runbook instructs verify-before-rollback, in order', () => {
    // F-4B. A rollback is reached for when something has already gone wrong,
    // which is exactly when nobody verifies. The order is the control.
    const text = readFileSync(
      path.join(ROOT, 'docs/ops/staging/STELLA_PRECHAIN_OPERATOR_RUNBOOK.md'),
      'utf8',
    )
    const section = text.slice(text.indexOf('## 6b.'), text.indexOf('## 7. PARADA DURA'))
    expect(section.length).toBeGreaterThan(600)
    expect(section).toContain('ADMINISTRATIVE_UNITS')
    expect(section).toContain('rollbackSha256')
    expect(section).toMatch(/LF-normalizado/)
    // and it must not turn a reversal into a reflex
    expect(section).toMatch(/NO es la reacción por defecto|NO se recomienda por defecto/)
    expect(section).toMatch(/NADA de esto se automatiza/)
  })

  it('both certification harnesses apply the postchain units, and pin them first', () => {
    // The channel must have a verifier, or "governed" is a word rather than a
    // property. Both harnesses refuse on a digest mismatch BEFORE applying.
    for (const script of ['scripts/pg176-certify.ts', 'scripts/remediation-certify.ts']) {
      const src = readFileSync(path.join(ROOT, script), 'utf8')
      expect(src, script).toContain('POSTCHAIN_ADMINISTRATIVE_UNITS')
      expect(src, script).toContain('POSTCHAIN_ADMIN_PIN_MISMATCH')
    }
  })
})
