// db/hosted/baseline-apply-authorization.ts
// TRAIN 5C1 — Phase 10. The one question this whole programme has been building
// toward: MAY the first hosted write be authorised?
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE MEANS, AND THE THING IT DOES NOT MEAN
// ---------------------------------------------------------------------------
// `hosted-baseline-apply-authorized` says: every precondition that can be
// established has been, so a human may now choose to run PHASE_BASELINE.
//
// It does NOT say `baselineApplied`. It does not say the baseline will succeed,
// and it is not itself the authorisation — Lorenzo is. It is the statement that
// nothing known is in the way.
//
// ---------------------------------------------------------------------------
// NO SELF-ASSERTED BOOLEANS
// ---------------------------------------------------------------------------
// The failure mode this module is designed against is the one adversarial review
// kept finding in Train 5C0: a check whose input is a value somebody typed to
// mean "yes". Three rules keep it out.
//
//   1. Anything derivable from the repository is DERIVED here, on every
//      evaluation, by doing the work — verifying the manifest, scanning the
//      corpus, driving the recovery table, running the postconditions against
//      their own negative controls.
//
//   2. Anything that can only be known by looking at the hosted project is an
//      ATTESTATION with provenance: who measured it, with which query, and when.
//      An attestation with no query recorded is refused, because "I checked" is
//      not evidence and this module cannot tell the difference between a probe
//      result and a hopeful default.
//
//   3. ABSENCE IS REFUSAL, everywhere, with no exception. Train 5B learned it
//      with `installedProbes` failing open; Train 5C0 learned it again with an
//      emptiness set that only looked at the tables it was handed. Not measured
//      is not satisfied.
//
// Every criterion carries an executable negative control, and the gate's own
// test drives each one against its own mutation. A criterion that ignored its
// input would pass its mutation and fail the suite.

import {
  BASELINE_UNITS,
  verifyBaselineManifest,
  verifyBaselineOrder,
  type BaselineUnit,
  BASELINE_ORDER,
} from './baseline-manifest'
import { scanBaselineSql } from './baseline-scanner'
import { JOURNAL_TABLE } from './baseline-journal'
import {
  JOURNAL_BOOTSTRAP_FILE,
  wrapperCarriesJournalAppend,
  wrapperPathFor,
} from './baseline-journal-wrapper'
import {
  MANAGEMENT_PLANE_EVIDENCE,
  MANAGEMENT_PLANE_PATH,
  deriveManagementPlaneVerdict,
  storageCanonicalBoundaryReadiness,
  storageStartReadiness,
} from './managed-policy-channel'
import type { CapabilityProbeState } from './storage-capability-probe'
import {
  BASELINE_POSTCONDITIONS,
  UNIT_042_GRANTED_FUNCTIONS,
  EXPECTED_STORAGE_POLICY_SURFACE,
  deriveExpectedBaselineState,
  type BaselinePostcondition,
} from './baseline-postconditions'
import { decideRecovery as realDecideRecovery } from './baseline-recovery'
import {
  CLASS_C_PROBES,
  CLASS_C_REQUIREMENT,
  STELLA_FEATURE_FLAGS,
  deriveEmptinessProbes,
  type PrivilegeProbes,
} from './hosted-provisioning-runner'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  classifySupabaseHost,
  productionDenylistStatus,
  projectRefFromHost,
  projectRefFromPoolerUser,
  type ProductionIdentifiers,
} from './target-identity'

/**
 * A fact about the hosted project, measured by a human, recorded with its query.
 *
 * `query` is not decoration. It is what separates "the operator ran the probe
 * §2.7 specifies" from "the operator ran something and reported a boolean", and
 * the two have different worth. A criterion below refuses an attestation whose
 * query does not match what the requirements document asks for.
 */
export interface OperatorAttestation<T> {
  readonly value: T
  /** The exact SQL (or the documented non-SQL procedure) that produced it. */
  readonly query: string
  /** Free-text provenance: who, where, when. Never a credential. */
  readonly measuredBy: string
}

export interface ApplyAuthorizationInputs {
  /* ---- Repository, derived on every evaluation ---- */
  readonly readBaselineSql: (file: string) => string | null
  readonly discoveredBaselineFiles: readonly string[]
  readonly production: ProductionIdentifiers
  /**
   * The unit list and the recovery function, injectable and defaulted.
   *
   * Not configurability — FALSIFIABILITY. Two criteria below reason over module
   * constants (`BASELINE_UNITS.managed`, and what `decideRecovery` answers), and
   * a criterion that reads a constant cannot be made to fail by any input, so it
   * passes its own negative control and is decorative by construction. The first
   * run of this file's negative-control sweep caught exactly that in exactly
   * these two. Injecting them is what turns "no class D units" and "recovery is
   * conservative" from assertions into measurements.
   */
  readonly units?: readonly BaselineUnit[]
  readonly decide?: typeof realDecideRecovery
  readonly postconditions?: readonly BaselinePostcondition[]

  /* ---- Hosted facts, attested. null = NOT MEASURED = refused ---- */
  /** CHECKPOINT A0, the read-only pre-bootstrap inspection. */
  readonly checkpointA0: OperatorAttestation<{
    readonly result: 'PASS' | 'FAIL'
    readonly sessionWasReadOnly: boolean
    readonly projectIsNew: boolean
    readonly stellaSurfaceAbsent: boolean
    readonly writesPerformed: number
    /**
     * Relations in schema `public` on the target, observed read-only.
     *
     * THE DIFFERENCE BETWEEN TWO CLAIMS THAT WERE BEING CONFLATED:
     *
     *   A. "the baseline migrations contain no production data"
     *      — static, derived from the corpus on every evaluation.
     *   B. "the target project currently holds no production data"
     *      — a fact about the DATABASE, and nothing static can establish it.
     *
     * `stellaSurfaceAbsent` was standing in for B, and it is four named objects
     * being absent. A restored dump of a DIFFERENT product, or a partial Uellix
     * dump that happens to miss those four names, satisfies it while the project
     * is full of rows. Counting the relations in `public` is what actually
     * distinguishes a new project from a restored one.
     *
     * `null` = not measured = refused, as everywhere.
     */
    readonly publicRelationCount: number | null
  }> | null
  /** The three class-C probes of §2.7. */
  readonly classCProbes: OperatorAttestation<PrivilegeProbes> | null
  /** The staging project ref, and the host it was derived from. Not secret. */
  readonly stagingIdentity: OperatorAttestation<{
    readonly declaredEnvironment: string
    readonly projectRef: string
    readonly connectionHost: string
    /**
     * The Session Pooler LOGIN ROLE, `postgres.<ref>`, when the connection went
     * through the pooler.
     *
     * A pooler host is regional and shared and names no project; the pooler puts
     * the ref in the login role instead, and that is what actually routes the
     * connection. Not a secret: no password, no token, and the ref inside it is
     * public. `null` when the connection was direct, in which case the host
     * carries the ref and corroborates on its own.
     */
    readonly poolerUser: string | null
  }> | null
  /**
   * The nine flags, AND the environments they were inventoried in.
   *
   * ---------------------------------------------------------------------------
   * WHY THE ENVIRONMENT LIST IS PART OF THE EVIDENCE
   * ---------------------------------------------------------------------------
   * This used to be the flag map alone, and an EMPTY map satisfied the criterion
   * with the verdict "all 9 flags false or unset". Three different states
   * collapsed into one pass:
   *
   *   - inventoried, and the flags are absent  — legitimate
   *   - inventoried nothing                    — no evidence at all
   *   - there are no environments to inventory — vacuously fine
   *
   * The middle one is the fail-open, and nothing in the value could tell it from
   * the other two. Naming the environments is what separates them: an empty list
   * is a MEASUREMENT that there is nowhere for a flag to be true, and a missing
   * list is somebody not having looked.
   */
  readonly featureFlags: OperatorAttestation<{
    /** Deployment scopes whose Supabase target IS this project. */
    readonly environmentsPointingAtTarget: readonly string[] | null
    /** Flag values observed across those scopes. Empty when the list is empty. */
    readonly flags: Readonly<Record<string, string | boolean | undefined>>
  }> | null

