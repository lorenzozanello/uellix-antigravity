// tests/hosted/managed-role-identities.test.ts
// HPO-ODS-W2-03 — the split of managed-role IDENTITY out of stella_hosted_0001.
//
// Static controls over the two prepared packages and the TypeScript model that
// everything else reads. The real-PostgreSQL half of the same contract lives
// in scripts/baseline-rehearsal-local.ts (P1..P13, N1, N3, N4, M3) — these are
// the controls that need no database: N2 (no baseline dependency), N5 (no
// duplicated definition), N6/M2 (no attribute or membership drift), M1 (the
// five roles are all created, uellix_app included), and the pin.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MANAGED_ROLE_ATTRIBUTES,
  MANAGED_ROLE_IDENTITIES,
  MANAGED_ROLE_IDENTITY_PACKAGE,
  MANAGED_ROLE_MEMBERSHIPS,
  alterRoleStatementFor,
  applyCommandForRoleIdentities,
  classifyUellixRoles,
  createRoleStatementFor,
  hasExactlyCanonicalIdentities,
  membershipStatements,
  verifyRoleIdentityPackage,
} from '@/db/hosted/managed-role-identities'
import { BOOTSTRAP_ROLES } from '@/db/hosted/bootstrap-postconditions'
import { sha256OfSql } from '@/db/hosted/hosted-package-manifest'
import { stripSqlLiteralsAndBodies } from '@/db/hosted/baseline-scanner'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n')

const IDENTITY = read(MANAGED_ROLE_IDENTITY_PACKAGE.file)
const IDENTITY_ROLLBACK = read(MANAGED_ROLE_IDENTITY_PACKAGE.rollbackFile)
const BOOTSTRAP = read('db/prepared/stella_hosted_0001_managed_role_bootstrap.sql')
const BOOTSTRAP_ROLLBACK = read('db/prepared/stella_hosted_0001_rollback.sql')

/**
 * Executable text: comments gone and single-quoted literals blanked. The
 * packages' refusal messages legitimately QUOTE the statements an operator
 * must run ("GRANT uellix_owner TO %I …"); a test about what a package
 * EXECUTES must not read its prose. Dollar-quoted DO bodies are KEPT — that is
 * where the real role statements live.
 */
const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .replace(/'(?:[^']|'')*'/g, "''")

describe('the model', () => {
  it('names the five identities in creation order, and BOOTSTRAP_ROLES is the same list (one source)', () => {
    expect(MANAGED_ROLE_IDENTITIES).toEqual(['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor'])
    expect(BOOTSTRAP_ROLES).toBe(MANAGED_ROLE_IDENTITIES)
  })

  it('only the migrator holds CREATEROLE; owner and writer are NOLOGIN', () => {
    expect(Object.entries(MANAGED_ROLE_ATTRIBUTES).filter(([, a]) => a.createrole).map(([r]) => r)).toEqual(['uellix_migrator'])
    expect(Object.entries(MANAGED_ROLE_ATTRIBUTES).filter(([, a]) => !a.login).map(([r]) => r)).toEqual(['uellix_owner', 'uellix_writer'])
  })

  it('the two memberships are SET-only (migrator -> owner) and INHERIT-only (app -> writer)', () => {
    expect(MANAGED_ROLE_MEMBERSHIPS).toEqual([
      { role: 'uellix_owner', member: 'uellix_migrator', inherit: false, set: true },
      { role: 'uellix_writer', member: 'uellix_app', inherit: true, set: false },
    ])
  })

  it('classifies uellix_* roles into canonical / missing / unexpected', () => {
    expect(classifyUellixRoles([])).toEqual({ canonicalPresent: [], canonicalMissing: [...MANAGED_ROLE_IDENTITIES], unexpected: [] })
    expect(classifyUellixRoles([...MANAGED_ROLE_IDENTITIES])).toEqual({ canonicalPresent: [...MANAGED_ROLE_IDENTITIES], canonicalMissing: [], unexpected: [] })
    expect(classifyUellixRoles(['uellix_app', 'uellix_cap_grounding', 'postgres'])).toEqual({
      canonicalPresent: ['uellix_app'],
      canonicalMissing: ['uellix_owner', 'uellix_migrator', 'uellix_writer', 'uellix_auditor'],
      unexpected: ['uellix_cap_grounding'],
    })
    expect(hasExactlyCanonicalIdentities([...MANAGED_ROLE_IDENTITIES])).toBe(true)
    expect(hasExactlyCanonicalIdentities([...MANAGED_ROLE_IDENTITIES, 'uellix_cap_x'])).toBe(false)
    expect(hasExactlyCanonicalIdentities(MANAGED_ROLE_IDENTITIES.slice(1))).toBe(false)
  })

  it('the apply command is psql -1 with the environment declared in the same session', () => {
    expect(applyCommandForRoleIdentities()).toBe(
      `psql -1 -v ON_ERROR_STOP=1 -c "SET uellix.bootstrap_environment = 'staging'" -f ${MANAGED_ROLE_IDENTITY_PACKAGE.file}`,
    )
  })
})

