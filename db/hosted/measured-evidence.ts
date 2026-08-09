// db/hosted/measured-evidence.ts
// TRAIN 5C2 — the single object the apply gate and every report must both read.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS FILE EXISTS FOR, AND IT WAS IN MY OWN REPORT
// ---------------------------------------------------------------------------
// The Train 5C2 result said two things that cannot both be true:
//
//     PSQL transaction_read_only: UNCONFIRMED — "sigue bloqueando"
//     Baseline apply gate: 17 criteria, 1 blocking
//
// The audit is unambiguous about which is right. `hosted-storage-apply-identity-
// probed` IS a real apply criterion and it DOES refuse on UNCONFIRMED — its first
// branch, before anything else. So "1 blocking" was false.
//
// Where the 1 came from is the interesting part: `evaluateApplyAuthorization` was
// only ever called on `satisfying()`, a TEST FIXTURE describing a hypothetical
// project where `transactionReadOnly: true`, `canSetRole: true`,
// `ownsStorageObjects: true` and `evidenceBucketExists: true`. Every one of those
// is contradicted by the recorded measurements. The fixture's job is to prove
// each criterion can be individually broken; it is not a description of the
// world, and quoting its blocking count as the project's status turned a unit
// test into a status report.
//
// NOTHING IN THE REPOSITORY EVALUATED THE GATE AGAINST THE MEASURED EVIDENCE.
// That is the real gap, and a divergence between a report and a gate is only
// possible while two different objects can answer the same question.
//
// ---------------------------------------------------------------------------
// SO THE EVIDENCE IS READ, NOT TYPED
// ---------------------------------------------------------------------------
// Every attested value below comes from the probe artefacts under
// `artifacts/class-c-probes/`, parsed. Not transcribed into TypeScript, where a
// later edit could quietly improve a `false` into a `true` without touching the
// evidence file the operator actually produced.
//
// Absence is refusal here as everywhere: a missing artefact, an unparseable one,
// or a probe the artefact does not record yields `null`, and `null` blocks.

import type {
  ApplyAuthorizationInputs,
  GateReport,
  OperatorAttestation,
} from './baseline-apply-authorization'
import type { PrivilegeProbes } from './hosted-provisioning-runner'
import { JOURNAL_TABLE } from './baseline-journal'
import {
  CAPABILITY_PROBE_STATUS_ARTEFACT,
  type CapabilityProbeState,
} from './storage-capability-probe'
import { STORAGE_BOUNDARY_STATUS_ARTEFACT } from './managed-policy-channel'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from './target-identity'

export const APPLY_IDENTITY_ARTEFACT = 'artifacts/class-c-probes/2026-08-07-apply-identity.json'
/**
 * THE CLASS-C EVIDENCE LEDGER, AND WHY IT IS A PINNED LIST.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 * `SQL_EDITOR_ARTEFACT` was a single hardcoded dated filename. That was honest
 * while there was one measurement, and became a trap the moment the world moved:
 * the 2026-08-07 probe recorded `evidenceBucketExists: false` with
 * `remediation: DEFERRED BY OPERATOR INSTRUCTION`, and after the bucket was
 * created the gate kept reading the old answer. The artefact was not wrong — it
 * is a dated record of what was true that day — the SELECTION was.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT "THE MOST RECENT FILE"
 * ---------------------------------------------------------------------------
 * Because then any file dropped into `artifacts/class-c-probes/` becomes the
 * authority, and evidence that governs a gate must not be appointable by
 * whoever can write to a directory. Adding an entry here is a CODE CHANGE, so it
 * arrives through review with the measurement that justifies it.
 *
 * The LAST entry is current; earlier ones are superseded and kept, because
 * deleting them would delete the proof that the determination was made with what
 * was available and revised when better evidence arrived.
 */
export interface ClassCEvidenceEntry {
  readonly path: string
  /** ISO date the operator measured it. Documentation; never the selector. */
  readonly measuredOn: string
  /** The project this measurement describes. Checked against the target. */
  readonly projectRef: string
  readonly note: string
}