  /* ---- Train 5C2: Storage, apply identity, and the application journal ---- */
  /**
   * SONDA 1 of docs/ops/staging/STELLA_APPLY_IDENTITY_PROBE.md, run in the
   * identity that will apply PHASE_BASELINE — NOT the SQL Editor.
   */
  readonly applyIdentity: OperatorAttestation<{
    readonly currentUser: string
    readonly sessionUser: string
    /**
     * THREE states, not two. The operator ran the probe but did not retain this
     * value, and `UNCONFIRMED` is neither `true` (which would be an inference
     * dressed as a measurement) nor `false` (which would assert a violation
     * nobody observed). It blocks, and it blocks for a different reason than a
     * measured `false` would.
     */
    readonly transactionReadOnly: boolean | 'UNCONFIRMED'
    /** MEMBER. Diagnostic. Never sufficient for anything. */
    readonly isMember: boolean
    /** USAGE / INHERIT. What the ownership check consults. */
    readonly inheritsPrivileges: boolean
    /** SET. THE privilege that decides whether Branch A exists. */
    readonly canSetRole: boolean
  }> | null
  /** SONDA 2 — the operation, not the catalogue. Only meaningful if canSetRole. */
  readonly setLocalRoleDemo: OperatorAttestation<{
    readonly executed: boolean
    readonly currentUserAfter: string
    readonly sessionUserAfter: string
    readonly transactionReadOnlyAfter: boolean
  }> | null
  /** Which execution path the evidence selected. Never chosen before measuring. */
  readonly storagePath: 'A-set-role' | 'B-managed-channel' | null
  /** Re-probed existence of the uellix-evidence bucket. */
  readonly evidenceBucket: OperatorAttestation<{ readonly exists: boolean }> | null
  /**
   * MANAGED_CHANNEL_CAPABILITY_DEMONSTRATED — some channel is known able to
   * create a policy on storage.objects, from the capability probe.
   *
   * PRE-BASELINE by construction: the probe depends on no helper, no bucket and
   * no function. Distinct from `managedBoundaryVerified`, which is post-PART-A.
   */
  readonly capabilityDemonstrated: boolean
  /**
   * The derived state of the Dashboard capability probe, from
   * `artifacts/hosted-capability-probe-status.json`.
   *
   * NOT a boolean anybody sets. `null` means the artefact is absent, which is
   * NOT_RUN — neither a demonstrated channel nor a refuted one.
   */
  readonly capabilityProbe: { readonly state: CapabilityProbeState } | null
  /**
   * The catalogue-measured outcome of the human boundary for unit 41 PART B.
   *
   * Distinct from the capability probe: the probe measures whether the CHANNEL
   * can create any policy at all; this says the three canonical policies are
   * present and their surface verified. Capability is not correctness, and a
   * single flag covering both would erase the distinction the whole probe exists
   * to preserve.
   */
  readonly managedBoundaryVerified: boolean
  /**
   * How `baselineUnitsInstalled` will be established during apply — RR-25.
   *
   * `null` means it would be operator-typed, which is the defect. See the
   * criterion for the three permitted provenances.
   */
  readonly journalProvenance: {
    readonly kind: 'hosted-journal' | 'catalog-derived' | 'equivalent-fail-closed'
    /** For a journal: the columns it records. */
    readonly recordedFields: readonly string[]
    /** Written only after the unit's transaction commits. */
    readonly writesAfterCommitOnly: boolean
    readonly detail: string
  } | null
}

export interface AuthorizationVerdict {
  readonly id: string
  readonly satisfied: boolean
  readonly detail: string
}

/**
 * WHICH GATE A CRITERION BELONGS TO.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SPLIT EXISTS
 * ---------------------------------------------------------------------------
 * One list answered two different questions and therefore answered neither
 * well. "May PHASE_BASELINE be run?" and "may evidence upload be used?" have
 * different preconditions, and folding them together meant the `uellix-evidence`
 * bucket — which unit 41 never reads, because its policies compare bucket_id as
 * a COLUMN — was refusing the application of fifty units that do not need it.
 *
 * The obligation did not move: the bucket is still required, still `public=false`
 * and still empty at creation. Only the MOMENT it blocks changed, from "before
 * any DDL" to "before evidence runtime".
 */
export type GateName = 'baseline-start' | 'baseline-completion' | 'staging-runtime'

/**
 * WHEN THE EVIDENCE FOR A CRITERION CAN FIRST EXIST.
 *
 * ---------------------------------------------------------------------------
 * THE CIRCULAR DEPENDENCY THIS EXISTS TO MAKE UNREPRESENTABLE
 * ---------------------------------------------------------------------------
 * `hosted-storage-management-channel-verified` sat in the gate that authorises
 * PHASE_BASELINE and demanded MANAGED_BOUNDARY_VERIFIED — which needs the three
 * canonical policies, which call helpers created by unit 41 PART A, which is
 * unit 41 OF THE BASELINE. So:
 *
 *     baseline start → needs canonical boundary
 *                    → needs PART A
 *                    → needs baseline start.
 *
 * A gate nobody can ever open. The operator found it; I built it, one commit
 * after congratulating myself for removing an "inert gate" of the same family.
 *
 * Splitting the gates fixes this instance. This field is what stops the next
 * one: every criterion declares when its evidence becomes obtainable, and a test
 * refuses any `baseline-start` criterion whose evidence only exists during or
 * after the baseline. The invariant is checked, not remembered.
 */
export type EvidencePhase =
  /** Obtainable before a single unit is applied. */
  | 'pre-baseline'
  /** Obtainable only while PHASE_BASELINE runs. */
  | 'during-baseline'
  /** Obtainable only after unit 41 PART A is committed. */
  | 'post-part-a'

/** Which gates may legitimately consume evidence from which phase. */
export const GATE_ADMITS_PHASE: Readonly<Record<GateName, readonly EvidencePhase[]>> = {
  // THE WHOLE POINT: a start gate may only rest on facts that exist before the
  // start. Anything else is a precondition that its own subject must satisfy.
  'baseline-start': ['pre-baseline'],
  'baseline-completion': ['pre-baseline', 'during-baseline', 'post-part-a'],
  'staging-runtime': ['pre-baseline', 'during-baseline', 'post-part-a'],
}

interface Criterion {
  readonly id: string
  readonly gate: GateName
  /** When the evidence this criterion needs can first exist. */
  readonly dependsOnPhase: EvidencePhase
  readonly requirement: string
  /** The artefact or derivation the evidence for this criterion comes from. */
  readonly sourceArtifact: string
  evaluate: (inputs: ApplyAuthorizationInputs) => AuthorizationVerdict
  /**
   * A one-line summary of WHAT WAS SEEN, separate from why it was refused.
   *
   * The instruction asks a blocker to carry `observedEvidence` distinctly from
   * `reason`, and the distinction earns its keep: "SET=false" and "the SET ROLE
   * path is refuted" are the measurement and the conclusion, and conflating them
   * is how a conclusion outlives the measurement that justified it.
   */
  observe?: (inputs: ApplyAuthorizationInputs) => string
  readonly negativeControl: {
    readonly description: string
    mutate: (satisfying: ApplyAuthorizationInputs) => ApplyAuthorizationInputs
  }
}

const yes = (id: string, detail: string): AuthorizationVerdict => ({ id, satisfied: true, detail })
const no = (id: string, detail: string): AuthorizationVerdict => ({ id, satisfied: false, detail })

/** Collapses whitespace so a reformatted query still matches its canonical form. */
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Provenance, required of EVERY attestation.
 *
 * The header's rule 2 said an attestation with no recorded query is refused, and
 * adversarial review found it implemented for exactly one of the four — so three
 * of them accepted `{ value: {...}, query: '', measuredBy: '' }`, which is
 * precisely the "hopeful default a script constructed from config" the rule
 * exists to distinguish from a measurement. One helper, applied to all four.
 */
function attested<T>(
  id: string,
  what: string,
  a: OperatorAttestation<T> | null,
): AuthorizationVerdict | null {
  if (!a) return no(id, `${what} — NOT MEASURED. Not measured is not satisfied.`)
  if (!a.query.trim()) return no(id, `${what} records no query. "I checked" is not evidence.`)
  if (!a.measuredBy.trim()) return no(id, `${what} records no provenance: nobody is named as having measured it.`)
  return null
}

