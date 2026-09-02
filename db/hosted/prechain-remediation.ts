// db/hosted/prechain-remediation.ts
// COMMIT 5.2 — the identity, pin and witness of the forward-only prechain
// remediation.
//
// ---------------------------------------------------------------------------
// WHY A THIRD KIND OF PACKAGE
// ---------------------------------------------------------------------------
// The repository already knows two: BASELINE units (db/migrations, applied
// once, in order) and the HOSTED CHAIN (T1..T9, witnessed, forward-only). This
// is neither. It is a one-shot reconciliation that carries an ALREADY
// BOOTSTRAPPED managed project from the state stella_hosted_0001 left it in to
// the prechain state Commit 5.1 certified — and it exists because the bootstrap
// cannot be replayed to do it:
//
//   psql:<stdin>:175: ERROR:  must be owner of schema uellix_bootstrap
//
// Giving it its own typed identity is not bookkeeping. If it were added to
// HOSTED_CHAIN it would acquire chain witnesses, appear in `nextChainPackage`,
// and become something an operator could be told to apply "next" — which is
// precisely wrong: it is a PREREQUISITE of T1, not a member of the sequence.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO ROLLBACK SCRIPT, AND WHY THAT IS NOT AN OMISSION
// ---------------------------------------------------------------------------
// Every other forward script in db/prepared/** has a `_rollback.sql`, and the
// registry test enforces it. This one is exempt, deliberately, and the reason
// is the same one that makes the package necessary.
//
// A rollback would have to UNDO a committed authority reconciliation: revoke
// privileges the chain may already depend on, remove CREATEROLE from a role
// that may already have created capability roles, and restore a superseded
// function body. Every one of those is safe only under assumptions about what
// has happened since — exactly the reasoning the forward-only contract exists
// to forbid. A down-migration here would be a script whose correctness depends
// on the state nobody measured.
//
// So rollback is defined by BEHAVIOUR rather than by a file:
//
//   PRE-COMMIT FAILURE      the transaction rolls back; the source state is
//                           restored by PostgreSQL, and that is measured.
//   AMBIGUOUS RESULT        a fresh catalog observation classifies it.
//   INSTALLED               no reapply, no downgrade. A correction is a NEW
//                           forward-only package.
//   PARTIAL/INCONSISTENT    refuse; human recovery.

import { createHash } from 'node:crypto'

/** What kind of thing this is. Deliberately not `HostedCompatibility`. */
export type PreparedPackageKind = 'prechain-remediation'

export interface PrechainRemediationPackage {
  readonly id: string
  readonly kind: PreparedPackageKind
  /** Repo-relative, POSIX. The file an operator applies, unmodified. */
  readonly sourceFile: string
  /** SHA-256 of the LF-normalized SQL. A byte change fails the gate. */
  readonly sourceSha256: string
  readonly purpose: string
  /** Why no `_rollback.sql` exists. Read by the registry tripwire. */
  readonly forwardOnlyNoRollbackReason: string
  /**
   * Why the package emits no COMMENT ON for the function it replaces.
   *
   * MEASURED: COMMENT needs USAGE on the containing schema AND ownership of the
   * object. uellix_bootstrap belongs to uellix_owner; the function belongs to
   * the installer. No principal holds both, and widening one to emit a comment
   * would leave the project in a state the certification never produced.
   */
  readonly commentOmission: string
}

