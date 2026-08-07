// db/hosted/hosted-provisioning-runner.ts
// TRAIN 5C0 — Phase 7. The PHASED provisioning surface: baseline, then the
// bootstrap, then a human, then the Stella chain.
//
// ---------------------------------------------------------------------------
// WHAT THIS ADDS THAT hosted-migrator.ts DOES NOT HAVE
// ---------------------------------------------------------------------------
// `hosted-migrator.ts` plans ONE apply of Stella packages. It knows the chain,
// the hashes and the target rules. What it does not know — because until Train
// 5C0 nothing in the repository knew it — is that a hosted provisioning has
// three phases with different evidence requirements, that the first of them is
// fifty units of Uellix baseline nobody had inventoried, and that a human step
// sits between the second and the third.
//
// This module owns the SEQUENCE. It is still a pure planner: no connection, no
// filesystem, no clock. It takes a read-only picture of the target and returns
// either a refusal or the ordered steps of exactly one phase.
//
// ---------------------------------------------------------------------------
// THE THREE PHASES, AND WHY THE EVIDENCE DIFFERS BETWEEN THEM
// ---------------------------------------------------------------------------
//   PHASE_BASELINE          50 units. The sentinel's table cannot exist. The
//                           compensating control is VIRGINITY: no baseline unit
//                           installed, no Uellix schema, no ledger.
//
//   PHASE_STELLA_BOOTSTRAP  1 package. The sentinel's table still cannot exist —
//                           this is the package that creates it. Virginity is
//                           gone (the baseline is in), so the compensating
//                           control becomes EMPTINESS: every business table
//                           present and every one of them holding zero rows.
//                           Production has rows. That is the whole argument.
//
//   PHASE_STELLA_CHAIN      9 packages. The sentinel now exists and is REQUIRED.
//                           Three signals, no waiver, no compensating control —
//                           because none is needed any more.
//
// Between the second and the third there is no phase this module can run. The
// sentinel INSERT is a human act by construction: a bootstrap that wrote its own
// sentinel would be certifying itself, and every refusal below that mentions the
// sentinel exists to keep that from being quietly automated later.

import {
  BASELINE_ORDER,
  BASELINE_UNITS,
  baselineUnit,
  verifyBaselineManifest,
  type BaselineUnit,
} from './baseline-manifest'
import { scanBaselineSql, type BaselineScanFacts } from './baseline-scanner'
import { HOSTED_CHAIN } from './hosted-package-manifest'
import { planHostedApply, type HostedApplyStep } from './hosted-migrator'
import {
  PSQL_ARTEFACT,
  STORAGE_UNIT_SOURCE,
  buildStorageArtefacts,
  isStorageUnitInstalled,
  type StorageUnitState,
} from './storage-policy-artifact'
import {
  productionDenylistStatus,
  redactForHostedLog,
  verifyStagingTarget,
  type HostedTargetInput,
  type ProductionIdentifiers,
  type StagingSentinel,
} from './target-identity'

export type ProvisioningPhase =
  | 'PHASE_BASELINE'
  | 'PHASE_STELLA_BOOTSTRAP'
  | 'PHASE_STELLA_CHAIN'

/** The phases in the only order they may occur. */
export const PROVISIONING_PHASES: readonly ProvisioningPhase[] = [
  'PHASE_BASELINE',
  'PHASE_STELLA_BOOTSTRAP',
  'PHASE_STELLA_CHAIN',
]

export type ProvisioningFailureCode =
  | 'PROVISIONING_PHASE_UNKNOWN'
  | 'PROVISIONING_PHASE_OUT_OF_SEQUENCE'
  | 'PROVISIONING_BASELINE_INCOMPLETE'
  | 'PROVISIONING_BASELINE_MANIFEST_INVALID'
  | 'PROVISIONING_TARGET_NOT_VIRGIN'
  | 'PROVISIONING_EMPTINESS_PROBE_MISSING'
  | 'PROVISIONING_TARGET_NOT_EMPTY'
  | 'PROVISIONING_SENTINEL_IS_NOT_A_MIGRATION'
  | 'PROVISIONING_SENTINEL_REQUIRED'
  | 'PROVISIONING_BOOTSTRAP_MISSING'
  | 'PROVISIONING_FEATURE_FLAG_ENABLED'
  | 'PROVISIONING_PRIVILEGE_PROBE_MISSING'
  | 'PROVISIONING_PRIVILEGE_UNAVAILABLE'
  | 'PROVISIONING_PRODUCTION_DENYLIST_EMPTY'
  /** Anything the identity verifier or the package planner refused with. */
  | string

/**
 * The nine flags §2 A4 requires to be false in every environment pointing at the
 * target. Listed here rather than imported from `lib/stella/config.ts` on
 * purpose: that module reads `process.env` of the CURRENT process, and the
 * question this asks is about the environment of a DIFFERENT deployment. A
 * planner that answered it from its own process would be answering a question
 * nobody asked, correctly, and reporting it as the answer to the one they did.
 */
export const STELLA_FEATURE_FLAGS: readonly string[] = [
  'STELLA_ENABLED',
  'STELLA_ADVISOR_ENABLED',
  'STELLA_COMPOSER_ENABLED',
  'STELLA_VALIDATOR_ENABLED',
  'STELLA_GROUNDED_QUERY_ENABLED',
  'STELLA_DECISIONS_PERSISTENCE_ENABLED',
  'STELLA_PROXY_REVIEWER_ENABLED',
  'STELLA_EVIDENCE_REVIEWER_ENABLED',
  'STELLA_AUDIT_ASSISTANT_ENABLED',
]