export const CLASS_C_SQL_EDITOR_EVIDENCE: readonly ClassCEvidenceEntry[] = [
  {
    path: 'artifacts/class-c-probes/2026-08-07-uellix-staging.json',
    measuredOn: '2026-08-07',
    projectRef: 'bvyzblhqymxruxdguaee',
    note:
      'Train 5C1 pre-baseline probe. SUPERSEDED: it records evidenceBucketExists=false, deferred by ' +
      'operator instruction. The bucket was created on 2026-08-08. Kept as the dated record of what ' +
      'was true before the baseline ran.',
  },
]

export type ClassCResolution =
  | { readonly ok: true; readonly entry: ClassCEvidenceEntry }
  | { readonly ok: false; readonly code: 'CLASS_C_EMPTY' | 'CLASS_C_PRODUCTION_REF' | 'CLASS_C_WRONG_TARGET'; readonly detail: string }

/**
 * Picks the authoritative Class-C artefact, or refuses.
 *
 * Production is vetoed BEFORE the target match, so a production artefact is
 * refused by the check that names production rather than by one that happens to
 * reject it today for another reason.
 */
export function resolveClassCEvidence(
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  ledger: readonly ClassCEvidenceEntry[] = CLASS_C_SQL_EDITOR_EVIDENCE,
  production = KNOWN_PRODUCTION_IDENTIFIERS,
): ClassCResolution {
  const entry = ledger[ledger.length - 1]
  if (entry === undefined) {
    return { ok: false, code: 'CLASS_C_EMPTY', detail: 'no Class-C evidence is declared. Unmeasured is refused.' }
  }
  if (production.projectRefs.includes(entry.projectRef)) {
    return {
      ok: false,
      code: 'CLASS_C_PRODUCTION_REF',
      detail: `${entry.path} describes ${entry.projectRef}, a KNOWN PRODUCTION project.`,
    }
  }
  if (entry.projectRef !== targetProjectRef) {
    return {
      ok: false,
      code: 'CLASS_C_WRONG_TARGET',
      detail: `${entry.path} describes ${entry.projectRef}; the target is ${targetProjectRef}. An observation of another database is not weaker evidence about this one — it is evidence about something else.`,
    }
  }
  return { ok: true, entry }
}

/** Backwards-compatible alias: the CURRENT artefact path, resolved not hardcoded. */
export const SQL_EDITOR_ARTEFACT: string = (() => {
  const r = resolveClassCEvidence()
  return r.ok ? r.entry.path : CLASS_C_SQL_EDITOR_EVIDENCE[CLASS_C_SQL_EDITOR_EVIDENCE.length - 1]?.path ?? ''
})()
export const CHECKPOINT_A0_ARTEFACT = 'artifacts/class-c-probes/2026-08-07-checkpoint-a0.json'
export const FEATURE_FLAGS_ARTEFACT = 'artifacts/class-c-probes/2026-08-07-feature-flags.json'

/** Where the computed live verdict is written, so a report can only quote it. */
export const APPLY_STATUS_ARTEFACT = 'artifacts/hosted-apply-status.json'

/**
 * CHECKPOINT A0, as ONE read-only block, for the re-run the evidence now needs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A RECONSTRUCTION
 * ---------------------------------------------------------------------------
 * A0 ran and PASSED on 2026-08-07 and its RESULTS are recorded — but its literal
 * SQL was never preserved anywhere: not in the requirements document, not in the
 * gate plan, not in an artefact, not in git history (searched). The gate refuses
 * an attestation with no query, and writing a plausible query into `queries[]`
 * would be manufacturing the provenance the criterion exists to demand.
 *
 * So this is not a reconstruction of what ran. It is the CURRENT canonical A0,
 * to be executed again — which is strictly better than a recovered string: a
 * fresh run produces evidence that is reproducible, and it closes the one thing
 * the historical record could never have carried.
 *
 * IT ALSO MEASURES SOMETHING THE 2026-08-07 RUN DID NOT. `public_relation_count`
 * is the evidence that distinguishes a NEW project from a RESTORED one. The old
 * A0 confirmed four named objects were absent, and four absent names is a claim
 * a dump of a different product satisfies while holding every row it ever had.
 */
