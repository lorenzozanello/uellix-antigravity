// db/hosted/managed-role-identities.ts
// HPO-ODS-W2-03 — the canonical managed-role IDENTITIES, as one TypeScript
// source that the runner, the rehearsal, the postconditions and the tests all
// read.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
// Baseline units 0042 and 0045 write `CREATE POLICY … TO uellix_app`, so the
// five managed roles must exist BEFORE unit 1. stella_hosted_0001 cannot run
// before unit 1 (it needs objects 0012/0030/0031/0039 create), so role identity
// was split out into db/prepared/stella_hosted_0000_managed_role_identity_
// bootstrap.sql. That SQL is the single source of truth for the DEFINITION.
// This module is the single source of truth for what everything ELSE expects
// of it: which roles, with which attributes and memberships, applied by which
// command, pinned to which bytes — so a drift in the SQL fails a test rather
// than being discovered by a refusal three phases later.

import { sha256OfSql } from './hosted-package-manifest'

/** The five identities, in the order the package creates them. */
export const MANAGED_ROLE_IDENTITIES = [
  'uellix_owner',
  'uellix_migrator',
  'uellix_app',
  'uellix_writer',
  'uellix_auditor',
] as const

export type ManagedRoleIdentity = (typeof MANAGED_ROLE_IDENTITIES)[number]

/**
 * The attribute shape stella_hosted_0000 §1 establishes and stella_hosted_0001
 * §0 (E0) asserts. `createrole` is the ONE non-narrowing attribute (E-02) and
 * only the migrator holds it.
 */
export interface ManagedRoleAttributes {
  readonly login: boolean
  readonly createrole: boolean
}

export const MANAGED_ROLE_ATTRIBUTES: Readonly<Record<ManagedRoleIdentity, ManagedRoleAttributes>> = {
  uellix_owner: { login: false, createrole: false },
  uellix_migrator: { login: true, createrole: true },
  uellix_app: { login: true, createrole: false },
  uellix_writer: { login: false, createrole: false },
  uellix_auditor: { login: true, createrole: false },
}

/** The memberships that need no application table. SET/INHERIT are exact. */
export const MANAGED_ROLE_MEMBERSHIPS = [
  { role: 'uellix_owner', member: 'uellix_migrator', inherit: false, set: true },
  { role: 'uellix_writer', member: 'uellix_app', inherit: true, set: false },
] as const

/**
 * The EXACT `CREATE ROLE` literal the identity package must carry for a role.
 * Derived from the attribute table so the SQL and this module cannot say two
 * different things; the test compares the file against these strings.
 */
export function createRoleStatementFor(role: ManagedRoleIdentity): string {
  const a = MANAGED_ROLE_ATTRIBUTES[role]
  return (
    `CREATE ROLE ${role} WITH ${a.login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB ` +
    `${a.createrole ? 'CREATEROLE' : 'NOCREATEROLE'} NOREPLICATION NOBYPASSRLS INHERIT;`
  )
}

/** The EXACT convergent `ALTER ROLE` literal (never adds LOGIN — narrowing only). */
export function alterRoleStatementFor(role: ManagedRoleIdentity): string {
  const a = MANAGED_ROLE_ATTRIBUTES[role]
  return (
    `ALTER ROLE ${role} WITH NOSUPERUSER NOCREATEDB ` +
    `${a.createrole ? 'CREATEROLE' : 'NOCREATEROLE'} NOREPLICATION NOBYPASSRLS INHERIT;`
  )
}

/** The EXACT membership GRANT literals. */
export function membershipStatements(): readonly string[] {
  return MANAGED_ROLE_MEMBERSHIPS.map(
    (m) => `GRANT ${m.role} TO ${m.member} WITH INHERIT ${m.inherit ? 'TRUE' : 'FALSE'}, SET ${m.set ? 'TRUE' : 'FALSE'};`,
  )
}

/**
 * The pre-baseline identity package. `sourceSha256` pins the LF-normalized
 * bytes exactly as HOSTED_PACKAGE_MANIFEST pins each chain package: an edit
 * to the SQL without a repin is a refusal, never a silently different role
 * model.
 */
export const MANAGED_ROLE_IDENTITY_PACKAGE = {
  id: 'stella_hosted_0000_managed_role_identity_bootstrap',
  file: 'db/prepared/stella_hosted_0000_managed_role_identity_bootstrap.sql',
  rollbackFile: 'db/prepared/stella_hosted_0000_rollback.sql',
  sourceSha256: '871f382aead7b834daf556d7e54402055ed3656d9a1964a4f63138610d5b693d',
} as const

/** Names the package's pin against the bytes a reader returns. */
export function verifyRoleIdentityPackage(sql: string | null): { ok: true } | { ok: false; detail: string } {
  if (sql === null) return { ok: false, detail: `${MANAGED_ROLE_IDENTITY_PACKAGE.file} cannot be read` }
  const actual = sha256OfSql(sql)
  if (actual !== MANAGED_ROLE_IDENTITY_PACKAGE.sourceSha256) {
    return {
      ok: false,
      detail:
        `${MANAGED_ROLE_IDENTITY_PACKAGE.file} hashes to ${actual.slice(0, 12)}…, pinned ` +
        `${MANAGED_ROLE_IDENTITY_PACKAGE.sourceSha256.slice(0, 12)}…. If the edit is intended, repin in ` +
        `db/hosted/managed-role-identities.ts in the same commit.`,
    }
  }
  return { ok: true }
}

/**
 * `psql -1` with the mandatory environment declaration in the SAME session —
 * the exact shape the package header documents. One transaction: the package
 * either establishes all five identities or none.
 */
export function applyCommandForRoleIdentities(): string {
  return (
    `psql -1 -v ON_ERROR_STOP=1 -c "SET uellix.bootstrap_environment = 'staging'" ` +
    `-f ${MANAGED_ROLE_IDENTITY_PACKAGE.file}`
  )
}

export interface UellixRoleClassification {
  /** Canonical identities present. */
  readonly canonicalPresent: readonly ManagedRoleIdentity[]
  /** Canonical identities absent. */
  readonly canonicalMissing: readonly ManagedRoleIdentity[]
  /** Any other uellix_* role — capability roles, residue from another stack, typos. */
  readonly unexpected: readonly string[]
}

/**
 * Pure: sorts the uellix_* roles a probe observed into the three buckets the
 * phases care about. Roles are CLUSTER-scoped, which is why this exists: a
 * fresh database inside a contaminated cluster still answers "present".
 */
export function classifyUellixRoles(observedUellixRoles: readonly string[]): UellixRoleClassification {
  const observed = new Set(observedUellixRoles.filter((r) => r.startsWith('uellix_')))
  const canonical = new Set<string>(MANAGED_ROLE_IDENTITIES)
  return {
    canonicalPresent: MANAGED_ROLE_IDENTITIES.filter((r) => observed.has(r)),
    canonicalMissing: MANAGED_ROLE_IDENTITIES.filter((r) => !observed.has(r)),
    unexpected: [...observed].filter((r) => !canonical.has(r)).sort(),
  }
}

/** True when the cluster carries exactly the five identities and nothing else uellix_*. */
export function hasExactlyCanonicalIdentities(observedUellixRoles: readonly string[]): boolean {
  const c = classifyUellixRoles(observedUellixRoles)
  return c.canonicalMissing.length === 0 && c.unexpected.length === 0
}