export const PRECHAIN_REMEDIATION: PrechainRemediationPackage = {
  id: 'stella_hosted_0002_prechain_authority_reconciliation',
  kind: 'prechain-remediation',
  sourceFile: 'db/prepared/stella_hosted_0002_prechain_authority_reconciliation.sql',
  sourceSha256: '8616f4332030242d57f32433e510e74ee78b709f0aff9579e9d8177517715286',
  purpose:
    'Carries an already-bootstrapped managed project to the prechain authority state certified in ' +
    'Commit 5.1: the installer gains CREATEROLE and its database and visibility prerequisites, ' +
    'uellix_owner gains the E-01 privileges the governed chain re-grants, and uellix_bootstrap ' +
    'gains the capability-topology assertion while assert_hosted_capabilities is replaced by the ' +
    'certified body. It creates no capability role and transfers no ownership.',
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY. Undoing a committed authority reconciliation would mean revoking privileges the ' +
    'chain may already depend on and removing CREATEROLE from a role that may already have created ' +
    'capability roles — correct only under assumptions about what happened since, which is what the ' +
    'forward-only contract forbids. Recovery is: pre-commit failure rolls back (measured), an ' +
    'ambiguous result is classified by fresh observation, INSTALLED is never re-applied, and a ' +
    'correction is a NEW forward-only package.',
  commentOmission:
    'assert_hosted_capabilities keeps the comment stella_hosted_0001 gave it. COMMENT ON requires ' +
    'USAGE on uellix_bootstrap (held by uellix_owner) AND ownership of the function (held by the ' +
    'installer); no principal holds both, and the string is metadata that no authorization or ' +
    'runtime path reads. Named here so the omission is a decision rather than a silent drop.',
}

export function sha256OfPreparedSql(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
}

/* -------------------------------------------------------------------------- */
/* The E-01 grant inventory, machine-readable                                  */
/* -------------------------------------------------------------------------- */

export interface PrechainGrant {
  readonly object: string
  readonly objectType: 'table' | 'function'
  readonly privileges: readonly string[]
  readonly withGrantOption: boolean
  readonly grantee: string
  /** Which authority phase issues it. */
  readonly phase: 'installer' | 'owner'
  readonly firstDependency: string
}

/**
 * Exactly what the remediation grants, and nothing else.
 *
 * Derived by hand from `prechain-requirements.ts` and pinned here so a test can
 * compare the two AND compare this against the SQL. `GRANT ALL` would satisfy
 * every dependency and would also hand uellix_owner TRUNCATE on the ledger;
 * enumerating is what keeps the widening visible.
 */