export const CHECKPOINT_A0_SQL = `-- CHECKPOINT A0 — READ ONLY. Nothing here writes.
-- Run against the STAGING project, in the identity that will apply the baseline.
BEGIN READ ONLY;

SELECT
  current_setting('transaction_read_only')                    AS transaction_read_only,
  current_user,
  session_user,
  version()                                                   AS postgres_version,
  current_setting('server_version_num')::int >= 150000        AS postgres_compatible,

  -- Schemas the corpus assumes exist.
  to_regnamespace('auth')   IS NOT NULL                       AS auth_schema_present,
  to_regnamespace('public') IS NOT NULL                       AS public_schema_present,
  to_regprocedure('auth.uid()') IS NOT NULL                   AS auth_uid_present,

  -- The Stella / Uellix surface must be ABSENT on a new project.
  to_regnamespace('uellix_bootstrap') IS NULL                 AS uellix_bootstrap_absent,
  to_regnamespace('uellix_stella')    IS NULL                 AS uellix_stella_absent,
  to_regnamespace('uellix_provisioning') IS NULL              AS uellix_provisioning_absent,
  to_regclass('public.stella_interactions') IS NULL           AS stella_interactions_absent,
  to_regclass('uellix_bootstrap.staging_sentinel') IS NULL    AS staging_sentinel_absent,

  -- THE ONE THE 2026-08-07 RUN DID NOT TAKE, and the only thing here that can
  -- tell a new project from a restored dump: four absent names cannot.
  (SELECT count(*) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f'))                 AS public_relation_count;

ROLLBACK;`

export type EvidenceProblem = { readonly file: string; readonly detail: string }

interface ApplyIdentityArtefact {
  readonly targetProjectRef?: string
  readonly measuredBy?: string
  /**
   * The SQL the operator actually ran. ABSENT in the artefacts as recorded on
   * 2026-08-07, which is an evidence gap and is reported as one: the gate
   * refuses an attestation with no query, and the loader must not fill it in.
   */
  readonly queries?: readonly string[]
  /** The host the psql session connected to. Also absent, also not invented. */
  readonly connectionHost?: string
  readonly poolerUser?: string
  readonly declaredEnvironment?: string
  readonly observed?: {
    readonly current_user?: string
    readonly session_user?: string
    readonly transaction_read_only?: string | boolean
    readonly is_member?: boolean
    readonly inherits_privileges?: boolean
    readonly can_set_role?: boolean
  }
  readonly setLocalRole?: { readonly attempted?: boolean }
}

interface SqlEditorArtefact {
  readonly targetProjectRef?: string
  readonly targetRole?: string
  readonly measuredBy?: string
  readonly probes?: readonly { readonly name?: string; readonly sql?: string; readonly observed?: boolean }[]
}

/**
 * The probe queries, taken from what the ARTEFACTS record. NOTHING IS ADDED.
 *
 * The first version of this function composed the canonical strings itself — the
 * `SELECT current_user, session_user, version()` line and the three
 * `pg_has_role(...)` calls — none of which any artefact records. Adversarial
 * review named it precisely: the comment above the function said "quoting the
 * module's own expected strings back at the criterion would make the check pass
 * by construction", and the function did exactly that four lines below.
 *
 * The criterion that consumes this exists to establish that the operator ran the
 * query the specification names. A loader that supplies the expected text on the
 * operator's behalf converts that criterion into a formality. So this returns
 * only what is written down, and where nothing is written down it returns
 * nothing — and the gate refuses, which is the correct answer to "we do not know
 * what query produced these numbers".
 */
const recordedQuery = (identity: ApplyIdentityArtefact, editor: SqlEditorArtefact): string =>
  [...(editor.probes ?? []).map((p) => p.sql ?? ''), ...(identity.queries ?? [])]
    .filter((s) => s.trim() !== '')
    .join(' ')