/**
 * Tables whose emptiness is the compensating control for a deferred sentinel.
 *
 * ---------------------------------------------------------------------------
 * DERIVED FROM THE CORPUS, NOT HAND-PICKED — AND THE REASON IS A REAL HOLE
 * ---------------------------------------------------------------------------
 * This was a hand-written list of nine tables: the tenancy spine plus the two
 * ledgers. Adversarial review B found what nine hand-picked names miss.
 *
 * `0018_redundant_firebird.sql` is, by this manifest's own account, the ONLY
 * unit in the baseline that carries DML. It writes to `financial_proxies`,
 * `project_investments` and `funders`. **None of those three was on the list.**
 * Neither were `sroi_reports`, `outcomes`, `indicators`, `portfolios`,
 * `theory_of_change_nodes`, or roughly twenty more.
 *
 * The attack is not exotic. A partially-restored production copy whose tenancy
 * tables happen to be empty — a subset restore that took the financial tables
 * and not the users — reports zero on all nine, `checkEmptiness` returns null,
 * and the bootstrap applies to a database holding real tenant financial data
 * while the log says "all probed tables report zero rows".
 *
 * So the set is now every table the fifty units create, derived the same way
 * `deriveExpectedBaselineState` derives everything else. A new baseline table is
 * probed BY DEFAULT rather than by somebody remembering to add it — which is
 * the rule this file already applied to `installedProbes` and had not applied
 * to itself.
 */
export function deriveEmptinessProbes(
  readSql: (file: string) => string | null,
): readonly string[] {
  const tables = new Set<string>()
  for (const unit of BASELINE_UNITS) {
    const sql = readSql(unit.file)
    if (sql === null) continue
    for (const table of scanBaselineSql(sql).tablesCreated) tables.add(table)
  }
  return [...tables].sort()
}

/**
 * Privileges the baseline needs that managed Supabase may not grant.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FIELD EXISTS
 * ---------------------------------------------------------------------------
 * Two units of the fifty touch objects the platform owns, and the manifest
 * classifies them `C-requires-adaptation` with the note that "the hosted runner
 * must PROBE the privilege before the phase and refuse rather than discover it
 * mid-chain". Adversarial review A pointed out that the note promised something
 * nothing implemented: `TargetStateProbe` had no privilege field, and
 * `planBaselinePhase` planned all fifty with no special handling for class C. A
 * classification is load-bearing only if something consumes it.
 *
 * Both probes are READ-ONLY and both are `pg_catalog` questions:
 *
 *   auth.users    — schema `auth` is owned by supabase_auth_admin. Creating a
 *                   trigger on a table requires TRIGGER privilege on it.
 *                   `SELECT has_table_privilege(current_user, 'auth.users', 'TRIGGER')`
 *
 *   storage.objects — owned by supabase_storage_admin. Creating a POLICY
 *                   requires OWNERSHIP, which has no has_*_privilege form:
 *                   `SELECT pg_has_role(current_user, relowner, 'USAGE')
 *                      FROM pg_class WHERE oid = 'storage.objects'::regclass`
 *
 * `null` means NOT MEASURED, and it is refused. It is the same rule
 * `installedProbes` and the emptiness set already follow: an unprobed capability
 * is unknown, never permitted.
 */
export interface PrivilegeProbes {
  /** Can `current_user` create a trigger on `auth.users`? (unit 40) */
  readonly canCreateTriggerOnAuthUsers: boolean | null
  /** Does `current_user` hold ownership of `storage.objects`? (unit 41) */
  readonly ownsStorageObjects: boolean | null
  /**
   * Does the `uellix-evidence` Storage bucket exist?
   *
   * Not a privilege, and here anyway, because it is the same class of local /
   * hosted asymmetry that hid the 0039 defect. `supabase/config.toml` declares
   * `[storage.buckets.uellix-evidence]`, so `supabase start` creates it. NOTHING
   * in the fifty units does, and all three storage policies gate on
   * `bucket_id = 'uellix-evidence'`. A staging project provisioned exactly to
   * plan would have evidence policies guarding a bucket that does not exist, and
   * every upload would fail for a reason no postcondition looked for.
   */
  readonly evidenceBucketExists: boolean | null
  /**
   * Was the probe run in the identity that will APPLY the baseline?
   *
   * Not a privilege. A guard against the probe answering about a session
   * nobody is going to use — see the note on CLASS_C_PROBES and
   * supabase/supabase#41126, where the same CREATE POLICY fails over a direct
   * connection and succeeds in the SQL Editor.
   */
  readonly applyIdentityRecorded: boolean | null
  /**
   * MEMBER — belongs to supabase_storage_admin. DIAGNOSTIC ONLY.
   *
   * Deliberately not sufficient for anything. PostgreSQL 16 split membership
   * into MEMBER / USAGE / SET, and `GRANT r TO u WITH SET FALSE, INHERIT FALSE`
   * yields MEMBER=true with neither capability. Recorded because the
   * combination is diagnostic: MEMBER=true with SET=false is a deliberate
   * refusal, which means something different from no membership at all.
   */
  readonly storageAdminMember: boolean | null
  /** USAGE — INHERIT. The privilege PostgreSQL's ownership check consults. */
  readonly storageAdminInherits: boolean | null
  /**
   * SET — may `SET ROLE`. THE probe that decides whether Branch A exists.
   *
   * Never substitute MEMBER for this. Doing so is the same near-synonym
   * mistake the apply gate already refuses in attestation queries.
   */
  readonly canSetRoleStorageAdmin: boolean | null
  /**
   * `SET LOCAL ROLE supabase_storage_admin` was actually executed and observed
   * to change `current_user`, inside a READ ONLY transaction.
   *
   * The catalogue says the grant permits it; only the operation shows nothing
   * else refuses. Branch A requires BOTH, and this is the one that is not a
   * prediction.
   */
  readonly setLocalRoleDemonstrated: boolean | null
}