export const PRECHAIN_GRANTS: readonly PrechainGrant[] = [
  { object: 'public.current_user_org_ids()', objectType: 'function', privileges: ['EXECUTE'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T1[10]' },
  { object: 'public.current_user_is_super_admin()', objectType: 'function', privileges: ['EXECUTE'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T1[11]' },
  { object: 'public.uellix_forbid_mutation()', objectType: 'function', privileges: ['EXECUTE'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T1[37]' },
  { object: 'public.organizations', objectType: 'table', privileges: ['SELECT', 'REFERENCES'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T1[14]' },
  { object: 'public.projects', objectType: 'table', privileges: ['SELECT', 'REFERENCES'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T1[14]' },
  { object: 'public.evidence_items', objectType: 'table', privileges: ['SELECT', 'REFERENCES'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T1[12]' },
  { object: 'public.users', objectType: 'table', privileges: ['REFERENCES'], withGrantOption: true, grantee: 'uellix_owner', phase: 'installer', firstDependency: 'T5[20]' },
  { object: 'public.uellix_auth_uid()', objectType: 'function', privileges: ['EXECUTE'], withGrantOption: true, grantee: 'uellix_migrator', phase: 'installer', firstDependency: 'T4 (auth-schema-grant rewrite)' },
  { object: 'public.organizations', objectType: 'table', privileges: ['SELECT'], withGrantOption: false, grantee: 'uellix_migrator', phase: 'installer', firstDependency: 'T4 precondition (information_schema visibility)' },
  { object: 'public.projects', objectType: 'table', privileges: ['SELECT'], withGrantOption: false, grantee: 'uellix_migrator', phase: 'installer', firstDependency: 'T4 precondition' },
  { object: 'public.evidence_items', objectType: 'table', privileges: ['SELECT'], withGrantOption: false, grantee: 'uellix_migrator', phase: 'installer', firstDependency: 'T1 precondition' },
  { object: 'public.users', objectType: 'table', privileges: ['SELECT'], withGrantOption: false, grantee: 'uellix_migrator', phase: 'installer', firstDependency: 'T5 precondition' },
  { object: 'public.stella_interactions', objectType: 'table', privileges: ['SELECT'], withGrantOption: false, grantee: 'uellix_migrator', phase: 'owner', firstDependency: 'T8 precondition' },
]

/* -------------------------------------------------------------------------- */
/* The witness                                                                 */
/* -------------------------------------------------------------------------- */

export type RemediationState = 'ABSENT' | 'INSTALLED' | 'PARTIAL_OR_INCONSISTENT'

/**
 * The catalog facts that identify the remediation, measured — never "the file
 * was run".
 *
 * Each is a fact about the TARGET state, so a project that reached it another
 * way classifies INSTALLED and is correctly not re-applied.
 */
export interface RemediationObservation {
  readonly installerHasCreateRole: boolean
  readonly installerCanSetOwner: boolean
  readonly installerCanCreateInDatabase: boolean
  /** uellix_owner holds every PRECHAIN_GRANTS entry aimed at it, with option. */
  readonly ownerHoldsE01Grants: boolean
  /** uellix_migrator holds the visibility SELECTs and the shim grant option. */
  readonly installerHoldsVisibilityGrants: boolean
  readonly topologyAssertionPresent: boolean
  /** The certified body, not merely a function of that name. */
  readonly capabilitiesBodyIsCertified: boolean
  /**
   * The explicit ACL of uellix_bootstrap, as pg_namespace records it.
   *
   * NOT `has_schema_privilege('postgres', ...)`: `pg_read_all_data` is granted
   * to postgres WITH INHERIT on every Supabase project and confers USAGE on
   * every schema, so that predicate stays TRUE even after the borrowed grant is
   * revoked. MEASURED — it is why the residual detector reads the ACL array.
   */
  readonly bootstrapSchemaAcl: readonly string[]
  readonly capabilityRolesPresent: readonly string[]
}

/** The ACL uellix_bootstrap must carry — before and after. No postgres entry. */
export const EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES: readonly string[] = [
  'uellix_owner',
  'uellix_migrator',
  'uellix_app',
  'uellix_auditor',
]

export interface RemediationClassification {
  readonly state: RemediationState
  readonly present: readonly string[]
  readonly missing: readonly string[]
  readonly problems: readonly string[]
}

/**
 * Classifies a remediation observation.
 *
 * ABSENT is derived from the POSITIVE facts being uniformly absent — never from
 * the negative ones, for the same reason `classifyPackage` refuses to: a
 * database where nothing has run is missing the old shape too.
 *
 * A leaked borrowed privilege is a PROBLEM rather than a missing fact: the
 * remediation may have done everything else correctly and still left the schema
 * open, and calling that INSTALLED would ship the one residue this package is
 * measured on.
 */
export function classifyRemediation(
  observation: RemediationObservation,
): RemediationClassification {
  // `installerCanSetOwner` is deliberately NOT a fact here. It is established
  // by stella_hosted_0001 §2b and is TRUE before this package runs, so
  // including it made the measured staging source state classify
  // PARTIAL_OR_INCONSISTENT instead of ABSENT — a witness that reported a
  // pristine target as half-remediated, which would have refused the very
  // apply it exists to authorise. It remains in the observation because §0 of
  // the package and the prechain gate both require it; it just does not
  // identify THIS package.
  const facts: [string, boolean][] = [
    ['installer holds CREATEROLE', observation.installerHasCreateRole],
    ['installer holds CREATE on the database', observation.installerCanCreateInDatabase],
    ['uellix_owner holds the E-01 grants', observation.ownerHoldsE01Grants],
    ['installer holds the visibility grants', observation.installerHoldsVisibilityGrants],
    ['the capability topology assertion exists', observation.topologyAssertionPresent],
    ['assert_hosted_capabilities carries the certified body', observation.capabilitiesBodyIsCertified],
  ]

  const present = facts.filter(([, ok]) => ok).map(([name]) => name)
  const missing = facts.filter(([, ok]) => !ok).map(([name]) => name)

  const problems: string[] = []
  const unexpectedGrantees = observation.bootstrapSchemaAcl.filter(
    (g) => !EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES.includes(g),
  )
  if (unexpectedGrantees.length > 0) {
    problems.push(
      `uellix_bootstrap carries an unexpected explicit grantee: ${unexpectedGrantees.join(', ')}. ` +
        `The remediation borrows USAGE and CREATE for one statement and revokes them before commit; ` +
        `a surviving entry means the revoke did not run.`,
    )
  }
  if (observation.capabilityRolesPresent.length > 0) {
    problems.push(
      `capability role(s) ${observation.capabilityRolesPresent.join(', ')} exist. This package ` +
        `creates none — T1, T4 and T5 do — so their presence means the chain has started and this ` +
        `is no longer a PRECHAIN question.`,
    )
  }

  if (problems.length > 0) return { state: 'PARTIAL_OR_INCONSISTENT', present, missing, problems }
  if (present.length === 0) return { state: 'ABSENT', present, missing, problems }
  if (missing.length === 0) return { state: 'INSTALLED', present, missing, problems }
  return { state: 'PARTIAL_OR_INCONSISTENT', present, missing, problems }
}

/* -------------------------------------------------------------------------- */
/* The T1 dependency                                                           */
/* -------------------------------------------------------------------------- */

export type T1AuthorizationRefusalCode =
  | 'REMEDIATION_ABSENT'
  | 'REMEDIATION_PARTIAL'
  | 'PRECHAIN_GATE_FAILED'

export type T1Authorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: T1AuthorizationRefusalCode; readonly detail: string }

/**
 * Whether governed T1 may be planned at all.
 *
 * MACHINE-ENFORCED rather than documented. The staging sequence has an operator
 * boundary between the remediation and T1, and a boundary that exists only in a
 * runbook is a boundary that gets crossed at 2am. Both conditions are required
 * and neither substitutes for the other: an INSTALLED remediation whose gate
 * fails is a project that reconciled and then drifted.
 */
export function authorizeGovernedT1(
  remediation: RemediationClassification,
  prechainGateRefusals: readonly { code: string; detail: string }[],
): T1Authorization {
  if (remediation.state === 'ABSENT') {
    return {
      ok: false,
      code: 'REMEDIATION_ABSENT',
      detail:
        `the prechain remediation (${PRECHAIN_REMEDIATION.id}) has not been applied. T1 grants ` +
        `privileges as uellix_owner on objects uellix_owner does not yet hold, and would fail ` +
        `inside its own transaction — which is where E-01 was found in the first place.`,
    }
  }
  if (remediation.state === 'PARTIAL_OR_INCONSISTENT') {
    return {
      ok: false,
      code: 'REMEDIATION_PARTIAL',
      detail:
        `the prechain remediation is PARTIAL_OR_INCONSISTENT: ${[...remediation.problems, ...remediation.missing.map((m) => `missing: ${m}`)].join('; ')}. ` +
        `Half a reconciliation is not a state to continue from, and this package is forward-only: ` +
        `there is no re-apply. Human recovery.`,
    }
  }
  if (prechainGateRefusals.length > 0) {
    return {
      ok: false,
      code: 'PRECHAIN_GATE_FAILED',
      detail:
        `the remediation is INSTALLED but the prechain authority gate refuses: ` +
        `${prechainGateRefusals.map((r) => `${r.code}`).join(', ')}. The project reconciled and then ` +
        `drifted, or was reconciled against a different contract.`,
    }
  }
  return { ok: true }
}