const probe = (editor: SqlEditorArtefact, name: string): boolean | null => {
  const found = (editor.probes ?? []).find((p) => p.name === name)
  return typeof found?.observed === 'boolean' ? found.observed : null
}

export interface MeasuredEvidence {
  readonly inputs: ApplyAuthorizationInputs
  readonly problems: readonly EvidenceProblem[]
  /** Verbatim, for a report that must not paraphrase a measurement. */
  readonly observed: {
    readonly psql: {
      readonly currentUser: string | null
      readonly sessionUser: string | null
      readonly transactionReadOnly: boolean | 'UNCONFIRMED' | null
      readonly isMember: boolean | null
      readonly inheritsPrivileges: boolean | null
      readonly canSetRole: boolean | null
    }
    readonly sqlEditor: {
      readonly ownsStorageObjects: boolean | null
      readonly evidenceBucketExists: boolean | null
      readonly canCreateTriggerOnAuthUsers: boolean | null
    }
  }
}

/**
 * Builds the gate's inputs from the recorded evidence plus the repository.
 *
 * `readJson` and `readBaselineSql` are injected so a test can drive this over a
 * mutated artefact and watch the verdict move — a loader that can only ever
 * produce one answer cannot be shown to be reading anything.
 */
export function loadMeasuredEvidence(input: {
  readonly readJson: (file: string) => unknown | null
  readonly readBaselineSql: (file: string) => string | null
  readonly discoveredBaselineFiles: readonly string[]
}): MeasuredEvidence {
  const problems: EvidenceProblem[] = []

  const identity = (input.readJson(APPLY_IDENTITY_ARTEFACT) ?? null) as ApplyIdentityArtefact | null
  const editor = (input.readJson(SQL_EDITOR_ARTEFACT) ?? null) as SqlEditorArtefact | null
  if (identity === null) problems.push({ file: APPLY_IDENTITY_ARTEFACT, detail: 'absent or unparseable' })
  if (editor === null) problems.push({ file: SQL_EDITOR_ARTEFACT, detail: 'absent or unparseable' })

  const a0 = (input.readJson(CHECKPOINT_A0_ARTEFACT) ?? null) as {
    readonly measuredBy?: string
    readonly queries?: readonly string[]
    readonly observed?: {
      readonly result?: string
      readonly sessionWasReadOnly?: boolean
      readonly projectIsNew?: boolean
      readonly stellaSurfaceAbsent?: boolean
      readonly writesPerformed?: number
      readonly publicRelationCount?: number
    }
  } | null

  const flags = (input.readJson(FEATURE_FLAGS_ARTEFACT) ?? null) as {
    readonly measuredBy?: string
    readonly query?: string
    readonly environmentsPointingAtTarget?: unknown
    readonly flags?: Readonly<Record<string, string | boolean | undefined>>
  } | null

  const obs = identity?.observed
  // 'UNCONFIRMED' STAYS 'UNCONFIRMED'. The one transformation this loader must
  // never perform is normalising an unretained value into a boolean.
  //
  // AND AN UNRECOGNISED STRING IS NOT A MEASURED `false`. The first version fell
  // through to `=== 'on' || === 'true'`, so `"ON "` with a trailing space, or a
  // typo, became a boolean false — published in `observed.psql` under a contract
  // that says the block is verbatim, and reading as a measured read-only
  // violation nobody observed. Trim first, then map only the values PostgreSQL
  // actually emits; anything else is UNCONFIRMED, which blocks.
  const rawReadOnly = obs?.transaction_read_only
  const readOnly: boolean | 'UNCONFIRMED' | null = (() => {
    if (rawReadOnly === undefined) return null
    if (typeof rawReadOnly === 'boolean') return rawReadOnly
    const v = rawReadOnly.trim().toLowerCase()
    if (v === 'on' || v === 'true') return true
    if (v === 'off' || v === 'false') return false
    return 'UNCONFIRMED'
  })()

  const projectRef = identity?.targetProjectRef ?? editor?.targetProjectRef ?? ''
  if (projectRef && KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(projectRef)) {
    problems.push({
      file: APPLY_IDENTITY_ARTEFACT,
      detail: `the artefacts name ${projectRef}, which is a KNOWN PRODUCTION project.`,
    })
  }

  // The capability probe's DERIVED state, read from its status artefact. The
  // probe itself is a human action through a channel this code cannot observe;
  // what it can do is refuse to invent the outcome.
  const probeStatus = input.readJson(CAPABILITY_PROBE_STATUS_ARTEFACT) as
    | { readonly state?: string }
    | null
  const probeState =
    typeof probeStatus?.state === 'string' ? (probeStatus.state as CapabilityProbeState) : null

  // The boundary's DERIVED verdict. Absence is refusal here as everywhere.
  const boundaryStatus = input.readJson(STORAGE_BOUNDARY_STATUS_ARTEFACT) as
    | { readonly managedBoundaryVerified?: unknown }
    | null
  const boundaryVerified = boundaryStatus?.managedBoundaryVerified === true

  const attest = <T>(value: T, query: string, measuredBy: string): OperatorAttestation<T> => ({
    value,
    query,
    measuredBy,
  })

  // `?? null`, NEVER `?? false`. An absent measurement is not a negative one.
  const bool = (v: boolean | undefined): boolean | null => (typeof v === 'boolean' ? v : null)

  const classC: PrivilegeProbes | null =
    editor === null || identity === null
      ? null
      : {
          canCreateTriggerOnAuthUsers: probe(editor, 'canCreateTriggerOnAuthUsers'),
          ownsStorageObjects: probe(editor, 'ownsStorageObjects'),
          evidenceBucketExists: probe(editor, 'evidenceBucketExists'),
          applyIdentityRecorded:
            typeof obs?.current_user === 'string' && typeof obs?.session_user === 'string' ? true : null,
          storageAdminMember: bool(obs?.is_member),
          storageAdminInherits: bool(obs?.inherits_privileges),
          canSetRoleStorageAdmin: bool(obs?.can_set_role),
          // NOT attempted, and correctly so: SET=false refutes the branch by
          // catalogue. But `attempted === true` turned an ABSENT field into a
          // measured `false`, which is the same fabrication in miniature.
          setLocalRoleDemonstrated: bool(identity.setLocalRole?.attempted),
        }

  const inputs: ApplyAuthorizationInputs = {
    readBaselineSql: input.readBaselineSql,
    discoveredBaselineFiles: input.discoveredBaselineFiles,
    production: KNOWN_PRODUCTION_IDENTIFIERS,

    // A0 WAS RUN AND PASSED; ONLY ITS RECORD WAS MISSING. The audit question was
    // whether it needed re-execution — it did not. Every value is transcribed
    // from the requirements document, which states each one explicitly rather
    // than leaving them to be inferred from the word PASS. The QUERY is still
    // absent, so `attested()` refuses, which is the accurate remaining gap.
    checkpointA0:
      a0?.observed === undefined
        ? null
        : attest(
            {
              result: a0.observed.result === 'PASS' ? ('PASS' as const) : ('FAIL' as const),
              sessionWasReadOnly: a0.observed.sessionWasReadOnly === true,
              projectIsNew: a0.observed.projectIsNew === true,
              stellaSurfaceAbsent: a0.observed.stellaSurfaceAbsent === true,
              writesPerformed:
                typeof a0.observed.writesPerformed === 'number' ? a0.observed.writesPerformed : 1,
              // `?? null`, never `?? 0`. An uncounted schema is not an empty one.
              publicRelationCount:
                typeof a0.observed.publicRelationCount === 'number'
                  ? a0.observed.publicRelationCount
                  : null,
            },
            (a0.queries ?? []).join(' '),
            a0.measuredBy ?? '',
          ),

    classCProbes:
      classC === null
        ? null
        : attest(
            classC,
            recordedQuery(identity!, editor!),
            [editor!.measuredBy, identity!.measuredBy].filter(Boolean).join(' | '),
          ),

    // CORROBORATION CANNOT BE MANUFACTURED FROM THE THING IT CORROBORATES.
    //
    // The first version built `connectionHost` as `db.${projectRef}.supabase.co`
    // — from the very ref the criterion was meant to check it against. The
    // mismatch branch was unreachable BY CONSTRUCTION, and adversarial review
    // proved it by renaming the project in both artefacts: the criterion happily
    // answered "corroborated by its own host". The artefacts record no
    // connection host, so there is no second signal, so the criterion refuses.
    stagingIdentity:
      // `=== undefined` alone let a JSON `null` through as an attested host, and
      // the criterion then compared a ref against the string "null". Absent is
      // absent however it is spelled.
      projectRef === '' || typeof identity?.connectionHost !== 'string' || identity.connectionHost.trim() === ''
        ? null
        : attest(
            {
              declaredEnvironment: identity.declaredEnvironment ?? editor?.targetRole ?? '',
              projectRef,
              connectionHost: identity.connectionHost,
              poolerUser:
                typeof identity.poolerUser === 'string' && identity.poolerUser.trim() !== ''
                  ? identity.poolerUser.trim()
                  : null,
            },
            'connection host and declared environment as recorded in the probe artefact',
            identity.measuredBy ?? '',
          ),

    // THE INVENTORY, READ. `environmentsPointingAtTarget` is passed through as
    // `null` when the artefact does not enumerate it — an unmeasured scope list
    // and an empty one must not share a verdict, and the criterion refuses the
    // first while accepting the second as vacuously satisfied.
    featureFlags:
      flags === null
        ? null
        : attest(
            {
              environmentsPointingAtTarget: Array.isArray(flags.environmentsPointingAtTarget)
                ? flags.environmentsPointingAtTarget
                : null,
              flags: flags.flags ?? {},
            },
            flags.query ?? '',
            flags.measuredBy ?? '',
          ),

    // EVERY FIELD MEASURED, OR THE WHOLE ATTESTATION IS ABSENT.
    //
    // The first version wrote `obs.can_set_role ?? false` — and adversarial
    // review deleted all three privilege fields from the artefact and watched
    // `hosted-storage-set-role-ready` return SATISFIED, citing "MEMBER=false,
    // USAGE=false, SET=false — refuted by catalogue": a verdict quoting three
    // measurements that no longer existed. An unmeasured privilege defaulting to
    // the value that happens to suit the current conclusion is the worst
    // available default, and the file's own header promised the opposite.
    //
    // The query is likewise NOT supplied here. The artefact records none, the
    // gate refuses an attestation without one, and that refusal is a true
    // statement about the evidence: nobody wrote down what produced these
    // numbers.
    applyIdentity:
      obs === undefined ||
      typeof obs.current_user !== 'string' ||
      typeof obs.session_user !== 'string' ||
      readOnly === null ||
      typeof obs.is_member !== 'boolean' ||
      typeof obs.inherits_privileges !== 'boolean' ||
      typeof obs.can_set_role !== 'boolean'
        ? null
        : attest(
            {
              currentUser: obs.current_user,
              sessionUser: obs.session_user,
              transactionReadOnly: readOnly,
              isMember: obs.is_member,
              inheritsPrivileges: obs.inherits_privileges,
              canSetRole: obs.can_set_role,
            },
            (identity?.queries ?? []).join(' '),
            identity?.measuredBy ?? '',
          ),

    // Never attempted — the grant forbids it, and the gate refuses a
    // demonstration here precisely because attempting it would teach nothing.
    setLocalRoleDemo: null,

    storagePath: 'B-managed-channel',

    evidenceBucket:
      editor === null || probe(editor, 'evidenceBucketExists') === null
        ? null
        : attest(
            { exists: probe(editor, 'evidenceBucketExists') === true },
            (editor.probes ?? []).find((p) => p.name === 'evidenceBucketExists')?.sql ?? '',
            editor.measuredBy ?? '',
          ),

    // READ from the derived probe status, never set. `null` there is NOT_RUN,
    // which is neither a demonstrated channel nor a refuted one.
    capabilityProbe: probeState === null ? null : { state: probeState },
    // MANAGED_CHANNEL_CAPABILITY_DEMONSTRATED, derived. Pre-baseline by
    // construction: the probe depends on no helper, no bucket and no function.
    capabilityDemonstrated: probeState === 'CAPABILITY_PROBE_COMPLETE',
    // READ from the derived boundary verdict, NEVER a literal.
    //
    // This was `false` hardcoded, and adversarial review showed what that meant:
    // after the operator applied PART A and installed all three canonical
    // policies with a perfect surface, nothing would have recomputed it. The gate
    // would have refused forever for a reason no evidence could remove — the
    // exact "inert gate" defect closed one commit earlier in the criterion, left
    // open here in the loader that feeds it.
    //
    // `artifacts/hosted-storage-boundary-status.json` derives it from pg_proc,
    // pg_policies and the journal via `reconcileStorageBoundary`. Absent ⇒ false,
    // with a stated reason.
    managedBoundaryVerified: boundaryVerified,

    journalProvenance: {
      kind: 'hosted-journal',
      recordedFields: ['package_id', 'phase', 'sha256', 'applied_at', 'status'],
      writesAfterCommitOnly: true,
      detail:
        `51 generated wrappers \\ir their unit and INSERT INTO ${JOURNAL_TABLE} inside the same ` +
        `psql -1 transaction, so the row and the unit's effects commit or roll back together`,
    },
  }

  return {
    inputs,
    problems,
    observed: {
      psql: {
        currentUser: obs?.current_user ?? null,
        sessionUser: obs?.session_user ?? null,
        transactionReadOnly: readOnly,
        isMember: obs?.is_member ?? null,
        inheritsPrivileges: obs?.inherits_privileges ?? null,
        canSetRole: obs?.can_set_role ?? null,
      },
      sqlEditor: {
        ownsStorageObjects: editor === null ? null : probe(editor, 'ownsStorageObjects'),
        evidenceBucketExists: editor === null ? null : probe(editor, 'evidenceBucketExists'),
        canCreateTriggerOnAuthUsers: editor === null ? null : probe(editor, 'canCreateTriggerOnAuthUsers'),
      },
    },
  }
}