/**
 * The three §2.7 probes: the field, the unit that needs it, and the EXACT SQL.
 *
 * One source of truth for the queries, exported so the apply-authorization gate
 * can require the attestation to quote them verbatim rather than merely contain
 * a recognisable substring. Adversarial review showed why the weaker form was
 * theatre: `SELECT has_table_privilege(current_user, 'public.users', 'SELECT')`
 * contains the marker `has_table_privilege`, answers a completely different
 * question, and would have passed.
 */
export const CLASS_C_PROBES: readonly (readonly [keyof PrivilegeProbes, string, string])[] = [
  [
    'canCreateTriggerOnAuthUsers',
    '20260716000000_auth_trigger.sql',
    "SELECT has_table_privilege(current_user, 'auth.users', 'TRIGGER')",
  ],
  [
    'ownsStorageObjects',
    '20260716000001_storage_policies.sql',
    "SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = 'storage.objects'::regclass",
  ],
  [
    'evidenceBucketExists',
    "20260716000001_storage_policies.sql (its policies gate on bucket_id = 'uellix-evidence')",
    "SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uellix-evidence')",
  ],
  // ---------------------------------------------------------------------
  // ADDED 2026-08-07, because the first real run of these probes exposed a
  // defect in the first three.
  // ---------------------------------------------------------------------
  // `ownsStorageObjects` came back FALSE, which is the answer that blocks unit
  // 41. But the probe was under-specified in two ways that a FALSE cannot
  // distinguish between:
  //
  //   1. IT DOES NOT SAY WHO ASKED. `current_user` is whoever ran the query.
  //      The operator ran it in the Supabase SQL Editor; the baseline will be
  //      applied by psql over a direct connection, as a different role.
  //      supabase/supabase#41126 reports precisely this asymmetry — the same
  //      CREATE POLICY failing via a direct connection and succeeding in the
  //      SQL Editor. A probe run in one identity says nothing reliable about
  //      the other, which is the same "different query answers a different
  //      question" failure the apply gate already refuses.
  //
  //   2. IT MEASURES USAGE, NOT MEMBERSHIP. PostgreSQL's ownership check
  //      honours INHERIT, so `pg_has_role(..., 'USAGE')` correctly predicts a
  //      direct CREATE POLICY failing. It does NOT predict whether
  //      `SET ROLE supabase_storage_admin` is available, which needs 'MEMBER'.
  //      A NOINHERIT membership yields USAGE=false and MEMBER=true, and those
  //      two worlds need different adaptations.
  //
  // Both are read-only. Neither changes the BLOCKED verdict on its own — they
  // decide which adaptation is correct, and the previous three could not.
  [
    'applyIdentityRecorded',
    'ALL — the probes must be run in the identity that will apply the baseline',
    'SELECT current_user, session_user, version()',
  ],
  // ---------------------------------------------------------------------
  // CORRECTED 2026-08-07. The previous spelling of this probe asked for
  // 'MEMBER', and 'MEMBER' does not answer the question.
  //
  // PostgreSQL 16 split what used to be one notion of role membership into
  // three independent privileges, and 17 keeps them distinct:
  //
  //   MEMBER  — you belong to the role. Says nothing about what you may do
  //             with it. `GRANT r TO u WITH SET FALSE, INHERIT FALSE` gives
  //             MEMBER and nothing else.
  //   USAGE   — you hold the role's privileges WITHOUT SET ROLE (INHERIT).
  //             This is what PostgreSQL's ownership check consults, which is
  //             why `ownsStorageObjects` correctly predicts a direct
  //             CREATE POLICY failing.
  //   SET     — you may `SET ROLE` to it. THIS is the one that decides whether
  //             the SET ROLE adaptation exists.
  //
  // Asking MEMBER and reading it as "SET ROLE will work" is exactly the
  // substring-marker mistake in another costume: a near-synonym standing in for
  // the property actually required. All three are recorded because the
  // combination is diagnostic — MEMBER=true with SET=false is a deliberate
  // `WITH SET FALSE` grant, and it means something different from no membership
  // at all.
  [
    'storageAdminMember',
    'diagnostic only — membership without any implied capability',
    "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER')",
  ],
  [
    'storageAdminInherits',
    'diagnostic only — INHERIT, the privilege the ownership check consults',
    "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'USAGE')",
  ],
  [
    'canSetRoleStorageAdmin',
    '20260716000001_storage_policies.sql — THE probe that decides whether the SET ROLE path exists',
    "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'SET')",
  ],
  // And the catalogue answer is still not the operation. `SET` says the
  // grant permits it; only executing `SET LOCAL ROLE` inside a READ ONLY
  // transaction shows that nothing else refuses. Branch A requires both.
  [
    'setLocalRoleDemonstrated',
    '20260716000001_storage_policies.sql — the OPERATION, not the catalogue',
    'SET LOCAL ROLE supabase_storage_admin',
  ],
]