describe('the pin', () => {
  it('the package on disk hashes to the pin, and the verifier says so', () => {
    expect(sha256OfSql(IDENTITY)).toBe(MANAGED_ROLE_IDENTITY_PACKAGE.sourceSha256)
    expect(verifyRoleIdentityPackage(IDENTITY)).toEqual({ ok: true })
  })

  it('one added line is a refusal that names both hashes', () => {
    const r = verifyRoleIdentityPackage(`${IDENTITY}\n-- drift\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain(MANAGED_ROLE_IDENTITY_PACKAGE.sourceSha256.slice(0, 12))
  })

  it('an unreadable package is a refusal, not an empty plan', () => {
    expect(verifyRoleIdentityPackage(null).ok).toBe(false)
  })
})

describe('N6 / M2 — the SQL carries EXACTLY the governed definition, role by role', () => {
  it.each([...MANAGED_ROLE_IDENTITIES])('%s: the CREATE ROLE literal and the narrowing ALTER ROLE literal are both present, once', (role) => {
    const create = createRoleStatementFor(role)
    const alter = alterRoleStatementFor(role)
    expect(IDENTITY.split(create).length - 1, create).toBe(1)
    expect(IDENTITY.split(alter).length - 1, alter).toBe(1)
    // The ALTER never adds LOGIN: narrowing only.
    expect(alter).not.toContain(' LOGIN')
  })

  it('M1: exactly five CREATE ROLE statements, and uellix_app is one of them', () => {
    const creates = executable(IDENTITY).match(/\bCREATE ROLE (\w+)/g) ?? []
    expect(creates).toHaveLength(5)
    expect(creates.map((c) => c.replace('CREATE ROLE ', '')).sort()).toEqual([...MANAGED_ROLE_IDENTITIES].sort())
  })

  it('the two memberships are the exact governed literals, and no other role-membership GRANT exists', () => {
    for (const stmt of membershipStatements()) expect(IDENTITY).toContain(stmt)
    const grants = executable(IDENTITY).match(/\bGRANT\s+uellix_\w+\s+TO\s+\w+[^;]*;/g) ?? []
    // The two memberships plus the RR-02 grant to postgres, and nothing else.
    expect(grants.sort()).toEqual(
      [...membershipStatements(), 'GRANT uellix_owner TO postgres WITH INHERIT FALSE, SET TRUE;'].sort(),
    )
  })

  it('every role is NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOREPLICATION, INHERIT', () => {
    for (const statement of IDENTITY.match(/\b(CREATE|ALTER)\s+ROLE\b[^;]*/gi) ?? []) {
      expect(statement).toMatch(/NOSUPERUSER/)
      expect(statement).toMatch(/NOCREATEDB/)
      expect(statement).toMatch(/NOREPLICATION/)
      expect(statement).toMatch(/(?<!NO)INHERIT/)
      expect(statement).not.toMatch(/(?<!NO)BYPASSRLS/)
    }
  })
})

describe('N2 — the identity package needs nothing the baseline creates', () => {
  // Literals and $$ bodies stripped as well as comments: the package's own
  // refusal messages legitimately NAME what it must not touch.
  const code = stripSqlLiteralsAndBodies(IDENTITY)
  const bodies = IDENTITY

  it('references no Uellix application table, in code or in a DO body', () => {
    for (const table of ['stella_interactions', 'organizations', 'projects', 'evidence_items', 'users', 'audit_logs', 'domain_object_versions']) {
      expect(bodies.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), table).not.toMatch(new RegExp(`\\b(public\\.)?${table}\\b`))
    }
  })

  it('calls no RLS helper and no baseline function', () => {
    for (const fn of ['current_user_org_ids', 'current_user_is_super_admin', 'uellix_forbid_mutation', 'to_regclass', 'to_regprocedure', 'auth.uid']) {
      expect(executable(IDENTITY), fn).not.toContain(fn)
    }
  })

  it('transfers no ownership, grants no table or schema privilege, creates no schema/table/function', () => {
    const exec = executable(IDENTITY)
    expect(exec).not.toMatch(/\bOWNER\s+TO\b/i)
    expect(exec).not.toMatch(/\bGRANT\b[^;]*\bON\s+(TABLE|SCHEMA|FUNCTION|DATABASE|ALL)\b/i)
    expect(exec).not.toMatch(/\bCREATE\s+(TABLE|SCHEMA|FUNCTION|INDEX|POLICY|TRIGGER)\b/i)
    expect(code).not.toMatch(/\bEXECUTE\s+format\b/i)
  })

  it('declares search_path = public first, like every other stella_* package', () => {
    expect(/^SET search_path = public;/m.test(IDENTITY)).toBe(true)
  })
})

describe('N5 — one definition, one owner: the post-baseline bootstrap only ASSERTS', () => {
  it('stella_hosted_0001 executes no CREATE/ALTER ROLE, no COMMENT ON ROLE, no role-membership GRANT', () => {
    const exec = executable(BOOTSTRAP)
    expect(exec).not.toMatch(/\bCREATE\s+ROLE\b/i)
    expect(exec).not.toMatch(/\bALTER\s+ROLE\b/i)
    expect(exec).not.toMatch(/\bCOMMENT\s+ON\s+ROLE\b/i)
    expect(exec).not.toMatch(/\bGRANT\s+uellix_(owner|writer)\s+TO\b/i)
  })

  it('stella_hosted_0001 §0 (E0) refuses absent identities, drifted attributes and drifted memberships', () => {
    expect(BOOTSTRAP).toMatch(/managed role identit\(ies\) % are absent\. Apply db\/prepared\/stella_hosted_0000_managed_role_identity_bootstrap\.sql BEFORE PHASE_BASELINE/)
    expect(BOOTSTRAP).toMatch(/do not carry the canonical attributes stella_hosted_0000 establishes/)
    expect(BOOTSTRAP).toMatch(/the canonical memberships are missing or drifted/)
    // The assertion checks the SAME facts the model declares.
    expect(BOOTSTRAP).toContain("(rolcanlogin AND rolname IN ('uellix_owner','uellix_writer'))")
    expect(BOOTSTRAP).toContain("(NOT rolcanlogin AND rolname IN ('uellix_migrator','uellix_app','uellix_auditor'))")
    expect(BOOTSTRAP).toContain("(NOT rolcreaterole AND rolname = 'uellix_migrator')")
  })

  it('stella_hosted_0001 keeps everything post-baseline: ledger transfer, shim, sentinel, E-01 grants, capability assertion', () => {
    expect(BOOTSTRAP).toContain('ALTER TABLE public.stella_interactions OWNER TO uellix_owner')
    expect(BOOTSTRAP).toContain('CREATE OR REPLACE FUNCTION public.uellix_auth_uid()')
    expect(BOOTSTRAP).toContain('CREATE TABLE IF NOT EXISTS uellix_bootstrap.staging_sentinel')
    expect(BOOTSTRAP).toContain('GRANT SELECT, REFERENCES ON TABLE public.organizations TO uellix_owner WITH GRANT OPTION;')
    expect(BOOTSTRAP).toContain('CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(')
    expect(BOOTSTRAP).toMatch(/^GRANT CREATE ON SCHEMA public TO uellix_owner;\s*$/m)
  })
})

describe('the rollbacks divide the same way', () => {
  it('stella_hosted_0001_rollback no longer drops a role and says why; it still revokes what its forward granted', () => {
    const exec = executable(BOOTSTRAP_ROLLBACK)
    expect(exec).not.toMatch(/\bDROP\s+ROLE\b/i)
    expect(exec).toMatch(/REVOKE ALL ON SCHEMA public FROM uellix_owner/)
    expect(BOOTSTRAP_ROLLBACK).toContain('THE FIVE ROLES ARE DELIBERATELY NOT DROPPED HERE')
    expect(BOOTSTRAP_ROLLBACK).toContain('the auth shim survived')
  })

  it('stella_hosted_0000_rollback owns membership revocation and role removal, and refuses while anything sits on top', () => {
    const exec = executable(IDENTITY_ROLLBACK)
    for (const role of MANAGED_ROLE_IDENTITIES) expect(exec).toContain(`DROP ROLE IF EXISTS ${role};`)
    expect(exec).toContain('REVOKE uellix_owner FROM uellix_migrator;')
    expect(exec).toContain('REVOKE uellix_writer FROM uellix_app;')
    expect(IDENTITY_ROLLBACK).toMatch(/schema uellix_bootstrap exists, so stella_hosted_0001 is still installed/)
    expect(IDENTITY_ROLLBACK).toMatch(/still owned by a role this file drops/)
    expect(IDENTITY_ROLLBACK).toMatch(/still hold privileges on schema public/)
    expect(IDENTITY_ROLLBACK).toMatch(/uellix\.bootstrap_environment must be exactly ''staging''/)
  })

  it('both new files exist under the names the registry contract derives', () => {
    expect(existsSync(path.join(ROOT, MANAGED_ROLE_IDENTITY_PACKAGE.file))).toBe(true)
    expect(existsSync(path.join(ROOT, MANAGED_ROLE_IDENTITY_PACKAGE.rollbackFile))).toBe(true)
    expect(MANAGED_ROLE_IDENTITY_PACKAGE.rollbackFile).toBe('db/prepared/stella_hosted_0000_rollback.sql')
  })
})