export const APPLY_AUTHORIZATION_CRITERIA: readonly Criterion[] = [
  /* ------------------------------------------------------------------ */
  {
    id: 'checkpoint-a0-pass',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-checkpoint-a0.json',
    observe: (i) => (i.checkpointA0 === null ? 'CHECKPOINT A0: no attestation on record' : `A0 result=${i.checkpointA0.value.result}, readOnly=${i.checkpointA0.value.sessionWasReadOnly}, writes=${i.checkpointA0.value.writesPerformed}`),
    requirement:
      'CHECKPOINT A0 ran read-only against the target and returned PASS, with zero writes.',
    evaluate(inputs) {
      const id = 'checkpoint-a0-pass'
      const missing = attested(id, 'CHECKPOINT A0', inputs.checkpointA0)
      if (missing) return missing
      const a = inputs.checkpointA0!
      if (a.value.result !== 'PASS') return no(id, `A0 returned ${a.value.result}.`)
      if (!a.value.sessionWasReadOnly) {
        return no(id, 'A0 was not run in a read-only session, so it cannot testify that it changed nothing.')
      }
      if (a.value.writesPerformed !== 0) {
        return no(id, `A0 reports ${a.value.writesPerformed} write(s). A0 that wrote is not A0.`)
      }
      if (!a.value.projectIsNew || !a.value.stellaSurfaceAbsent) {
        return no(id, `A0 did not confirm a new project free of Stella surface (new=${a.value.projectIsNew}, stellaAbsent=${a.value.stellaSurfaceAbsent}).`)
      }
      return yes(id, `A0 PASS, read-only, zero writes, new project, no Stella surface — attested by ${a.measuredBy}`)
    },
    negativeControl: {
      description: 'an A0 that performed a single write must fail',
      mutate: (i) => ({
        ...i,
        checkpointA0: i.checkpointA0 && {
          ...i.checkpointA0,
          value: { ...i.checkpointA0.value, writesPerformed: 1 },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'production-denylist-loaded',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/hosted/target-identity.ts — KNOWN_PRODUCTION_IDENTIFIERS',
    observe: (i) => `denylist: ${i.production.projectRefs.length} project ref(s), ${i.production.hosts.length} host(s)`,
    requirement:
      'KNOWN_PRODUCTION_IDENTIFIERS.projectRefs contains at least one well-formed production ref.',
    evaluate(inputs) {
      const id = 'production-denylist-loaded'
      const status = productionDenylistStatus(inputs.production)
      return status.loaded ? yes(id, status.detail) : no(id, status.detail)
    },
    negativeControl: {
      description: 'an empty production project-ref list must fail',
      mutate: (i) => ({ ...i, production: { ...i.production, projectRefs: [] } }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'target-identity-corroborated',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-apply-identity.json',
    observe: (i) => (i.stagingIdentity === null ? 'staging identity: no attestation on record (the artefact records no connectionHost)' : `declared=${i.stagingIdentity.value.declaredEnvironment}, ref=${i.stagingIdentity.value.projectRef}, host=${i.stagingIdentity.value.connectionHost}`),
    requirement:
      'The declared environment is staging, the host derives the SAME project ref, and neither is on the production denylist.',
    evaluate(inputs) {
      const id = 'target-identity-corroborated'
      const missing = attested(id, 'the staging identity', inputs.stagingIdentity)
      if (missing) return missing
      const { declaredEnvironment, projectRef, connectionHost } = inputs.stagingIdentity!.value
      if (declaredEnvironment !== 'staging') {
        return no(id, `declared environment is not exactly 'staging'.`)
      }
      // EITHER SIGNAL, BECAUSE EITHER ONE INDEPENDENTLY NAMES THE PROJECT.
      //
      // A direct connection puts the ref in the host; the pooler puts it in the
      // login role. Both are independent of the DECLARATION, which is what
      // signal 2 is for. Taking only the host would refuse the operator's real
      // connection forever, and rewriting their pooler host into a
      // `db.<ref>.supabase.co` they never used would be fabricating the
      // corroboration outright.
      const { poolerUser } = inputs.stagingIdentity!.value
      const fromHost = projectRefFromHost(connectionHost)
      const fromPooler = projectRefFromPoolerUser(poolerUser ?? '')
      const derived = fromHost ?? fromPooler
      if (derived === null) {
        // NAME THE CASE. A pooler host is not a wrong answer — it is the host
        // the operator genuinely connects to, and it is structurally incapable
        // of naming a project: `aws-0-<region>.pooler.supabase.com` is regional
        // and shared, and the ref lives in the pooler USERNAME instead.
        // Accepting one would not be a small relaxation; every project in the
        // region presents that same hostname, so signal 2 would corroborate
        // nothing at all.
        const kind = classifySupabaseHost(connectionHost)
        return no(
          id,
          kind === 'pooler'
            ? `the connection host is a Supabase SESSION POOLER host (${connectionHost}), which is ` +
                `regional and shared across projects — the ref lives in the pooler LOGIN ROLE, not the ` +
                `host${poolerUser === null ? ', and no login role was recorded' : `, and '${poolerUser}' does not parse as postgres.<ref>`}. ` +
                `Supply the pooler login role (postgres.<ref>) — a username, not a credential — or a ` +
                `ref-bearing host.`
            : 'no project ref can be derived from the host, so the connection cannot corroborate the ' +
                'declaration. A ref-bearing Supabase host is required.',
        )
      }
      if (derived !== projectRef) {
        return no(id, `the host names ${derived}, the declaration names ${projectRef}. One is wrong and this gate will not guess which.`)
      }
      const host = connectionHost.trim().toLowerCase()
      if (inputs.production.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        return no(id, 'the connection host matches a known production host.')
      }
      if (inputs.production.projectRefs.includes(projectRef)) {
        return no(id, 'the project ref is on the production denylist.')
      }
      return yes(
        id,
        `staging target ${projectRef} corroborated by ` +
          `${fromHost !== null ? `its connection host` : `its Session Pooler login role`}, and vetoed by nothing`,
      )
    },
    negativeControl: {
      description: 'a host naming a different project than the declaration must fail',
      mutate: (i) => ({
        ...i,
        stagingIdentity: i.stagingIdentity && {
          ...i.stagingIdentity,
          value: { ...i.stagingIdentity.value, connectionHost: 'db.zzzzzzzzzzzzzzzzzzzz.supabase.co' },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'class-c-probes-affirmative',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/*.json',
    observe: (i) => (i.classCProbes === null ? 'class-C probes: no attestation on record' : CLASS_C_PROBES.map(([k]) => `${k}=${String(i.classCProbes!.value[k])}`).join(', ')),
    requirement:
      'All three §2.7 probes were run and returned true: auth.users TRIGGER privilege, storage.objects ownership, uellix-evidence bucket.',
    evaluate(inputs) {
      const id = 'class-c-probes-affirmative'
      const missing = attested(id, 'the three class-C probes', inputs.classCProbes)
      if (missing) return missing
      const a = inputs.classCProbes!

      // THE QUERY MUST BE THE ONE §2.7 SPECIFIES, VERBATIM.
      //
      // This used to check that the attestation CONTAINED a marker substring —
      // `has_table_privilege`, `pg_has_role`, `storage.buckets` — and adversarial
      // review showed that is theatre twice over. A forgery passes:
      // `-- has_table_privilege pg_has_role storage.buckets`. And so does the
      // honest mistake the check exists for: `SELECT
      // has_table_privilege(current_user, 'public.users', 'SELECT')` contains the
      // marker, names the wrong table AND the wrong privilege, and answers a
      // question nobody asked.
      //
      // The canonical strings already existed in `CLASS_C_PROBES`. Requiring them
      // verbatim (whitespace-normalized, case-insensitive) costs nothing and
      // closes both.
      // THE FOUR OUTCOMES, NAMED. "All probes true" was never the property; it
      // was a shorthand that stopped being true the moment a `false` became a
      // legitimate, permanent measurement that SELECTS a route.
      //
      //   PROBE_MISSING                       not measured. Refuse.
      //   PROBE_INVALID                       measured by a query that answers a
      //                                       different question. Refuse.
      //   PROBE_RESULT_UNSUPPORTED            a false with no adaptation behind
      //                                       it, or one whose adaptation was not
      //                                       selected. Refuse.
      //   PROBE_RESULT_SUPPORTED_BY_SELECTED_PATH
      //                                       a false the design accounts for AND
      //                                       the plan routes around. Satisfied.
      const unmeasured = CLASS_C_PROBES.filter(([k]) => a.value[k] === null || a.value[k] === undefined)
      if (unmeasured.length > 0) {
        return no(id, `PROBE_MISSING — not measured: ${unmeasured.map(([k]) => k).join(', ')}.`)
      }

      // The quote is required of every probe that was RUN. `setLocalRoleDemonstrated`
      // is an OPERATION, not a read, and under Branch B it must not be attempted
      // — `hosted-storage-set-role-ready` refuses a demonstration when SET is
      // false. Demanding its query text while forbidding its execution is a
      // contradiction between two criteria of the same gate, and it made this
      // one unsatisfiable no matter what the operator measured.
      const wasRun = ([k]: readonly [keyof PrivilegeProbes, string, string]): boolean =>
        !(k === 'setLocalRoleDemonstrated' && a.value[k] === false)
      const recorded = normalizeSql(a.query)
      const notQuoted = CLASS_C_PROBES.filter(wasRun).filter(
        ([, , sql]) => !recorded.includes(normalizeSql(sql)),
      )
      if (notQuoted.length > 0) {
        return no(
          id,
          `PROBE_INVALID — the attestation does not quote the §2.7 query for: ${notQuoted.map(([k]) => k).join(', ')}. ` +
            `Expected verbatim: ${notQuoted.map(([, , sql]) => `\`${sql}\``).join(' ; ')}. A different query answers a different question.`,
        )
      }

      // ONLY apply-required PROBES MUST BE TRUE.
      //
      // The previous rule demanded `true` from all eight — including
      // `ownsStorageObjects`, which this train MEASURED false and proved
      // permanently false, and the three the list itself labels "diagnostic
      // only". A criterion that can never pass is not a strict criterion; it is
      // a criterion that has stopped carrying information, and the apply would
      // have stayed refused for the wrong reason forever.
      const denied = CLASS_C_PROBES.filter(
        ([k]) => a.value[k] === false && CLASS_C_REQUIREMENT[k] === 'apply-required',
      )
      if (denied.length > 0) {
        return no(
          id,
          `PROBE_RESULT_UNSUPPORTED — the platform denies: ${denied.map(([k]) => k).join(', ')}, and no ` +
            `adaptation exists for it. The affected unit needs one before ANY of the fifty are applied.`,
        )
      }

      // A branch-selector that is false must have selected the branch actually
      // taken. This is what stops the relaxation above from becoming a hole:
      // ownsStorageObjects=false no longer blocks, but it now REQUIRES the
      // managed-channel path to have been chosen.
      if (a.value.ownsStorageObjects === false && inputs.storagePath !== 'B-managed-channel') {
        return no(
          id,
          `PROBE_RESULT_UNSUPPORTED — ownsStorageObjects is false and the selected storage path is ` +
            `${inputs.storagePath ?? '(none)'}. A false here does not block the baseline — it SELECTS ` +
            `the managed channel for PART B — but a selector whose selection nobody took is a ` +
            `measurement with no route behind it.`,
        )
      }
      if (a.value.canSetRoleStorageAdmin === false && a.value.setLocalRoleDemonstrated === true) {
        return no(
          id,
          'PROBE_INVALID — SET is false and a SET LOCAL ROLE demonstration is recorded. The grant forbids ' +
            'the operation, so a recorded demonstration is either a different operation or a fabricated one.',
        )
      }

      const required = CLASS_C_PROBES.filter(([k]) => CLASS_C_REQUIREMENT[k] === 'apply-required')
      return yes(
        id,
        `PROBE_RESULT_SUPPORTED_BY_SELECTED_PATH — ${required.length} apply-required probe(s) affirmative, ` +
          `all ${CLASS_C_PROBES.length} measured, each run quoting its §2.7 query; ` +
          `ownsStorageObjects=${a.value.ownsStorageObjects} selects the ${inputs.storagePath} path — ` +
          `attested by ${a.measuredBy}`,
      )
    },
    negativeControl: {
      // Mutates the QUERY, not the boolean. Adversarial review pointed out that
      // flipping `ownsStorageObjects` to false exercises the value branch and
      // leaves the query branch — the one that was bypassable — never driven by
      // the sweep. This drives the branch that failed.
      //
      // The value branch is covered too, by an explicit test in
      // tests/hosted/baseline-apply-authorization.test.ts.
      description: 'an attestation whose query answers a DIFFERENT question must fail',
      mutate: (i) => ({
        ...i,
        classCProbes: i.classCProbes && {
          ...i.classCProbes,
          // Right function, wrong table, wrong privilege — the honest mistake.
          query:
            "SELECT has_table_privilege(current_user, 'public.users', 'SELECT'); " +
            "SELECT pg_has_role(current_user, 'postgres', 'USAGE'); " +
            'SELECT count(*) FROM storage.buckets;',
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-storage-apply-identity-probed',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-apply-identity.json',
    observe: (i) => (i.applyIdentity === null ? 'apply identity: no attestation on record (the artefact records no queries)' : `current_user=${i.applyIdentity.value.currentUser}, transaction_read_only=${String(i.applyIdentity.value.transactionReadOnly)}, MEMBER=${i.applyIdentity.value.isMember}, USAGE=${i.applyIdentity.value.inheritsPrivileges}, SET=${i.applyIdentity.value.canSetRole}`),
    requirement:
      'The MEMBER / USAGE / SET triple was measured in the identity that will APPLY the baseline, ' +
      'inside a read-only transaction — not in the SQL Editor.',
    evaluate(inputs) {
      const id = 'hosted-storage-apply-identity-probed'
      const missing = attested(id, 'the apply-identity probe', inputs.applyIdentity)
      if (missing) return missing
      const v = inputs.applyIdentity!.value

      if (v.transactionReadOnly === 'UNCONFIRMED') {
        return no(
          id,
          'transaction_read_only was NOT RETAINED from the probe output. Not inferred to be "on": a probe ' +
            'that cannot testify it was read-only is a probe whose read-only-ness is unknown, and unknown ' +
            'is not satisfied. One line of re-measurement closes it — see §I of the probe document.',
        )
      }
      if (!v.transactionReadOnly) {
        return no(id, 'the probe did not run in a READ ONLY transaction, so it cannot testify that it changed nothing.')
      }
      if (!v.currentUser.trim() || !v.sessionUser.trim()) {
        return no(id, 'current_user / session_user were not recorded. A probe that does not say WHO asked answers a question nobody posed — which is the defect this criterion exists for.')
      }
      // The three §2.7 probes ran in the SQL Editor. If this probe reports the
      // same identity, it is the same measurement wearing a new label.
      for (const [k, marker] of [
        ['MEMBER', "'supabase_storage_admin', 'MEMBER'"],
        ['USAGE', "'supabase_storage_admin', 'USAGE'"],
        ['SET', "'supabase_storage_admin', 'SET'"],
      ] as const) {
        if (!normalizeSql(inputs.applyIdentity!.query).includes(normalizeSql(marker))) {
          return no(id, `the recorded query does not ask for ${k}. All three are required: PostgreSQL 16 split membership into MEMBER / USAGE / SET and they answer different questions.`)
        }
      }
      return yes(id, `apply identity measured: current_user=${v.currentUser}, session_user=${v.sessionUser}, MEMBER=${v.isMember}, USAGE=${v.inheritsPrivileges}, SET=${v.canSetRole}`)
    },
    negativeControl: {
      description: 'a probe run outside a READ ONLY transaction must fail',
      mutate: (i) => ({
        ...i,
        applyIdentity: i.applyIdentity && {
          ...i.applyIdentity,
          value: { ...i.applyIdentity.value, transactionReadOnly: false },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-storage-set-role-ready',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-apply-identity.json',
    observe: (i) => (i.applyIdentity === null ? `apply identity: no attestation on record; storagePath=${i.storagePath ?? '(none)'}` : `SET=${i.applyIdentity.value.canSetRole}, storagePath=${i.storagePath ?? '(none)'}, demo=${i.setLocalRoleDemo === null ? 'not attempted' : 'recorded'}`),
    requirement:
      'Either SET was granted AND `SET LOCAL ROLE` was demonstrated (Branch A), or SET is false and a ' +
      'managed channel was selected instead (Branch B). MEMBER never substitutes for SET.',
    evaluate(inputs) {
      const id = 'hosted-storage-set-role-ready'
      const missing = attested(id, 'the apply-identity probe', inputs.applyIdentity)
      if (missing) return missing
      const v = inputs.applyIdentity!.value

      if (inputs.storagePath === null) {
        return no(id, 'no execution path selected. A path chosen before the evidence is a guess with a label.')
      }

      if (inputs.storagePath === 'A-set-role') {
        if (!v.canSetRole) {
          // The specific mistake this guards: MEMBER=true read as "SET ROLE works".
          return no(
            id,
            `Branch A selected but SET is false${v.isMember ? ' (MEMBER is true, which is NOT the same privilege — a WITH SET FALSE grant yields exactly this)' : ''}. ` +
              `PostgreSQL 16 split membership into MEMBER / USAGE / SET; only SET permits SET ROLE.`,
          )
        }
        const demo = attested(id, 'the SET LOCAL ROLE demonstration', inputs.setLocalRoleDemo)
        if (demo) return demo
        const d = inputs.setLocalRoleDemo!.value
        if (!d.executed) return no(id, 'SET LOCAL ROLE was not executed. The catalogue says the grant permits it; only the operation shows nothing else refuses.')
        if (d.currentUserAfter !== 'supabase_storage_admin') {
          return no(id, `current_user after SET LOCAL ROLE is ${d.currentUserAfter || '(unrecorded)'}, not supabase_storage_admin. The role was not actually assumed.`)
        }
        if (d.sessionUserAfter === 'supabase_storage_admin') {
          return no(id, 'session_user also became supabase_storage_admin. That is a session that escalated, not a transaction that assumed a role — the distinction is the whole safety of Branch A.')
        }
        if (!d.transactionReadOnlyAfter) {
          return no(id, 'the transaction was no longer READ ONLY after SET LOCAL ROLE. A demonstration that could have written is not a read-only demonstration.')
        }
        return yes(id, 'Branch A: SET granted and SET LOCAL ROLE demonstrated — current_user changed, session_user did not, transaction stayed read-only')
      }

      if (v.canSetRole) {
        return no(id, 'Branch B selected while SET is true. Choosing the manual channel over an available in-band path needs a stated reason, not a default.')
      }
      // SET=false REFUTES Branch A by catalogue. Demanding a SET LOCAL ROLE
      // demonstration after that would be asking the operator to attempt an
      // operation the grant already forbids — a pointless attempt whose failure
      // teaches nothing the catalogue has not already said.
      if (inputs.setLocalRoleDemo !== null) {
        return no(id, 'SET is false, so SET LOCAL ROLE must not be attempted. A demonstration here would be an attempt at an operation the grant refuses.')
      }
      return yes(id, `Branch B: MEMBER=${v.isMember}, USAGE=${v.inheritsPrivileges}, SET=${v.canSetRole} — no membership in any grade, so the SET ROLE path is refuted by catalogue and PART B moves to a governed managed channel`)
    },
    negativeControl: {
      // The exact confusion the operator's correction named.
      description: 'Branch A with MEMBER=true but SET=false must fail',
      mutate: (i) => ({
        ...i,
        storagePath: 'A-set-role',
        applyIdentity: i.applyIdentity && {
          ...i.applyIdentity,
          value: { ...i.applyIdentity.value, isMember: true, canSetRole: false },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-storage-policy-adaptation-ready',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'supabase/migrations/20260716000001_storage_policies.sql',
    requirement:
      'Unit 41 splits deterministically into PART A (public helpers, psql-applicable) and PART B (the ' +
      'storage.objects policies), from ONE canonical source, with the policy predicates unchanged.',
    evaluate(inputs) {
      const id = 'hosted-storage-policy-adaptation-ready'
      const sql = inputs.readBaselineSql('supabase/migrations/20260716000001_storage_policies.sql')
      if (sql === null) return no(id, 'the canonical unit 41 could not be read.')
      const facts = scanBaselineSql(sql)

      // Measured, not asserted: the split is only well-defined if the parts are
      // what the adaptation claims they are.
      if (facts.functionsCreated.length !== 2) {
        return no(id, `PART A should create exactly the two public helpers; found ${facts.functionsCreated.length}.`)
      }
      if (facts.policiesCreated.length !== 3) {
        return no(id, `PART B should create exactly three policies; found ${facts.policiesCreated.length}.`)
      }
      const onStorage = facts.policiesCreated.filter((p) => p.startsWith('storage.objects.'))
      if (onStorage.length !== 3) {
        return no(id, `all three policies must be on storage.objects; ${onStorage.length} are. A policy that moved schema changes which channel applies it.`)
      }
      if (facts.securitySurfaceDigest === undefined) {
        return no(id, 'no security surface digest derived, so an edit to a policy predicate would be invisible.')
      }
      // The hazard Supabase refuses by design, and which we must never acquire.
      if (/ALTER\s+TABLE\s+storage\.objects/i.test(sql)) {
        return no(id, 'the unit now issues ALTER TABLE storage.objects. Supabase refuses it and it is unnecessary — RLS is already enabled on that table by the platform.')
      }
      return yes(id, `PART A = 2 public helpers, PART B = 3 policies on storage.objects, one canonical source, predicates pinned by securitySurfaceDigest ${facts.securitySurfaceDigest.slice(0, 12)}…, and no ALTER TABLE storage.objects anywhere`)
    },
    negativeControl: {
      description: 'a unit 41 that acquires ALTER TABLE storage.objects must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'supabase/migrations/20260716000001_storage_policies.sql'
            ? `${i.readBaselineSql(f) ?? ''}\nALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-evidence-bucket-provisioning-ready',
    gate: 'staging-runtime',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-uellix-staging.json',
    observe: (i) => (i.evidenceBucket === null ? 'uellix-evidence bucket: not probed' : `uellix-evidence exists=${i.evidenceBucket.value.exists}`),
    requirement: "The 'uellix-evidence' bucket exists on the target, re-probed after creation.",
    evaluate(inputs) {
      const id = 'hosted-evidence-bucket-provisioning-ready'
      const missing = attested(id, 'the evidence bucket probe', inputs.evidenceBucket)
      if (missing) return missing
      return inputs.evidenceBucket!.value.exists
        ? yes(id, "the 'uellix-evidence' bucket exists, so the three storage policies guard something")
        : no(id, "the 'uellix-evidence' bucket does not exist. supabase/config.toml creates it locally and NOTHING in the fifty units creates it hosted — the third instance of that asymmetry. All three policies gate on its bucket_id.")
    },
    negativeControl: {
      description: 'a target without the bucket must fail',
      mutate: (i) => ({
        ...i,
        evidenceBucket: i.evidenceBucket && { ...i.evidenceBucket, value: { exists: false } },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-storage-policy-boundary-ready',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/hosted/baseline-postconditions.ts — B0-08',
    requirement:
      'If PART B runs through a managed channel, the boundary is explicit and the baseline cannot be ' +
      'reported complete while PART B is outstanding.',
    evaluate(inputs) {
      const id = 'hosted-storage-policy-boundary-ready'
      if (inputs.storagePath === null) {
        return no(id, 'no execution path selected, so there is no boundary to place.')
      }
      if (inputs.storagePath === 'A-set-role') {
        return yes(id, 'Branch A places no human boundary inside PHASE_BASELINE: PART B runs in-band under SET LOCAL ROLE')
      }
      // Branch B: the policies are verified by B0-08 regardless of channel. If
      // that check ever stopped covering the storage schema, the manual step
      // would become unobservable — which is the boundary failing silently.
      const b008 = BASELINE_POSTCONDITIONS.find((p) => p.id === 'B0-08-policies')
      if (!b008) return no(id, 'B0-08 is gone, so nothing verifies the policies whatever channel creates them.')
      if (!/schemaname\s+in\s*\(\s*'public'\s*,\s*'storage'\s*\)/i.test(b008.probeSql)) {
        return no(id, "B0-08's probe no longer covers schemaname 'storage'. With PART B moved to a manual channel, that probe is the ONLY thing that notices the step was skipped.")
      }
      return yes(id, 'Branch B: PART B is a declared human boundary, and B0-08 probes public AND storage, so a skipped manual step fails CHECKPOINT B0 rather than passing silently')
    },
    negativeControl: {
      description: 'Branch B with no path selected must fail',
      mutate: (i) => ({ ...i, storagePath: null }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-baseline-journal-ready',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/prepared/journal/** (51 generated wrappers)',
    requirement:
      'RR-25: `baselineUnitsInstalled` has a verifiable provenance during apply. It may not be typed by ' +
      'an operator.',
    evaluate(inputs) {
      const id = 'hosted-baseline-journal-ready'
      const p = inputs.journalProvenance
      if (!p) {
        return no(
          id,
          'no provenance defined for baselineUnitsInstalled. The hosted plan applies with `psql -1 -f` and ' +
            'writes no journal, while db:migrate:local uses drizzle and creates drizzle.__drizzle_migrations. ' +
            'Without a provenance the anti-skip check of PHASE_STELLA_BOOTSTRAP reads a value somebody typed.',
        )
      }
      // A DESCRIPTOR IS NOT AN IMPLEMENTATION.
      //
      // Adversarial review: this criterion validated a hand-written object for
      // internal shape-consistency and nothing else. `journalInsertSql` exists,
      // is never called, and no generated artefact contains the append it
      // describes — so a caller could assert a perfectly-shaped
      // `{kind:'hosted-journal', writesAfterCommitOnly:true}` describing a
      // mechanism that does not exist, and RR-25 would read as closed.
      //
      // The criterion now demands the BYTES. Until a generator appends the
      // journal INSERT to the artefacts, this refuses — which is the honest
      // state of RR-25 and exactly what Phase 11 requires while it is unresolved.
      if (p.kind !== 'hosted-journal') {
        return no(
          id,
          `provenance kind '${p.kind}' is declared but not validated by anything. Only 'hosted-journal' ` +
            `has a checkable implementation, and a kind this criterion cannot inspect is a claim, not a ` +
            `provenance.`,
        )
      }
      const REQUIRED = ['package_id', 'phase', 'sha256', 'applied_at', 'status']
      const absent = REQUIRED.filter((f) => !p.recordedFields.includes(f))
      if (absent.length > 0) return no(id, `the journal does not record: ${absent.join(', ')}.`)
      if (!p.writesAfterCommitOnly) {
        return no(id, 'the journal row is not committed with the unit, so a rolled-back unit could be recorded as applied — a ledger that lies in the one direction that matters.')
      }

      // THE BYTES, FOR EVERY UNIT — not for one artefact.
      //
      // The previous version demanded the append in PART A alone. That was one
      // fiftieth of the requirement: forty-nine units could apply unrecorded
      // while the criterion passed, and `baselineUnitsInstalled` would still
      // largely be a list somebody typed. RR-25 is about the WHOLE baseline.
      const bootstrap = inputs.readBaselineSql(JOURNAL_BOOTSTRAP_FILE)
      if (bootstrap === null || !bootstrap.includes(`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE}`)) {
        return no(
          id,
          `${JOURNAL_BOOTSTRAP_FILE} does not create ${JOURNAL_TABLE}. Unit 1 would INSERT into a table ` +
            `that does not exist and roll back — the ledger's own bootstrap is a unit, and an absent one.`,
        )
      }
      const units = inputs.units ?? BASELINE_UNITS
      const without = units.filter(
        (u) => !wrapperCarriesJournalAppend(inputs.readBaselineSql(wrapperPathFor(u))),
      )
      if (without.length > 0) {
        return no(
          id,
          `${without.length} of ${units.length} units have no wrapper carrying the journal append ` +
            `(first: ${without[0].id}). A wrapper must \\ir-include its unit AND INSERT INTO ` +
            `${JOURNAL_TABLE} with the supplied project ref, so psql -1 commits both or neither. ` +
            `Anything less is a unit that can apply unrecorded.`,
        )
      }
      return yes(
        id,
        `provenance: ${p.kind}; ${JOURNAL_BOOTSTRAP_FILE} creates the ledger and all ${units.length} ` +
          `wrappers carry the append inside the unit's own transaction — ${p.detail}`,
      )
    },
    negativeControl: {
      description: 'a journal written before commit must fail',
      mutate: (i) => ({
        ...i,
        journalProvenance: {
          kind: 'hosted-journal',
          recordedFields: ['package_id', 'phase', 'sha256', 'applied_at', 'status'],
          writesAfterCommitOnly: false,
          detail: 'written eagerly',
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-storage-channel-capability-demonstrated',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/hosted-capability-probe-status.json',
    requirement:
      'BEFORE the baseline starts, SOME channel is known able to create a policy on storage.objects: ' +
      'SET_ROLE_PATH_VERIFIED or MANAGED_CHANNEL_CAPABILITY_DEMONSTRATED. Nothing here asks about the ' +
      'three canonical policies — they cannot exist yet.',
    evaluate(inputs) {
      const id = 'hosted-storage-channel-capability-demonstrated'

      // Branch A is refuted by catalogue on BOTH identities that were measured.
      if (inputs.storagePath === 'A-set-role') {
        return no(
          id,
          'Branch A is selected while SET_ROLE_PATH_VERIFIED is a pinned false: MEMBER / USAGE / SET ' +
            'against supabase_storage_admin measured false on the psql identity AND on the SQL Editor ' +
            'identity, and supabase_storage_admin is absent from the SETtable set. There is no reading ' +
            'under which SET ROLE exists.',
        )
      }

      // THE PRE-BASELINE HALF OF THE DISJUNCTION.
      //
      // The previous single criterion demanded MANAGED_BOUNDARY_VERIFIED here,
      // which needs the three canonical policies, which need unit 41 PART A,
      // which is a unit OF THE BASELINE this gate authorises. Circular: a gate
      // nobody could ever open. What CAN be known before the first unit runs is
      // whether the channel is capable at all — and the capability probe answers
      // exactly that, which is why it was built to depend on nothing.
      const probeState = inputs.capabilityProbe?.state ?? 'CAPABILITY_PROBE_NOT_RUN'
      const readiness = storageStartReadiness({
        capabilityDemonstrated: inputs.capabilityDemonstrated,
        detail: `capability probe: ${probeState}`,
      })
      if (readiness.ready) {
        return yes(
          id,
          `STORAGE_START_READY via ${readiness.via} — ${readiness.detail}. The SET ROLE arm is a pinned ` +
            `false and contributed nothing. This says the CHANNEL works; the canonical surface is ` +
            `checked by the completion gate, after PART A exists.`,
        )
      }

      const primary = MANAGEMENT_PLANE_EVIDENCE.filter((e) => e.grade === 'primary').length
      const hosted = deriveManagementPlaneVerdict(probeState)
      return no(
        id,
        `${readiness.reason} Channel determination from the repository alone: ${MANAGEMENT_PLANE_PATH}; ` +
          `from hosted evidence: ${hosted} (capability probe ${probeState}), over ${primary} primary ` +
          `sources.`,
      )
    },
    negativeControl: {
      description: 'selecting Branch A after SET was measured false must fail',
      mutate: (i) => ({ ...i, storagePath: 'A-set-role' }),
    },
    observe: (i) =>
      `capabilityProbe=${i.capabilityProbe?.state ?? 'CAPABILITY_PROBE_NOT_RUN'}, ` +
      `capabilityDemonstrated=${i.capabilityDemonstrated}, SET_ROLE_PATH_VERIFIED=false (pinned)`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'hosted-storage-canonical-boundary-verified',
    gate: 'baseline-completion',
    dependsOnPhase: 'post-part-a',
    sourceArtifact: 'artifacts/hosted-storage-boundary-status.json',
    requirement:
      'AFTER unit 41 PART A is committed, the three canonical policies exist on storage.objects with ' +
      'their exact surface. This is what "the baseline is complete" means for Storage, and it cannot be ' +
      'a precondition of starting the baseline.',
    evaluate(inputs) {
      const id = 'hosted-storage-canonical-boundary-verified'
      const readiness = storageCanonicalBoundaryReadiness({
        canonicalBoundaryVerified: inputs.managedBoundaryVerified,
        detail: `canonical boundary verified: ${inputs.managedBoundaryVerified}`,
      })
      if (readiness.ready) {
        return yes(id, `MANAGED_CANONICAL_BOUNDARY_VERIFIED — ${readiness.detail}`)
      }
      return no(
        id,
        `${readiness.reason} A demonstrated channel is not an installed surface: the capability probe ` +
          `created a temporary policy that granted nothing and removed it again. This criterion reads ` +
          `pg_policies for select_evidence / insert_evidence / delete_evidence, and B0-16 compares their ` +
          `whole surface.`,
      )
    },
    negativeControl: {
      description: 'an unverified canonical boundary must fail',
      mutate: (i) => ({ ...i, managedBoundaryVerified: false }),
    },
    observe: (i) =>
      `managedBoundaryVerified=${i.managedBoundaryVerified}, unit41 state from ` +
      `artifacts/hosted-storage-boundary-status.json`,
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'manifest-hashes-and-order',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/hosted/baseline-manifest.ts + the 50-unit corpus',
    requirement:
      'The 50-unit manifest verifies against the corpus: hashes, derived scan, equivalences, order and orphans.',
    evaluate(inputs) {
      const id = 'manifest-hashes-and-order'
      const problems = verifyBaselineManifest(
        inputs.readBaselineSql,
        scanBaselineSql,
        inputs.discoveredBaselineFiles,
      )
      if (problems.length > 0) {
        const kinds = [...new Set(problems.map((p) => p.kind))]
        return no(id, `${problems.length} problem(s) of ${kinds.length} kind(s): ${kinds.join(', ')}. First: ${problems[0].unit} — ${problems[0].detail.slice(0, 140)}`)
      }
      // Order is checked a second time, against a deliberately broken copy, so
      // "the order is fine" rests on the checker having been seen to work.
      const reordered = [...BASELINE_UNITS]
      const p = reordered.findIndex((u) => u.id === '008_marketing_leads_rls.sql')
      const t = reordered.findIndex((u) => u.id === '0035_phase5_marketing_leads.sql')
      const [moved] = reordered.splice(p, 1)
      reordered.splice(t, 0, moved)
      if (verifyBaselineOrder(reordered).length === 0) {
        return no(id, 'the order checker accepted a chain with policy 008 hoisted above the migration that creates its table. A verifier that cannot fail is not evidence the order is right.')
      }
      return yes(id, `all ${BASELINE_UNITS.length} units match their pinned hash and security-surface digest; the order checker was observed refusing a mutation`)
    },
    negativeControl: {
      description: 'one drifted unit must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'db/migrations/0031_rls_core.sql'
            ? `${i.readBaselineSql(f) ?? ''}\n-- drift\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'no-class-d-units',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/hosted/baseline-manifest.ts',
    requirement: 'No unit is classified must-not-run-on-new-staging.',
    evaluate(inputs) {
      const id = 'no-class-d-units'
      const units = inputs.units ?? BASELINE_UNITS
      if (units.length === 0) return no(id, 'no units supplied, so "no class D" is vacuous.')
      const d = units.filter((u) => u.managed === 'D-must-not-run-on-new-staging')
      return d.length === 0
        ? yes(id, `none of the ${units.length} units is class D`)
        : no(id, `class D present: ${d.map((u) => u.id).join(', ')}. A unit that must not run on a new staging project is in the plan.`)
    },
    negativeControl: {
      description: 'a unit classified must-not-run-on-new-staging must fail',
      mutate: (i) => ({
        ...i,
        units: BASELINE_UNITS.map((u, index) =>
          index === 0 ? { ...u, managed: 'D-must-not-run-on-new-staging' as const } : u,
        ),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'zero-production-data',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-checkpoint-a0.json + the 50-unit corpus',
    observe: (i) => (i.checkpointA0 === null ? 'CHECKPOINT A0: no attestation on record, so emptiness rests on nothing' : `A0 projectIsNew=${i.checkpointA0.value.projectIsNew}, stellaSurfaceAbsent=${i.checkpointA0.value.stellaSurfaceAbsent}`),
    requirement:
      'The corpus writes zero rows to an empty database, and A0 confirmed the target holds no Stella surface.',
    evaluate(inputs) {
      const id = 'zero-production-data'
      // Measured from the corpus, not asserted: every DML statement must derive
      // its rows by SELECT. A single VALUES list would mean the baseline itself
      // seeds data into a project that is supposed to receive schema only.
      let literals = 0
      let dmlUnits = 0
      for (const unit of BASELINE_UNITS) {
        const sql = inputs.readBaselineSql(unit.file)
        if (sql === null) return no(id, `cannot read ${unit.file}, so the DML claim cannot be re-derived.`)
        const facts = scanBaselineSql(sql)
        if (facts.dmlStatements.length > 0) dmlUnits += 1
        literals += facts.literalRowSources.length
      }
      if (literals > 0) {
        return no(id, `${literals} DML statement(s) now insert literal rows. The baseline would seed data into a new project.`)
      }
      // THE SAME PROVENANCE THE A0 CRITERION DEMANDS.
      //
      // This read `inputs.checkpointA0` directly and never called `attested()`,
      // so an A0 attestation with no recorded query would have satisfied THIS
      // criterion while `checkpoint-a0-pass` refused the very same object. Two
      // criteria reading one attestation to different standards is how the weaker
      // one becomes the real one.
      const missingA0 = attested(id, 'CHECKPOINT A0', inputs.checkpointA0)
      if (missingA0) return missingA0
      const a = inputs.checkpointA0!
      if (!a.value.stellaSurfaceAbsent) {
        return no(id, 'A0 did not confirm the target is free of Stella surface, so "empty" rests on nothing.')
      }
      // AND THE TARGET OBSERVATION, because the static half cannot supply it.
      //
      // Everything above this line is about the CORPUS: it proves the baseline
      // would not seed data. It says nothing about what the project already
      // holds, and this criterion is named for the project. `stellaSurfaceAbsent`
      // was carrying that weight and cannot: it is four named objects being
      // absent, which a restored dump of another product satisfies trivially.
      if (a.value.publicRelationCount === null) {
        return no(
          id,
          'A0 did not count the relations in schema `public`, so "the target holds no production data" ' +
            'rests on four named objects being absent — which a restored dump of a different product ' +
            'satisfies while holding every row it ever had. Unmeasured is refused.',
        )
      }
      if (a.value.publicRelationCount !== 0) {
        return no(
          id,
          `schema public holds ${a.value.publicRelationCount} relation(s) before a single unit has been ` +
            `applied. A new staging project has none; a restored dump has many. This is the check that ` +
            `tells them apart.`,
        )
      }
      const probed = deriveEmptinessProbes(inputs.readBaselineSql).length
      return yes(id, `${dmlUnits} unit carries DML, 0 statements draw from a literal VALUES list, and the ${probed}-table emptiness set is derived from the corpus rather than hand-listed`)
    },
    negativeControl: {
      description: 'a unit that gains a literal VALUES insert must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'db/migrations/0000_quick_husk.sql'
            ? `${i.readBaselineSql(f) ?? ''}\nINSERT INTO organizations (name, slug) VALUES ('Real', 'real');\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'no-service-role-widening',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'the 50-unit corpus, scanned on every evaluation',
    requirement:
      'Exactly one unit names service_role as a grantee, and it is the known one (0033).',
    evaluate(inputs) {
      const id = 'no-service-role-widening'
      const granters: string[] = []
      for (const unit of BASELINE_UNITS) {
        const sql = inputs.readBaselineSql(unit.file)
        if (sql === null) return no(id, `cannot read ${unit.file}.`)
        if (scanBaselineSql(sql).grantsToServiceRole) granters.push(unit.id)
      }
      return granters.length === 1 && granters[0] === '0033_public_api_grants.sql'
        ? yes(id, 'only 0033 grants to service_role, as recorded; §4.4 forbids provisioning the key that would make it usable')
        : no(id, `service_role grantees are now: ${granters.join(', ') || 'none'} — expected exactly 0033_public_api_grants.sql`)
    },
    negativeControl: {
      description: 'a second unit granting to service_role must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'db/migrations/0012_stella_interactions.sql'
            ? `${i.readBaselineSql(f) ?? ''}\nGRANT ALL ON public.stella_interactions TO service_role;\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'feature-flags-false',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'artifacts/class-c-probes/2026-08-07-feature-flags.json',
    observe: (i) =>
      i.featureFlags === null
        ? 'flag inventory: not measured'
        : `${i.featureFlags.value.environmentsPointingAtTarget?.length ?? 'un'}measured environment(s) ` +
          `pointing at the target, ${Object.keys(i.featureFlags.value.flags).length} flag value(s) recorded`,
    requirement: 'All nine STELLA_* flags are false in every environment pointing at the target.',
    evaluate(inputs) {
      const id = 'feature-flags-false'
      const missing = attested(id, 'the flag inventory', inputs.featureFlags)
      if (missing) return missing
      const a = inputs.featureFlags!
      const scopes = a.value.environmentsPointingAtTarget
      if (scopes === null || !Array.isArray(scopes)) {
        return no(
          id,
          'the environments pointing at the target were not enumerated. An empty flag map cannot be told ' +
            'apart from nobody having looked, and the two must not share a verdict.',
        )
      }

      // NO ENVIRONMENT POINTS AT THE TARGET.
      //
      // Then the universal quantification is vacuously true — and the vacuity is
      // stated rather than hidden, because that is the only honest way to pass
      // on nothing. It is also a real safety fact, not a technicality: with no
      // deployment resolving to this project, no runtime can serve Stella
      // against it, so there is no half-migrated database for a user to reach.
      //
      // It is a POINT-IN-TIME fact, and the criterion says so: an environment
      // created later is a new fact that this attestation does not cover.
      if (scopes.length === 0) {
        const declared = Object.keys(a.value.flags).length
        if (declared > 0) {
          return no(
            id,
            `no environment points at the target, yet ${declared} flag value(s) are recorded. One of the ` +
              `two observations is wrong and this gate will not guess which.`,
          )
        }
        return yes(
          id,
          `no deployment environment points at this project, so none of the ${STELLA_FEATURE_FLAGS.length} ` +
            `flags can be true against it — vacuously satisfied, and stated as such. Attested by ` +
            `${a.measuredBy}. This is point-in-time: an environment created later is a fact this does not ` +
            `cover, and CHECKPOINT B0 re-probes the flags after the baseline.`,
        )
      }

      const OFF = new Set(['false', '0', 'no', 'off', ''])
      const live = STELLA_FEATURE_FLAGS.filter((name) => {
        const raw = a.value.flags[name]
        if (raw === undefined || raw === null) return false
        return typeof raw === 'boolean' ? raw : !OFF.has(raw.trim().toLowerCase())
      })
      return live.length === 0
        ? yes(
            id,
            `all ${STELLA_FEATURE_FLAGS.length} flags false or unset across ${scopes.length} environment(s) ` +
              `pointing at the target (${scopes.join(', ')}) — attested by ${a.measuredBy}`,
          )
        : no(id, `not false: ${live.join(', ')}. Applying the chain is not enabling it, and it stays that way.`)
    },
    negativeControl: {
      description: 'one flag left true must fail',
      mutate: (i) => ({
        ...i,
        featureFlags: i.featureFlags && {
          ...i.featureFlags,
          value: {
            environmentsPointingAtTarget: ['preview'],
            flags: { ...i.featureFlags.value.flags, STELLA_ENABLED: 'true' },
          },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'postconditions-ready',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/hosted/baseline-postconditions.ts',
    requirement:
      'Every CHECKPOINT B0 postcondition fails against its own executable negative control.',
    evaluate(inputs) {
      const id = 'postconditions-ready'
      const expected = deriveExpectedBaselineState(inputs.readBaselineSql)
      if (expected.tables.length === 0) {
        return no(id, 'the expected baseline state derived to nothing, so the postconditions have no bar to measure against.')
      }
      const conforming = {
        schemas: ['public', 'auth', 'storage'],
        tables: [...expected.tables],
        columns: {
          'public.users': ['id', 'email', 'is_super_admin'],
          'public.stella_interactions': ['id', 'organization_id'],
          'public.project_investments': ['id', 'funder_id', 'amount_usd'],
          'public.financial_proxies': ['id', 'value_usd'],
          'public.marketing_leads': ['id', 'email'],
        },
        constraints: [
          'approved_proxy_check',
          'project_investments_contribution_type_check',
          'project_investments_in_kind_notes_check',
          'organizations_slug_unique',
          'users_email_unique',
        ],
        functions: [...expected.functions],
        triggers: [...expected.triggers],
        rlsEnabledTables: [...expected.rlsEnabledTables],
        policies: [...expected.policies],
        roles: ['postgres', 'anon', 'authenticated', 'service_role'],
        grants: [],
        rowCounts: Object.fromEntries(expected.tables.map((t) => [t, 0])),
        extensions: ['pgcrypto'],
        storageBuckets: ['uellix-evidence'],
        storagePolicies: EXPECTED_STORAGE_POLICY_SURFACE.map((p) => ({
          schemaname: 'storage',
          tablename: 'objects',
          policyname: p.policyname,
          roles: p.roles,
          cmd: p.cmd,
          qual: p.predicateKind === 'qual' ? `(bucket_id = '${p.bucket}') AND public.${p.helper}(name, auth.uid())` : null,
          withCheck: p.predicateKind === 'with_check' ? `(bucket_id = '${p.bucket}') AND public.${p.helper}(name, auth.uid())` : null,
        })),
        environmentSecretNames: [],
        // B0-17 / B0-18 arrived with the hosted CHECKPOINT B0 wiring. This
        // fixture exists to prove every postcondition can FAIL, so it must
        // describe a conforming database for the new two as well.
        functionGrants: UNIT_042_GRANTED_FUNCTIONS.map((fn) => `authenticated:EXECUTE:${fn}`),
        journal: {
          packages: [...BASELINE_ORDER],
          environments: ['staging'],
          projectRefs: [KNOWN_STAGING_PROJECT_REF],
          statuses: ['APPLIED'],
        },
      }
      const postconditions = inputs.postconditions ?? BASELINE_POSTCONDITIONS
      const survivors = postconditions.filter(
        (p) => p.check(p.negativeControl.mutate(conforming), expected).passed,
      ).map((p) => p.id)

      return survivors.length === 0
        ? yes(id, `all ${postconditions.length} postconditions were observed failing their own negative control`)
        : no(id, `postcondition(s) that pass their own mutation, i.e. that do not read their input: ${survivors.join(', ')}`)
    },
    negativeControl: {
      // Drives the SURVIVORS branch, not the early return.
      //
      // The previous control blanked the corpus, which tripped the "derived to
      // nothing" guard at the top and left the survivors filter — the actual
      // work of this criterion — never exercised. An inverted predicate there
      // would have passed the sweep. Injecting one decorative postcondition is
      // what makes "the postconditions are not decorative" a measurement.
      description: 'one postcondition that always returns passed:true must fail',
      mutate: (i) => ({
        ...i,
        postconditions: [
          ...BASELINE_POSTCONDITIONS,
          {
            id: 'B0-XX-decorative',
            requirement: 'a check that ignores its input',
            probeSql: 'SELECT 1;',
            check: () => ({ passed: true, detail: 'always' }),
            negativeControl: { description: 'none', mutate: (o) => o },
          },
        ],
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'recovery-plan-conservative',
    gate: 'baseline-start',
    dependsOnPhase: 'pre-baseline',
    sourceArtifact: 'db/hosted/baseline-recovery.ts',
    requirement:
      'A mid-baseline failure answers DESTROY_AND_REPROVISION, and a non-atomic apply halts.',
    evaluate(inputs) {
      const id = 'recovery-plan-conservative'
      const decideRecovery = inputs.decide ?? realDecideRecovery
      const mid = decideRecovery({
        phase: 'PHASE_BASELINE',
        failedUnit: '0031_rls_core.sql',
        failureKind: 'statement-error',
        singleTransaction: true,
        manualWritesOccurred: false,
        holdsIrreplaceableData: false,
      })
      const nonAtomic = decideRecovery({
        phase: 'PHASE_BASELINE',
        failedUnit: '0031_rls_core.sql',
        failureKind: 'statement-error',
        singleTransaction: false,
        manualWritesOccurred: false,
        holdsIrreplaceableData: false,
      })
      const indeterminate = decideRecovery({
        phase: 'PHASE_BASELINE',
        failedUnit: '0005_daffy_dreaming_celestial.sql',
        failureKind: 'indeterminate',
        singleTransaction: true,
        manualWritesOccurred: false,
        holdsIrreplaceableData: false,
      })

      const problems: string[] = []
      if (mid.strategy !== 'DESTROY_AND_REPROVISION') problems.push(`mid-baseline answers ${mid.strategy}`)
      if (nonAtomic.strategy !== 'HALT_AND_ESCALATE') problems.push(`non-atomic answers ${nonAtomic.strategy}`)
      if (indeterminate.strategy !== 'DESTROY_AND_REPROVISION') problems.push(`indeterminate answers ${indeterminate.strategy}`)

      return problems.length === 0
        ? yes(id, 'the recovery table answers the three dangerous situations conservatively, and was driven to prove it')
        : no(id, `recovery table regressed: ${problems.join('; ')}`)
    },
    negativeControl: {
      // A permissive recovery table. If the criterion returned true against
      // THIS, it would not be reading the strategies at all — which is what the
      // first run of the negative-control sweep found it doing.
      description: 'a recovery table that answers RETRY_UNIT to everything must fail',
      mutate: (i) => ({
        ...i,
        decide: () => ({
          strategy: 'RETRY_UNIT' as const,
          rationale: 'permissive stub',
          steps: ['retry'],
          revisitIf: [],
        }),
      }),
    },
  },
]

export interface ApplyAuthorizationReport {
  readonly criteria: readonly AuthorizationVerdict[]
  /** "May PHASE_BASELINE be STARTED?" — only facts that exist beforehand. */
  readonly baselineStartGate: GateReport
  /** "Is the baseline COMPLETE?" — facts that only exist once it has run. */
  readonly baselineCompletionGate: GateReport
  /** True only when the completion gate is clean. Never authorises anything. */
  readonly baselineCompletionVerified: boolean
  /** "May evidence runtime be used?" — the bucket, and what depends on it. */
  readonly stagingRuntimeGate: GateReport
  /**
   * TRUE only when every criterion is satisfied. Even then it authorises a
   * HUMAN to run PHASE_BASELINE; it does not run anything and it is not consent.
   */
  readonly applyAuthorized: boolean
  /** ALWAYS false. Nothing here applies anything. */
  readonly baselineApplied: false
  /** ALWAYS false. */
  readonly stagingApplied: false
  /** ALWAYS false. */
  readonly hostedReady: false
  /** ALWAYS false. */
  readonly providerReady: false
  readonly blocking: readonly string[]
}

/**
 * One blocker, with its four parts kept apart.
 *
 * The separation is the point. `observedEvidence` is what the target said;
 * `expectedProperty` is what the contract requires; `reason` is why the two do
 * not meet; `sourceArtifact` is where a reader goes to check any of it. Collapse
 * them into one string and a conclusion outlives the measurement behind it —
 * which is precisely how "1 blocking" survived into a status report.
 */
export interface GateBlocker {
  readonly id: string
  readonly observedEvidence: string
  readonly expectedProperty: string
  readonly reason: string
  readonly sourceArtifact: string
}

export interface GateReport {
  readonly total: number
  readonly satisfied: number
  readonly blocking: readonly GateBlocker[]
}

function gateReport(gate: GateName, inputs: ApplyAuthorizationInputs): GateReport {
  const criteria = APPLY_AUTHORIZATION_CRITERIA.filter((c) => c.gate === gate)
  const blocking: GateBlocker[] = []
  for (const criterion of criteria) {
    const verdict = criterion.evaluate(inputs)
    if (verdict.satisfied) continue
    blocking.push({
      id: criterion.id,
      observedEvidence: criterion.observe?.(inputs) ?? '(not summarised — see reason)',
      expectedProperty: criterion.requirement,
      reason: verdict.detail,
      sourceArtifact: criterion.sourceArtifact,
    })
  }
  return { total: criteria.length, satisfied: criteria.length - blocking.length, blocking }
}

export function evaluateApplyAuthorization(
  inputs: ApplyAuthorizationInputs,
): ApplyAuthorizationReport {
  const criteria = APPLY_AUTHORIZATION_CRITERIA.map((c) => c.evaluate(inputs))
  const blocking = criteria.filter((c) => !c.satisfied)
  const baselineStartGate = gateReport('baseline-start', inputs)
  const baselineCompletionGate = gateReport('baseline-completion', inputs)
  const stagingRuntimeGate = gateReport('staging-runtime', inputs)

  return {
    criteria,
    baselineStartGate,
    baselineCompletionGate,
    stagingRuntimeGate,
    // AUTHORISATION IS THE BASELINE GATE ALONE.
    //
    // The runtime gate governs a later question — may evidence upload be used —
    // and folding it in here was what made an absent bucket refuse the
    // application of fifty units that never read storage.buckets. The obligation
    // is not weakened: `stagingRuntimeGate` still refuses, and B0-15 still
    // refuses, and nothing marks the environment usable while it does.
    // AUTHORISATION IS THE START GATE ALONE, and the completion gate exists so
    // that saying so is not a weakening. A criterion whose evidence only appears
    // after the baseline runs cannot be a precondition of running it — that was
    // a circular dependency, and the operator found it.
    applyAuthorized: baselineStartGate.blocking.length === 0,
    baselineCompletionVerified: baselineCompletionGate.blocking.length === 0,
    baselineApplied: false,
    stagingApplied: false,
    hostedReady: false,
    providerReady: false,
    blocking: blocking.map((c) => `${c.id}: ${c.detail}`),
  }
}

/** The default production identifiers, re-exported so callers need one import. */
export { KNOWN_PRODUCTION_IDENTIFIERS }