/** A read-only picture of the target. The caller runs the queries; this never does. */
export interface TargetStateProbe {
  /** Baseline unit ids already applied, as recorded by the operator's ledger. */
  readonly baselineUnitsInstalled: readonly string[]
  /** Does schema `uellix_bootstrap` exist? */
  readonly bootstrapSchemaPresent: boolean
  /** The sentinel row, or null when the table is absent or empty. */
  readonly sentinel: StagingSentinel | null
  /** Stella chain packages already installed. Absent key = unknown, never "no". */
  readonly stellaPackagesInstalled: Readonly<Record<string, boolean>>
  /**
   * Row counts, keyed by qualified table name, for every table the fifty units
   * create — see `deriveEmptinessProbes`. `null` means "not measured", which is
   * the honest answer before the baseline creates the tables.
   */
  readonly businessRowCounts: Readonly<Record<string, number>> | null
  /** Required for PHASE_BASELINE. See `PrivilegeProbes`. */
  readonly privileges?: PrivilegeProbes
  /**
   * Unit 41 is the only unit that can be HALF applied, because PART B runs
   * through a channel psql cannot reach. Derived from the catalogue by
   * `deriveStorageUnitState`, never claimed.
   *
   * Absent = unknown = refused, like every other probe here.
   */
  readonly storageUnitState?: StorageUnitState
}

export interface ProvisioningRequest {
  readonly phase: ProvisioningPhase
  readonly target: HostedTargetInput
  readonly mode: 'dry-run' | 'apply'
  /** Required in apply mode. Exactly `hosted_apply:<project-ref>`. */
  readonly applyConfirmation?: string
  readonly state: TargetStateProbe
  /**
   * The flag values of the environment that points at this target, as read from
   * its secret manager. An absent key counts as unset, which is false.
   */
  readonly featureFlags: Readonly<Record<string, string | boolean | undefined>>
  /** Reads a baseline unit's SQL by repo-relative path. */
  readonly readBaselineSql: (file: string) => string | null
  /** Canonical Stella package SQL by package name. */
  readonly stellaSources: Readonly<Record<string, string>>
  /** Every baseline SQL file found on disk, for orphan detection. */
  readonly discoveredBaselineFiles?: readonly string[]
  readonly production?: ProductionIdentifiers
  /**
   * Set by a caller that wants this runner to write the sentinel row.
   *
   * There is no code path that honours it. It exists so the refusal is EXPLICIT
   * and testable: a future maintainer who wires up sentinel automation has to
   * delete a refusal that explains why, rather than add a feature to a module
   * that never mentioned the possibility.
   */
  readonly sentinelWriteRequested?: boolean
}

export interface ProvisioningStep {
  readonly ordinal: number
  /** Baseline unit id, or Stella package name. */
  readonly id: string
  readonly file: string
  readonly sha256: string
  /** Present for Stella steps: the derived hosted artefact differs from source. */
  readonly generatedSha256?: string
  /** `psql -1 -v ON_ERROR_STOP=1 -f <file>`, one unit per invocation. */
  readonly command: string
}

export type ProvisioningPlan =
  | {
      readonly ok: true
      readonly phase: ProvisioningPhase
      readonly projectRef: string
      readonly writesPermitted: boolean
      readonly steps: readonly ProvisioningStep[]
      /** What must happen next. `null` only when the whole sequence is done. */
      readonly nextAction: string | null
      /** True only when the chain has reached stella_0018. */
      readonly sequenceComplete: boolean
      readonly log: readonly string[]
    }
  | { readonly ok: false; readonly code: ProvisioningFailureCode; readonly message: string }

function refuse(code: ProvisioningFailureCode, message: string): ProvisioningPlan {
  return { ok: false, code, message: redactForHostedLog(message) }
}

/** Ids of the baseline units the target still needs, in order. */
/** The one unit with two halves, applied through two different channels. */
export const STORAGE_UNIT_ID = '20260716000001_storage_policies.sql'

export function missingBaselineUnits(
  installed: readonly string[],
  storageUnitState?: StorageUnitState,
): readonly string[] {
  const have = new Set(installed)
  // UNIT 41 IS NOT INSTALLED UNTIL BOTH HALVES ARE.
  //
  // Its PART B — the three policies on storage.objects — is applied by a human
  // through a managed channel, because the applying identity measured
  // MEMBER=false / USAGE=false / SET=false against supabase_storage_admin. So
  // psql applying PART A leaves a unit that LOOKS finished: a ledger row says
  // 41 ran, and three policies gating every evidence read do not exist.
  //
  // An ABSENT state is not "complete". Same rule as installedProbes and the
  // emptiness set: unmeasured is refused, never assumed.
  if (storageUnitState === undefined || !isStorageUnitInstalled(storageUnitState)) {
    have.delete(STORAGE_UNIT_ID)
  }
  return BASELINE_ORDER.filter((id) => !have.has(id))
}

/**
 * The flag check.
 *
 * Anything other than a recognisably-false value counts as ENABLED. The
 * asymmetry is on purpose: `STELLA_ENABLED=maybe` is a typo, and a typo that
 * reads as "off" is a typo nobody ever finds.
 */
function enabledFlags(flags: Readonly<Record<string, string | boolean | undefined>>): string[] {
  const OFF = new Set(['false', '0', 'no', 'off', ''])
  return STELLA_FEATURE_FLAGS.filter((name) => {
    const raw = flags[name]
    if (raw === undefined || raw === null) return false
    if (typeof raw === 'boolean') return raw
    return !OFF.has(raw.trim().toLowerCase())
  })
}

