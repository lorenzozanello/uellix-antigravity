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

import type { ApplyAuthorizationInputs, OperatorAttestation } from './baseline-apply-authorization'
import type { PrivilegeProbes } from './hosted-provisioning-runner'
import { JOURNAL_TABLE } from './baseline-journal'
import { KNOWN_PRODUCTION_IDENTIFIERS } from './target-identity'

export const APPLY_IDENTITY_ARTEFACT = 'artifacts/class-c-probes/2026-08-07-apply-identity.json'
export const SQL_EDITOR_ARTEFACT = 'artifacts/class-c-probes/2026-08-07-uellix-staging.json'

/** Where the computed live verdict is written, so a report can only quote it. */
export const APPLY_STATUS_ARTEFACT = 'artifacts/hosted-apply-status.json'

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

  const obs = identity?.observed
  // 'UNCONFIRMED' STAYS 'UNCONFIRMED'. The one transformation this loader must
  // never perform is normalising an unretained value into a boolean.
  const readOnly: boolean | 'UNCONFIRMED' | null =
    obs?.transaction_read_only === undefined
      ? null
      : typeof obs.transaction_read_only === 'boolean'
        ? obs.transaction_read_only
        : obs.transaction_read_only.toUpperCase() === 'UNCONFIRMED'
          ? 'UNCONFIRMED'
          : obs.transaction_read_only.toLowerCase() === 'on' ||
            obs.transaction_read_only.toLowerCase() === 'true'

  const projectRef = identity?.targetProjectRef ?? editor?.targetProjectRef ?? ''
  if (projectRef && KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(projectRef)) {
    problems.push({
      file: APPLY_IDENTITY_ARTEFACT,
      detail: `the artefacts name ${projectRef}, which is a KNOWN PRODUCTION project.`,
    })
  }

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

    // NOT MEASURED, ANYWHERE IN THE REPOSITORY. CHECKPOINT A0 has no artefact,
    // so it is null and it blocks. Supplying a plausible object here would be
    // the fixture mistake all over again.
    checkpointA0: null,

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
      projectRef === '' || identity?.connectionHost === undefined
        ? null
        : attest(
            {
              declaredEnvironment: identity.declaredEnvironment ?? editor?.targetRole ?? '',
              projectRef,
              connectionHost: identity.connectionHost,
            },
            'connection host and declared environment as recorded in the probe artefact',
            identity.measuredBy ?? '',
          ),

    // The nine STELLA_* flags have no recorded inventory for this project.
    featureFlags: null,

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
  readonly criterionCount: number
  readonly satisfiedCount: number
  readonly blockingCount: number
  readonly blockingIds: readonly string[]
  readonly applyAuthorized: false
  readonly baselineApplied: false
  readonly stagingApplied: false
  readonly hostedReady: false
  readonly providerReady: false
  readonly evidenceProblems: readonly string[]
  readonly observed: MeasuredEvidence['observed']
}