/**
 * The shape written to `artifacts/hosted-apply-status.json`.
 *
 * A report quotes THIS. `pnpm apply:status verify` regenerates and compares, so a
 * number in a document that no longer matches the gate fails a check instead of
 * ageing quietly into a false claim — which is exactly what happened to the
 * "1 blocking" figure.
 */
export interface ApplyStatusArtefact {
  readonly generatedBy: string
  /** The three gates, each with its own total and its own structured blockers. */
  readonly baselineStartGate: GateReport
  readonly baselineCompletionGate: GateReport
  readonly stagingRuntimeGate: GateReport
  readonly criterionCount: number
  readonly satisfiedCount: number
  readonly blockingCount: number
  readonly blockingIds: readonly string[]
  /**
   * COMPUTED, not pinned.
   *
   * This was the literal type `false`, which was honest while the answer could
   * only ever be false and became a lie the moment the start gate could be
   * satisfied: the published artefact would have kept saying `false` while the
   * gate computed `true`, and a report quoting it would have contradicted the
   * thing it claims to quote — the exact divergence this file exists to prevent.
   *
   * The four below stay pinned `false` because they describe events that have
   * not happened. Authorisation is a VERDICT, and a verdict has to be able to
   * change or it is not one.
   */
  readonly applyAuthorized: boolean
  readonly baselineApplied: false
  readonly stagingApplied: false
  readonly hostedReady: false
  readonly providerReady: false
  readonly evidenceProblems: readonly string[]
  readonly observed: MeasuredEvidence['observed']
}