export function planProvisioningPhase(request: ProvisioningRequest): ProvisioningPlan {
  if (!PROVISIONING_PHASES.includes(request.phase)) {
    return refuse(
      'PROVISIONING_PHASE_UNKNOWN',
      `refused: ${String(request.phase)} is not a provisioning phase. Known, in order: ${PROVISIONING_PHASES.join(' -> ')}.`,
    )
  }

  // (1) THE SENTINEL IS NOT A MIGRATION. First, because it is the refusal most
  //     likely to be "solved" by someone adding a step, and a refusal that
  //     arrives after four other checks reads as one obstacle among several
  //     rather than as the boundary it is.
  if (request.sentinelWriteRequested) {
    return refuse(
      'PROVISIONING_SENTINEL_IS_NOT_A_MIGRATION',
      `refused: this runner will not write uellix_bootstrap.staging_sentinel. The row exists to let ` +
        `the DATABASE corroborate an operator's claim about which database it is; a row written by the ` +
        `same automation that made the claim corroborates nothing. It is inserted by a human reading ` +
        `the project ref off the Supabase dashboard — see §3 of ` +
        `docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md.`,
    )
  }

  // (2) FLAGS OFF, before anything about targets or packages. A9/A4 is a
  //     precondition of the whole provisioning, not of one phase: a staging
  //     environment that receives the Stella surface while a flag is true is a
  //     staging environment that starts serving it the moment the deploy lands.
  const live = enabledFlags(request.featureFlags)
  if (live.length > 0) {
    return refuse(
      'PROVISIONING_FEATURE_FLAG_ENABLED',
      `refused: ${live.length} Stella flag(s) are not false in the environment pointing at this ` +
        `target: ${live.join(', ')}. All nine must be false before the first hosted write, and they ` +
        `stay false after it — applying the chain is not enabling it.`,
    )
  }

  switch (request.phase) {
    case 'PHASE_BASELINE':
      return planBaselinePhase(request)
    case 'PHASE_STELLA_BOOTSTRAP':
      return planBootstrapPhase(request)
    case 'PHASE_STELLA_CHAIN':
      return planChainPhase(request)
  }
}

/* -------------------------------------------------------------------------- */
/* PHASE_BASELINE                                                             */
/* -------------------------------------------------------------------------- */

function planBaselinePhase(request: ProvisioningRequest): ProvisioningPlan {
  // Identity with the sentinel deferred — its table provably cannot exist, since
  // the package that creates it is two phases away.
  const identity = verifyStagingTarget(
    request.target,
    request.production,
    'deferred-until-bootstrap',
  )
  if (!identity.ok) return refuse(identity.code, identity.message)

  // VIRGINITY. The compensating control for this phase, and the strongest one
  // available: a production database has a baseline applied by definition, so a
  // target with none is a target production cannot be.
  const state = request.state
  if (state.baselineUnitsInstalled.length > 0 || state.bootstrapSchemaPresent || state.sentinel !== null) {
    return refuse(
      'PROVISIONING_TARGET_NOT_VIRGIN',
      `refused: PHASE_BASELINE runs against a database with nothing of Uellix in it, and this one ` +
        `reports ${state.baselineUnitsInstalled.length} baseline unit(s) applied, ` +
        `bootstrapSchemaPresent=${state.bootstrapSchemaPresent}, sentinel=${state.sentinel ? 'present' : 'absent'}. ` +
        `The sentinel is waived in this phase ONLY because the target is provably empty; a target that ` +
        `is not empty has neither the sentinel nor the thing standing in for it. If the baseline is ` +
        `genuinely half-applied, the recovery is DESTROY_AND_REPROVISION — see ` +
        `docs/ops/staging/STELLA_STAGING_MIGRATION_PLAN.md.`,
    )
  }

  // THE MANIFEST, against the files. This is where "hash changed" and "order
  // changed" and "file omitted" and "file duplicated" all surface, and they
  // surface together because they are one question: is the corpus the corpus
  // this plan was reviewed against?
  const problems = verifyBaselineManifest(
    request.readBaselineSql,
    scanBaselineSql,
    request.discoveredBaselineFiles,
  )
  if (problems.length > 0) {
    // Report the DISTINCT kinds, not just the first problem. One edit routinely
    // produces two findings — the bytes moved AND the meaning moved — and an
    // operator shown only SHA_MISMATCH fixes the pin and never learns the file
    // gained a service_role grant. That is the exact failure the hash/scan split
    // exists to prevent, so the message must not undo it.
    const kinds = [...new Set(problems.map((p) => p.kind))]
    return refuse(
      'PROVISIONING_BASELINE_MANIFEST_INVALID',
      `refused: the baseline corpus does not match db/hosted/baseline-manifest.ts — ` +
        `${problems.length} problem(s) of ${kinds.length} kind(s): ${kinds.join(', ')}. ` +
        problems
          .slice(0, 4)
          .map((p) => `[${p.kind}] ${p.unit}: ${p.detail}`)
          .join(' | ') +
        (problems.length > 4 ? ` | …and ${problems.length - 4} more` : ''),
    )
  }

  // CLASS-C PRIVILEGES, before proposing a single step. The whole point of
  // classifying a unit C is to move the discovery from unit 40-of-50 to here,
  // where the answer costs a read-only query instead of a reprovisioning.
  const privileges = checkPrivileges(request.state.privileges)
  if (privileges) return privileges

  // PART A hash derived HERE, from the same reader that verified the manifest, so
  // the plan pins the artefact it is about to name rather than trusting the file.
  const storageSource = request.readBaselineSql(STORAGE_UNIT_SOURCE)
  const partAsha256 = storageSource === null ? undefined : buildStorageArtefacts(storageSource).psqlSha256
  const steps: ProvisioningStep[] = BASELINE_UNITS.map((unit) => baselineStep(unit, partAsha256))

  return finish(request, identity.projectRef, 'PHASE_BASELINE', steps, [
    `sentinel DEFERRED; compensating control satisfied: target reports zero baseline units, no ` +
      `uellix_bootstrap schema and no sentinel row`,
    `${steps.length} baseline units planned in manifest order`,
    `${BASELINE_UNITS.filter((u) => u.reapply !== 'idempotent').length} of them refuse a second ` +
      `application; a failure mid-phase is recovered by DESTROY_AND_REPROVISION, not by re-running`,
  ],
  'run CHECKPOINT B0 (read-only baseline postconditions), then PHASE_STELLA_BOOTSTRAP')
}

