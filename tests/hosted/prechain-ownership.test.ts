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


describe('the prechain PAIR, and the order that is load-bearing', () => {
  const usageSql = readFileSync(path.join(ROOT, PRECHAIN_STORAGE_USAGE.sourceFile), 'utf8')

  it('declares both units in application order', () => {
    expect(PRECHAIN_ADMINISTRATIVE_UNITS.map((u) => u.id)).toEqual([
      PRECHAIN_OWNERSHIP.id,
      PRECHAIN_STORAGE_USAGE.id,
    ])
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

  it('both halves are declared forward-only with substantial reasons', () => {
    for (const unit of PRECHAIN_ADMINISTRATIVE_UNITS) {
      const entry = forwardOnlyPackage(unit.id)
      expect(entry, unit.id).not.toBeNull()
      expect(entry!.reason.length, unit.id).toBeGreaterThan(200)
    }
  })
})