/**
 * The class-C gate. Each entry names the unit that needs it and what fails.
 *
 * `evidenceBucketExists` is checked here even though it is not a privilege,
 * because the consequence is identical: a fact about the platform that the
 * fifty units assume and none of them establishes.
 */
function checkPrivileges(probes: PrivilegeProbes | undefined): ProvisioningPlan | null {
  if (!probes) {
    return refuse(
      'PROVISIONING_PRIVILEGE_PROBE_MISSING',
      `refused: no privilege probes supplied. Two of the fifty units act on objects managed Supabase ` +
        `owns — a trigger on auth.users (unit 40) and three policies on storage.objects (unit 41) — and ` +
        `whether this project's role may do either is a fact about the project, not about the ` +
        `repository. Measuring it costs one read-only query each; discovering it at unit 40 costs a ` +
        `reprovisioning.`,
    )
  }

  // The single source of truth for these lives at module scope so the
  // apply-authorization gate can require an attestation to quote them verbatim.
  const REQUIRED = CLASS_C_PROBES

  const unmeasured = REQUIRED.filter(([key]) => probes[key] === null || probes[key] === undefined)
  if (unmeasured.length > 0) {
    return refuse(
      'PROVISIONING_PRIVILEGE_PROBE_MISSING',
      `refused: ${unmeasured.length} probe(s) not measured. Run each and supply the boolean:\n` +
        unmeasured.map(([key, unit, sql]) => `  ${key} (${unit}): ${sql}`).join('\n'),
    )
  }

  const denied = REQUIRED.filter(([key]) => probes[key] === false)
  if (denied.length > 0) {
    return refuse(
      'PROVISIONING_PRIVILEGE_UNAVAILABLE',
      `refused: ${denied.map(([key, unit]) => `${key} is false, which ${unit} requires`).join('; ')}. ` +
        `This is the RR-09 class of answer and it is only available on the project itself. If the ` +
        `bucket is the missing piece, create it in the dashboard and re-probe; if a privilege is the ` +
        `missing piece, the unit needs an adaptation before any of the fifty are applied.`,
    )
  }

  return null
}

function baselineStep(unit: BaselineUnit, partAsha256?: string): ProvisioningStep {
  // UNIT 41 IS PLANNED AS ITS PART A ARTEFACT, NOT AS THE CANONICAL FILE.
  //
  // Adversarial review caught this: the plan emitted `psql -f
  // supabase/migrations/20260716000001_storage_policies.sql` for unit 41 — the
  // whole file, PART B included — which this train's own measurement proves psql
  // cannot apply. Every artefact in this programme was built and then not
  // connected to the thing that uses it; this is that mistake, once more.
  if (unit.id === STORAGE_UNIT_ID) {
    return {
      ordinal: unit.ordinal,
      id: unit.id,
      file: PSQL_ARTEFACT,
      sha256: unit.sha256,
      generatedSha256: partAsha256,
      command:
        `psql -1 -v ON_ERROR_STOP=1 -f ${PSQL_ARTEFACT}` +
        `   # PART A ONLY. PART B (3 policies on storage.objects) goes through the managed channel.`,
    }
  }
  return {
    ordinal: unit.ordinal,
    id: unit.id,
    file: unit.file,
    sha256: unit.sha256,
    command: `psql -1 -v ON_ERROR_STOP=1 -f ${unit.file}`,
  }
}

/* -------------------------------------------------------------------------- */
/* PHASE_STELLA_BOOTSTRAP                                                     */
/* -------------------------------------------------------------------------- */

function planBootstrapPhase(request: ProvisioningRequest): ProvisioningPlan {
  const state = request.state

  // NO PHASE SKIPPING. The whole baseline, not most of it: stella_hosted_0001
  // moves the OWNER of public.stella_interactions, which 0012 creates, and the
  // grounding packages read public.current_user_org_ids(), which 0031 creates
  // and 0039 re-grants.
  const missing = missingBaselineUnits(state.baselineUnitsInstalled, state.storageUnitState)
  if (missing.length > 0) {
    return refuse(
      'PROVISIONING_BASELINE_INCOMPLETE',
      `refused: PHASE_STELLA_BOOTSTRAP requires all ${BASELINE_ORDER.length} baseline units; ` +
        `${missing.length} are missing, starting with ${missing[0]}. Stella is not a layer that can be ` +
        `laid over a partial baseline: stella_hosted_0001 alters the owner of a table 0012 creates, and ` +
        `the chain calls helpers 0031 defines and 0039 grants.`,
    )
  }

  // Already bootstrapped? Then this phase is done and the operator is either
  // repeating themselves or has lost track of where they are. Both are better
  // answered with "you are past this" than with a re-apply.
  if (state.bootstrapSchemaPresent) {
    return refuse(
      'PROVISIONING_PHASE_OUT_OF_SEQUENCE',
      `refused: schema uellix_bootstrap already exists, so PHASE_STELLA_BOOTSTRAP is complete. ` +
        `${state.sentinel ? 'The sentinel is written; proceed to PHASE_STELLA_CHAIN.' : 'Write the sentinel row (§3) before PHASE_STELLA_CHAIN.'}`,
    )
  }

  const identity = verifyStagingTarget(
    request.target,
    request.production,
    'deferred-until-bootstrap',
  )
  if (!identity.ok) return refuse(identity.code, identity.message)

  // EMPTINESS. Virginity is gone — the baseline is in — so the compensating
  // control changes shape. This is the one that carries the real weight: a
  // production database has rows.
  //
  // The probe set is DERIVED from the request's own reader rather than from a
  // constant, so a caller cannot be graded against a corpus other than the one
  // it is about to apply.
  const emptiness = checkEmptiness(
    state.businessRowCounts,
    deriveEmptinessProbes(request.readBaselineSql),
  )
  if (emptiness) return emptiness

  const plan = planHostedApply({
    target: request.target,
    packages: ['stella_hosted_0001_managed_role_bootstrap'],
    mode: request.mode,
    applyConfirmation: request.applyConfirmation,
    installedProbes: state.stellaPackagesInstalled,
    sources: request.stellaSources,
    production: request.production,
    bootstrapOnly: true,
    // Attested because `checkEmptiness` above measured it against the derived
    // table set and refused otherwise. This is the runner passing on a fact it
    // established, not a flag it assumed.
    emptinessAttested: true,
  })
  if (!plan.ok) return refuse(plan.code, plan.message)

  return finish(
    request,
    identity.projectRef,
    'PHASE_STELLA_BOOTSTRAP',
    plan.steps.map((s, i) => stellaStep(s, i + 1)),
    [
      `sentinel DEFERRED; compensating control satisfied: all ` +
        `${deriveEmptinessProbes(request.readBaselineSql).length} tables the fifty units create report ` +
        `zero rows`,
      'bootstrap-only plan: the chain does NOT run in this phase',
    ],
    'the OPERATOR writes uellix_bootstrap.staging_sentinel by hand (§3), then CHECKPOINT A1 read-only, then PHASE_STELLA_CHAIN',
  )
}

function checkEmptiness(
  counts: Readonly<Record<string, number>> | null,
  required: readonly string[],
): ProvisioningPlan | null {
  if (counts === null) {
    return refuse(
      'PROVISIONING_EMPTINESS_PROBE_MISSING',
      `refused: no row counts were supplied. With the sentinel deferred, emptiness is the ONLY thing ` +
        `standing between this plan and a database nobody verified. "Not measured" is not "empty".`,
    )
  }
  const absent = required.filter((t) => typeof counts[t] !== 'number')
  if (absent.length > 0) {
    return refuse(
      'PROVISIONING_EMPTINESS_PROBE_MISSING',
      `refused: ${absent.length} of ${required.length} required emptiness probe(s) were not supplied: ` +
        `${absent.slice(0, 8).join(', ')}${absent.length > 8 ? ' …' : ''}. An unprobed table is unknown, ` +
        `not empty — and the required set is every table the fifty units create, not a shortlist.`,
    )
  }
  const populated = required.filter((t) => counts[t] !== 0)
  if (populated.length > 0) {
    return refuse(
      'PROVISIONING_TARGET_NOT_EMPTY',
      `refused: ${populated.map((t) => `${t}=${counts[t]}`).join(', ')}. A database with rows is not a ` +
        `new staging project. Either this is the wrong target, or something has already written to it ` +
        `— and with no sentinel yet, there is nothing else that would tell those two apart.`,
    )
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* PHASE_STELLA_CHAIN                                                         */
/* -------------------------------------------------------------------------- */

function planChainPhase(request: ProvisioningRequest): ProvisioningPlan {
  const state = request.state

  const missing = missingBaselineUnits(state.baselineUnitsInstalled, state.storageUnitState)
  if (missing.length > 0) {
    return refuse(
      'PROVISIONING_BASELINE_INCOMPLETE',
      `refused: ${missing.length} baseline unit(s) missing, starting with ${missing[0]}. ` +
        `Phases do not overlap and they do not get skipped.`,
    )
  }

  if (!state.bootstrapSchemaPresent) {
    return refuse(
      'PROVISIONING_BOOTSTRAP_MISSING',
      `refused: schema uellix_bootstrap does not exist, so PHASE_STELLA_BOOTSTRAP has not run. Every ` +
        `package in the chain calls uellix_bootstrap.assert_hosted_capabilities() in place of the ` +
        `superuser guard it replaced; without it they abort one by one at their first statement.`,
    )
  }

  // THE BOUNDARY. Not "the sentinel would be nice here" — the chain is the first
  // thing that runs against a database claiming to be staging on its own
  // authority, and this is the check that makes the claim mean something.
  if (state.sentinel === null) {
    return refuse(
      'PROVISIONING_SENTINEL_REQUIRED',
      `refused: uellix_bootstrap.staging_sentinel is empty. The bootstrap created the table and left ` +
        `the row for a human on purpose. Until it is written, this target has two signals of identity ` +
        `and the two that a mispasted connection string also has. The chain does not run on two.`,
    )
  }

  // Identity with the sentinel REQUIRED. No waiver reaches this line.
  const identity = verifyStagingTarget(request.target, request.production, 'required')
  if (!identity.ok) return refuse(identity.code, identity.message)

  const remaining = HOSTED_CHAIN.filter(
    (name) =>
      name !== 'stella_hosted_0001_managed_role_bootstrap' &&
      state.stellaPackagesInstalled[name] !== true,
  )

  if (remaining.length === 0) {
    return {
      ok: true,
      phase: 'PHASE_STELLA_CHAIN',
      projectRef: identity.projectRef,
      writesPermitted: false,
      steps: [],
      nextAction: null,
      sequenceComplete: true,
      log: ['every chain package is already installed; nothing to apply'],
    }
  }

  const plan = planHostedApply({
    target: request.target,
    packages: remaining,
    mode: request.mode,
    applyConfirmation: request.applyConfirmation,
    installedProbes: state.stellaPackagesInstalled,
    sources: request.stellaSources,
    production: request.production,
  })
  if (!plan.ok) return refuse(plan.code, plan.message)

  return finish(
    request,
    identity.projectRef,
    'PHASE_STELLA_CHAIN',
    plan.steps.map((s, i) => stellaStep(s, i + 1)),
    [`sentinel PRESENT and corroborating: three independent signals`, ...plan.log],
    'CHECKPOINT C — verify every package postcondition; the flags stay false',
    remaining.includes('stella_0018_category_bound_operation_tickets'),
  )
}

function stellaStep(step: HostedApplyStep, ordinal: number): ProvisioningStep {
  return {
    ordinal,
    id: step.package,
    file: `db/prepared/hosted/${step.package}.hosted.sql`,
    sha256: step.sourceSha256,
    generatedSha256: step.generatedSha256,
    command: `psql -1 -v ON_ERROR_STOP=1 -f db/prepared/hosted/${step.package}.hosted.sql`,
  }
}

/* -------------------------------------------------------------------------- */
/* Shared tail                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The apply gate, applied identically in all three phases.
 *
 * Kept out of the per-phase functions so that "may I write?" has exactly one
 * implementation. Three copies of a confirmation check is three chances for one
 * of them to be the lenient one.
 */
function finish(
  request: ProvisioningRequest,
  projectRef: string,
  phase: ProvisioningPhase,
  steps: readonly ProvisioningStep[],
  log: readonly string[],
  nextAction: string,
  sequenceComplete = false,
): ProvisioningPlan {
  let writesPermitted = false
  const trail = [`phase ${phase}`, `mode ${request.mode}`, ...log]

  if (request.mode === 'apply') {
    // THE PRODUCTION VETO MUST BE LOADED BEFORE ANY WRITE.
    //
    // Adversarial review of Train 5C1 found this missing and it was the whole
    // ballgame: `db/hosted/target-identity.ts` claimed "the check lives where
    // the risk does — hosted-baseline-apply-authorized consumes this and
    // refuses", and `evaluateApplyAuthorization` had ZERO call sites outside its
    // own test. The gate was advisory. This planner would mint
    // `writesPermitted: true` for all fifty units while the ref veto had never
    // been loaded, and nothing anywhere required anyone to run the gate first.
    //
    // Host matching is not a substitute. A Supabase database host is
    // `db.<ref>.supabase.co`; the ref is the only part that identifies the
    // project, so a host list catches a connection aimed at a production DOMAIN
    // and catches nothing aimed at the production DATABASE.
    //
    // Dry runs are deliberately unaffected: an empty list removes a veto, not a
    // gate, and refusing to even DESCRIBE a plan is what hid the sentinel
    // circularity for a whole train.
    const denylist = productionDenylistStatus(request.production)
    if (!denylist.loaded) {
      return refuse('PROVISIONING_PRODUCTION_DENYLIST_EMPTY', `refused: ${denylist.detail}`)
    }

    const expected = `hosted_apply:${projectRef}`
    if (!request.applyConfirmation) {
      return refuse(
        'HOSTED_APPLY_CONFIRMATION_REQUIRED',
        `refused: apply mode requires hosted_apply:<project-ref>. A phase that passed its evidence ` +
          `checks is a phase that MAY be applied, not one that has been authorized.`,
      )
    }
    if (request.applyConfirmation !== expected) {
      return refuse(
        'HOSTED_APPLY_CONFIRMATION_MISMATCH',
        `refused: the confirmation does not match this target. A token minted for one project does ` +
          `not confirm another.`,
      )
    }
    writesPermitted = true
    trail.push('writes PERMITTED by explicit confirmation')
  } else {
    trail.push('writes NOT permitted: dry run')
  }

  return {
    ok: true,
    phase,
    projectRef,
    writesPermitted,
    steps,
    nextAction,
    sequenceComplete,
    log: trail.map(redactForHostedLog),
  }
}

/**
 * Re-exported so a caller can assert a unit's reapply class before retrying it.
 * A retry loop that does not consult this will eventually retry 008 and get
 * 42710 for its trouble.
 */
export { baselineUnit, type BaselineScanFacts }
