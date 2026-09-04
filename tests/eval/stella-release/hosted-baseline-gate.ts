// tests/eval/stella-release/hosted-baseline-gate.ts
// TRAIN 5C0 — Phase 13. Six gates over the BASELINE preparation, and four
// declarations that are hardcoded false.
//
// ---------------------------------------------------------------------------
// SEPARATE FROM hosted-release-gate.ts ON PURPOSE
// ---------------------------------------------------------------------------
// That module gates Train 5B's Stella chain. This one gates the fifty units that
// must land before the chain exists. Merging them would produce one report whose
// green could mean either half was ready, and the entire point of the phase
// model is that those are different questions with different evidence.
//
// ---------------------------------------------------------------------------
// WHAT THESE GATES CANNOT SEE, AND THE FOUR WORDS THEY MAY NOT SAY
// ---------------------------------------------------------------------------
// They see the repository: fifty SQL files, a manifest, a scanner, a phased
// planner, a postcondition set and a recovery table. That is enough for "is the
// preparation coherent, ordered and fail-closed?".
//
// It is not enough for `baselineApplied`, `stagingApplied`, `hostedReady` or
// `providerReady`. Not one hosted byte has been written by this train. Following
// the precedent `local-release-gate.ts` set and `hosted-release-gate.ts`
// continued, those four are hardcoded false rather than computed, so that no
// arrangement of passing gates can be read as any of them.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import {
  BASELINE_ORDER,
  BASELINE_UNITS,
  REHEARSAL_ARTEFACT,
  baselineManifestDigest,
  verifyBaselineManifest,
  verifyBaselineOrder,
} from '@/db/hosted/baseline-manifest'
import { scanBaselineSql } from '@/db/hosted/baseline-scanner'
import {
  BASELINE_POSTCONDITIONS,
  deriveExpectedBaselineState,
  UNIT_042_GRANTED_FUNCTIONS,
} from '@/db/hosted/baseline-postconditions'
import { decideRecovery } from '@/db/hosted/baseline-recovery'
import { MANAGED_ROLE_IDENTITIES } from '@/db/hosted/managed-role-identities'
import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import { planProvisioningPhase, type TargetStateProbe } from '@/db/hosted/hosted-provisioning-runner'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'

export const HOSTED_BASELINE_GATE_IDS = [
  'hosted-baseline-manifest-ready',
  'hosted-baseline-order-ready',
  'hosted-baseline-managed-compatible',
  'hosted-baseline-rehearsal-ready',
  'hosted-baseline-postconditions-ready',
  'hosted-baseline-recovery-ready',
] as const

export type HostedBaselineGateId = (typeof HOSTED_BASELINE_GATE_IDS)[number]

export interface HostedBaselineGate {
  readonly id: HostedBaselineGateId
  readonly passed: boolean
  readonly detail: string
}

export interface HostedBaselineGateEvidence {
  readonly manifestProblems: readonly string[]
  readonly unitCount: number
  readonly orderProblemsOnMutation: number
  readonly dependencyViolationDetected: boolean
  readonly superuserFreeUnits: number
  readonly serviceRoleGranters: readonly string[]
  readonly dmlUnits: readonly string[]
  readonly literalRowSources: number
  readonly mustNotRunUnits: readonly string[]
  /** A recorded rehearsal exists AND was run against this exact manifest. */
  readonly rehearsalFresh: boolean
  /** That run watched the naive order abort at 0039. */
  readonly rehearsalReproducedDefect: boolean
  /** That run applied all 59 units in manifest order. */
  readonly rehearsalAppliedAll: boolean
  /** That run's CHECKPOINT B0 was clean. */
  readonly rehearsalPostconditionsClean: boolean
  readonly postconditionCount: number
  readonly postconditionsSurvivingOwnNegativeControl: readonly string[]
  readonly nonReadOnlyProbes: readonly string[]
  readonly recoveryDefaultsToDestroy: boolean
  readonly recoveryRefusesWithoutAtomicity: boolean
  readonly phaseSkipRefused: boolean
  readonly sentinelAutomationRefused: boolean
  readonly firstProvisioningPlannable: boolean
}

// THE REAL STAGING REF, not a placeholder.
//
// `verifyStagingTarget` is now PINNED to KNOWN_STAGING_PROJECT_REF: a
// syntactically valid ref for some OTHER project is refused, which is audit
// requirement 14. A fixture using a made-up ref would exercise only the
// refusal, so every positive path here would have stopped meaning anything.
const REF = 'bvyzblhqymxruxdguaee'

function discover(root: string): string[] {
  const dirs: [string, (n: string) => boolean][] = [
    ['db/migrations', (n) => /^\d{4}_.*\.sql$/.test(n)],
    ['supabase/migrations', (n) => n.endsWith('.sql')],
    ['db/policies', (n) => n.endsWith('.sql')],
  ]
  const out: string[] = []
  for (const [dir, accept] of dirs) {
    let names: string[]
    try {
      names = readdirSync(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of names.sort()) if (accept(name)) out.push(`${dir}/${name}`)
  }
  return out
}

/**
 * Collects the evidence by DOING the work — verifying the manifest, mutating the
 * order and watching it refuse, running every postcondition against its own
 * negative control, driving the planner into three refusals. Nothing here is
 * asserted from a constant, because a gate fed by a constant measures its own
 * fixture.
 */
export function buildHostedBaselineGateEvidence(
  root: string = process.cwd(),
): HostedBaselineGateEvidence {
  const read = (file: string): string | null => {
    try {
      return readFileSync(path.join(root, file), 'utf8')
    } catch {
      return null
    }
  }

  const manifestProblems = verifyBaselineManifest(read, scanBaselineSql, discover(root)).map(
    (p) => `[${p.kind}] ${p.unit}: ${p.detail}`,
  )

  // Order: mutate the chain and confirm the checker notices. A verifier that has
  // only ever seen the correct input has never been observed to work.
  const reordered = [...BASELINE_UNITS]
  const policyIndex = reordered.findIndex((u) => u.id === '008_marketing_leads_rls.sql')
  const tableIndex = reordered.findIndex((u) => u.id === '0035_phase5_marketing_leads.sql')
  const [policy] = reordered.splice(policyIndex, 1)
  reordered.splice(tableIndex, 0, policy)
  const orderProblems = verifyBaselineOrder(reordered)

  // Managed compatibility, measured across the corpus rather than declared.
  let superuserFreeUnits = 0
  const serviceRoleGranters: string[] = []
  const dmlUnits: string[] = []
  let literalRowSources = 0
  for (const unit of BASELINE_UNITS) {
    const sql = read(unit.file)
    if (sql === null) continue
    const facts = scanBaselineSql(sql)
    if (
      facts.superuserDependencies.length === 0 &&
      facts.roleStatements.length === 0 &&
      facts.ownershipStatements.length === 0 &&
      facts.extensionStatements.length === 0
    ) {
      superuserFreeUnits += 1
    }
    if (facts.grantsToServiceRole) serviceRoleGranters.push(unit.id)
    if (facts.dmlStatements.length > 0) dmlUnits.push(unit.id)
    literalRowSources += facts.literalRowSources.length
  }

  // Postconditions: every one against its own mutation.
  const expected = deriveExpectedBaselineState(read)
  const conformingObservation = {
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

    storagePolicies: [

      { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", withCheck: null },

      { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))" },

      { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", withCheck: null },

    ],
    environmentSecretNames: [],
    // B0-17 / B0-18 arrived with the hosted CHECKPOINT B0 wiring. This fixture
    // exists to prove every postcondition CAN fail, so it has to describe a
    // conforming database for the new two as well.
    functionGrants: UNIT_042_GRANTED_FUNCTIONS.map((fn) => `authenticated:EXECUTE:${fn}`),
    journal: {
      packages: [...BASELINE_ORDER],
      environments: ['staging'],
      projectRefs: [KNOWN_STAGING_PROJECT_REF],
      statuses: ['APPLIED'],
    },
  }

  const survivors: string[] = []
  for (const postcondition of BASELINE_POSTCONDITIONS) {
    const broken = postcondition.negativeControl.mutate(conformingObservation)
    if (postcondition.check(broken, expected).passed) survivors.push(postcondition.id)
  }
  const WRITES = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i
  // A probe is read-only if it is a SELECT, or a comment-only operator
  // instruction, and in neither case contains a write verb. B0-14 is the second
  // kind by necessity: SUPABASE_SERVICE_ROLE_KEY lives in a secret manager, and
  // inventing a query that appeared to check it would be the decorative-check
  // failure this gate exists to catch.
  const nonReadOnlyProbes = BASELINE_POSTCONDITIONS.filter(
    (p) => !/^\s*(SELECT\b|--)/i.test(p.probeSql) || WRITES.test(p.probeSql),
  ).map((p) => p.id)

  // Recovery: the two answers that matter most.
  const recoveryDefaultsToDestroy =
    decideRecovery({
      phase: 'PHASE_BASELINE',
      failedUnit: '0031_rls_core.sql',
      failureKind: 'statement-error',
      singleTransaction: true,
      manualWritesOccurred: false,
      holdsIrreplaceableData: false,
    }).strategy === 'DESTROY_AND_REPROVISION'

  const recoveryRefusesWithoutAtomicity =
    decideRecovery({
      phase: 'PHASE_BASELINE',
      failedUnit: '0031_rls_core.sql',
      failureKind: 'statement-error',
      singleTransaction: false,
      manualWritesOccurred: false,
      holdsIrreplaceableData: false,
    }).strategy === 'HALT_AND_ESCALATE'

  // The planner, driven into the refusals the phase model exists to produce.
  const target = {
    declaredEnvironment: 'staging',
    declaredProjectRef: REF,
    connectionHost: `db.${REF}.supabase.co`,
    sentinel: null,
  }
  const virgin: TargetStateProbe = {
    baselineUnitsInstalled: [],
    bootstrapSchemaPresent: false,
    sentinel: null,
    stellaPackagesInstalled: {},
    businessRowCounts: null,
    // HPO-ODS-W2-03: PHASE_BASELINE is plannable only once the five managed
    // role identities exist on the cluster (0042/0045 name uellix_app).
    uellixRoles: [...MANAGED_ROLE_IDENTITIES],
    // All three class-C probes affirmative. The gate is measuring whether a
    // first provisioning is PLANNABLE, not whether this machine's fictional
    // target has the privileges; the refusals for a missing or false probe are
    // exercised in tests/hosted/hosted-provisioning-runner.test.ts.
    privileges: {
      canCreateTriggerOnAuthUsers: true,
      ownsStorageObjects: true,
      evidenceBucketExists: true,
      applyIdentityRecorded: true,
      storageAdminMember: true,
      storageAdminInherits: true,
      canSetRoleStorageAdmin: true,
      setLocalRoleDemonstrated: true,
    },
  }
  const stellaSources: Record<string, string> = {}
  for (const name of HOSTED_CHAIN) {
    stellaSources[name] = readFileSync(path.join(root, 'db', 'prepared', `${name}.sql`), 'utf8')
  }
  const baseRequest = {
    target,
    mode: 'dry-run' as const,
    featureFlags: {},
    readBaselineSql: read,
    stellaSources,
    discoveredBaselineFiles: discover(root),
  }

  const skipped = planProvisioningPhase({ ...baseRequest, phase: 'PHASE_STELLA_CHAIN', state: virgin })
  const sentinelAutomated = planProvisioningPhase({
    ...baseRequest,
    phase: 'PHASE_STELLA_BOOTSTRAP',
    state: virgin,
    sentinelWriteRequested: true,
  })
  const firstProvisioning = planProvisioningPhase({
    ...baseRequest,
    phase: 'PHASE_BASELINE',
    state: virgin,
  })

  // THE REHEARSAL ARTEFACT, not the rehearsal SCRIPT.
  //
  // Adversarial review B: this used to be `readFileSync(script)` in a try/catch,
  // which succeeds in a CI that has no Docker and has therefore never executed a
  // rehearsal. A gate called `hosted-baseline-rehearsal-ready` that greens on
  // file existence invites exactly the reading its name suggests and does not
  // support. So it now reads what a completed run recorded, and checks the run
  // was about THIS manifest — a result from before a manifest edit is not
  // evidence about the manifest after it.
  let rehearsal: {
    manifestDigest?: string
    naiveFailedAt?: string | null
    manifestApplied?: number
    manifestFailedAt?: string | null
    postconditionsPassed?: number
    postconditionsTotal?: number
  } | null = null
  try {
    rehearsal = JSON.parse(readFileSync(path.join(root, REHEARSAL_ARTEFACT), 'utf8'))
  } catch {
    rehearsal = null
  }

  const currentDigest = baselineManifestDigest()
  const rehearsalFresh = rehearsal?.manifestDigest === currentDigest
  const rehearsalReproducedDefect =
    rehearsal?.naiveFailedAt === 'db/migrations/0039_grant_rls_helper_execution.sql'
  const rehearsalAppliedAll =
    rehearsal?.manifestFailedAt === null && rehearsal?.manifestApplied === BASELINE_UNITS.length
  const rehearsalPostconditionsClean =
    typeof rehearsal?.postconditionsTotal === 'number' &&
    rehearsal.postconditionsTotal > 0 &&
    rehearsal.postconditionsPassed === rehearsal.postconditionsTotal

  return {
    manifestProblems,
    unitCount: BASELINE_UNITS.length,
    orderProblemsOnMutation: orderProblems.length,
    dependencyViolationDetected: orderProblems.some(
      (p) => p.kind === 'ORDER_BROKEN' && p.unit === '008_marketing_leads_rls.sql',
    ),
    superuserFreeUnits,
    serviceRoleGranters,
    dmlUnits,
    literalRowSources,
    mustNotRunUnits: BASELINE_UNITS.filter((u) => u.managed === 'D-must-not-run-on-new-staging').map(
      (u) => u.id,
    ),
    rehearsalFresh,
    rehearsalReproducedDefect,
    rehearsalAppliedAll,
    rehearsalPostconditionsClean,
    postconditionCount: BASELINE_POSTCONDITIONS.length,
    postconditionsSurvivingOwnNegativeControl: survivors,
    nonReadOnlyProbes,
    recoveryDefaultsToDestroy,
    recoveryRefusesWithoutAtomicity,
    phaseSkipRefused: !skipped.ok && skipped.code === 'PROVISIONING_BASELINE_INCOMPLETE',
    sentinelAutomationRefused:
      !sentinelAutomated.ok && sentinelAutomated.code === 'PROVISIONING_SENTINEL_IS_NOT_A_MIGRATION',
    // W2-B2 (FIBIU-08/09/10) — 68, NOT 67: unit ZERO creates the journal
    // table, and it is a planned step rather than setup because a
    // prerequisite nobody plans is one somebody skips. 67 baseline units
    // (64 + 1 for 0053_fib_proxy_versions_provenance.sql + 1 for
    // 0054_fib_proxy_rubric_constraints.sql + 1 for 0055_fib_proxy_material_
    // change_registry.sql) + 1 journal bootstrap step. The count is
    // asserted rather than loosened to `>= 67` — a plan that silently grew
    // or shrank is exactly what this evidence exists to notice.
    // W2-B2-R1 (R-B2-03/07): 69 baseline units + 1 journal bootstrap step = 70.
    // COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08) — re-derived on the
    // reconciled corpus: W2-B3 added 0057/0058/0059 (72) and 0060 (73); the
    // Product line added no unit (HPO-ODS-W2-03 only re-pinned 0044). 73
    // baseline units + 1 journal bootstrap step = 74.
    // HPO-ODS-W2-09: + 0061 (B0-17 security successor to sealed 0060) = 74
    // baseline units + 1 journal bootstrap step = 75 — derived from
    // planProvisioningPhase (000_journal_bootstrap + one step per BASELINE_ORDER).
    // W2-B4 (FIBIU-15/14/16): + 0062_fib_methodological_assumptions.sql and
    // 0063_fib_counterfactual_assessments.sql = 76 baseline units + 1 journal
    // bootstrap step = 77. This is a DERIVED count (BASELINE_ORDER.length + 1),
    // which is why the authority's forced-pin sweep — which enumerated pins
    // carrying the raw unit count 74 — did not surface it. Advanced as an exact
    // count, never loosened to `>= 77`: a plan that silently grew or shrank is
    // exactly what this evidence exists to notice.
    // W2-B5 (FIBIU-17/18): + 0064_fib_readiness_assessments.sql and
    // 0065_fib_sensitivity_model.sql = 78 baseline units + 1 journal bootstrap
    // step = 79 — the same N+1 trap the B5 authority's own baseline_growth_contract
    // named this exact line by number so a literal-76 sweep would not miss it.
    firstProvisioningPlannable:
      firstProvisioning.ok &&
      firstProvisioning.steps.length === 79 &&
      firstProvisioning.steps[0].id === '000_journal_bootstrap',
  }
}

export function evaluateHostedBaselineGates(
  evidence: HostedBaselineGateEvidence,
): HostedBaselineGate[] {
  const gates: HostedBaselineGate[] = []

  /* 1 ---------------------------------------------------------------- */
  // W2-B2 (FIBIU-08/09/10) — 67, re-derived: FIB Wave 2 B1 closure left 64
  // units; this batch adds three Drizzle migrations (0053_fib_proxy_versions_
  // provenance.sql, 0054_fib_proxy_rubric_constraints.sql,
  // 0055_fib_proxy_material_change_registry.sql). 64 + 3 = 67.
  // W2-B2-R1 (R-B2-03): + 0056 = 68; (R-B2-07): + policies unit 010 = 69.
  // COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08): + 0057/0058/0059
  // (W2-B3) = 72; + 0060 (W2-B3 completeness) = 73. Same derivation as
  // tests/hosted/baseline-manifest.test.ts, independently re-verified there.
  // HPO-ODS-W2-09: + 0061 = 74.
  // HPO-ODS-W2-12 (W2-B4 assumptions and causality): + 0062/0063 = 76.
  // HPO-ODS-W2-17 (W2-B5 governed models): + 0064/0065 = 78.
  const manifestOk = evidence.manifestProblems.length === 0 && evidence.unitCount === 78
  gates.push({
    id: 'hosted-baseline-manifest-ready',
    passed: manifestOk,
    detail: manifestOk
      ? `all ${evidence.unitCount} units pin a SHA-256 AND an expected structural scan; an unannounced edit produces SHA_MISMATCH and an announced edit that changes what the unit DOES additionally produces SCAN_MISMATCH, so updating a hash cannot silently relicense a file`
      : `manifest does not match the corpus: ${evidence.manifestProblems.slice(0, 3).join(' | ')}`,
  })

  /* 2 ---------------------------------------------------------------- */
  const orderOk = evidence.orderProblemsOnMutation > 0 && evidence.dependencyViolationDetected
  gates.push({
    id: 'hosted-baseline-order-ready',
    passed: orderOk,
    detail: orderOk
      ? 'the order is deterministic and its checker was OBSERVED refusing a mutation: hoisting policy 008 above the migration that creates marketing_leads is detected as ORDER_BROKEN. The order also encodes the defect Train 5C0 found — both supabase/migrations units precede 0039, which grants EXECUTE on functions only they define'
      : 'the order checker did not refuse a deliberately broken chain. A verifier that has only seen valid input has not been shown to work.',
  })

  /* 3 ---------------------------------------------------------------- */
  const managedProblems: string[] = []
  if (evidence.superuserFreeUnits !== evidence.unitCount) {
    managedProblems.push(
      `${evidence.unitCount - evidence.superuserFreeUnits} unit(s) depend on superuser, a role statement, an ownership transfer or an extension`,
    )
  }
  if (evidence.serviceRoleGranters.length !== 1 || evidence.serviceRoleGranters[0] !== '0033_public_api_grants.sql') {
    managedProblems.push(`service_role grantees changed: ${evidence.serviceRoleGranters.join(', ') || 'none'}`)
  }
  // W2-B1-R1 (R-B1-03) — 0048 added: db/migrations/0048_fib_evidence_
  // versions.sql's stage-B backfill (one v1 shell row per existing
  // evidence_items row, FIBIU-04) is genuine INSERT DML, verified in
  // tests/hosted/baseline-manifest.test.ts, not asserted here on trust.
  // W2-B2 (FIBIU-10) — 0055 added: db/migrations/0055_fib_proxy_material_
  // change_registry.sql's literal 39-row field->category seed, the SAME
  // global-catalog-seed class as unit 51 (0040), also verified there.
  const EXPECTED_DML_UNITS = [
    '0018_redundant_firebird.sql',
    '0040_governed_model_registry.sql',
    '0041_pc01b_regime_boundary_backfill.sql',
    '0047_fib_taxonomy_mapping_governance_regime.sql',
    '0048_fib_evidence_versions.sql',
    '0055_fib_proxy_material_change_registry.sql',
    // W2-B2-R1 (R-B2-03) — 0056: two literal global-catalog seeds (registry
    // 1.1.0 rows + the governed model append), verified in
    // tests/hosted/baseline-manifest.test.ts.
    '0056_fib_proxy_material_fields_editability.sql',
  ]
  if (
    evidence.dmlUnits.length !== EXPECTED_DML_UNITS.length ||
    evidence.dmlUnits.some((id, i) => id !== EXPECTED_DML_UNITS[i])
  ) {
    managedProblems.push(`DML units changed: ${evidence.dmlUnits.join(', ') || 'none'}`)
  }
  // Exactly 2, not 0 or 1: unit 51 (0040) carries a deliberate, literal,
  // deploy-time seed of 8 fixed global-catalog rows (FIBC-003); unit 67
  // (0055) carries a second — 39 fixed field->category rows (FIBC-013) —
  // universal reference data, not tenant/production data, same class. 0018,
  // 0041 and 0047 still write zero rows on an empty database; a THIRD
  // literal source, or a changed count, means either a seed grew or a new
  // unit started writing literal rows unannounced.
  // W2-B2-R1 (R-B2-03): unit 68 (0056) carries TWO further literal seeds —
  // the 70-row registry_version 1.1.0 classification and the governed-model
  // append — so exactly 4: 0040:1, 0055:1, 0056:2.
  if (evidence.literalRowSources !== 4) {
    managedProblems.push(`${evidence.literalRowSources} DML statement(s) now insert literal rows, expected exactly 4 (units 51, 67 and 68's global-catalog seeds)`)
  }
  if (evidence.mustNotRunUnits.length > 0) {
    managedProblems.push(`units classified must-not-run: ${evidence.mustNotRunUnits.join(', ')}`)
  }
  gates.push({
    id: 'hosted-baseline-managed-compatible',
    passed: managedProblems.length === 0,
    detail:
      managedProblems.length === 0
        ? `all ${evidence.unitCount} units are free of superuser dependencies, role statements, ownership transfers and extensions; exactly one (0033) grants to service_role and it is recorded rather than hidden; seven units (0018, 0040, 0041, 0047, 0048, 0055, 0056) carry DML — 0018, 0041, 0047 and 0048 write zero rows on an empty database, and 0040, 0055 and 0056 write exactly four literal deploy-time global-catalog seeds (8 + 39 + 70 + 1 rows, not tenant data)`
        : `managed compatibility broken: ${managedProblems.join('; ')}`,
  })

  /* 4 ---------------------------------------------------------------- */
  const rehearsalOk =
    evidence.rehearsalFresh &&
    evidence.rehearsalReproducedDefect &&
    evidence.rehearsalAppliedAll &&
    evidence.rehearsalPostconditionsClean &&
    evidence.firstProvisioningPlannable &&
    evidence.phaseSkipRefused
  gates.push({
    id: 'hosted-baseline-rehearsal-ready',
    passed: rehearsalOk,
    detail: rehearsalOk
      ? 'a rehearsal was EXECUTED against this exact manifest (digest matches): it watched the naive 0000…0039 order abort at 0039 with 42883, then applied all 74 units in manifest order, then passed every CHECKPOINT B0 postcondition. The phased planner separately produces a complete 74-unit PHASE_BASELINE plan and refuses PHASE_STELLA_CHAIN against a virgin target. LIMIT, and it is not a formality: the local Supabase stack applies supabase/migrations at container start and the rehearsal shims auth and storage as OUR objects, so this is a REGRESSION test and a DEFECT REPRODUCTION — never evidence of managed-Supabase compatibility'
      : `rehearsalFresh=${evidence.rehearsalFresh} (a stale or absent artefact means no rehearsal has run against the CURRENT manifest), reproducedDefect=${evidence.rehearsalReproducedDefect}, appliedAll=${evidence.rehearsalAppliedAll}, postconditionsClean=${evidence.rehearsalPostconditionsClean}, firstProvisioningPlannable=${evidence.firstProvisioningPlannable}, phaseSkipRefused=${evidence.phaseSkipRefused}. Run \`pnpm baseline:rehearsal:local\`.`,
  })

  /* 5 ---------------------------------------------------------------- */
  const postconditionsOk =
    evidence.postconditionCount >= 13 &&
    evidence.postconditionsSurvivingOwnNegativeControl.length === 0 &&
    evidence.nonReadOnlyProbes.length === 0
  gates.push({
    id: 'hosted-baseline-postconditions-ready',
    passed: postconditionsOk,
    detail: postconditionsOk
      ? `${evidence.postconditionCount} postconditions, every one of them OBSERVED failing against its own executable negative control, and every probe a bare SELECT. A postcondition that ignored its input would pass its own mutation and fail this gate`
      : `survivors of their own negative control: ${evidence.postconditionsSurvivingOwnNegativeControl.join(', ') || 'none'}; non-read-only probes: ${evidence.nonReadOnlyProbes.join(', ') || 'none'}; count=${evidence.postconditionCount}`,
  })

  /* 6 ---------------------------------------------------------------- */
  const recoveryOk =
    evidence.recoveryDefaultsToDestroy &&
    evidence.recoveryRefusesWithoutAtomicity &&
    evidence.sentinelAutomationRefused
  gates.push({
    id: 'hosted-baseline-recovery-ready',
    passed: recoveryOk,
    detail: recoveryOk
      ? 'a mid-baseline statement error answers DESTROY_AND_REPROVISION, not hand-repair — the baseline has zero rollback scripts and 37 of 48 Drizzle units cannot be re-applied, so resuming would mean trusting a ledger about a database whose last operation failed. A unit applied without psql -1 halts instead of guessing, and the runner refuses to write the sentinel under any circumstances'
      : `defaultsToDestroy=${evidence.recoveryDefaultsToDestroy}, refusesWithoutAtomicity=${evidence.recoveryRefusesWithoutAtomicity}, sentinelAutomationRefused=${evidence.sentinelAutomationRefused}`,
  })

  return gates
}

export interface HostedBaselineGateReport {
  readonly gates: readonly HostedBaselineGate[]
  /** ALWAYS false. No hosted byte has been written. */
  readonly baselineApplied: false
  /** ALWAYS false. */
  readonly stagingApplied: false
  /** ALWAYS false. */
  readonly hostedReady: false
  /** ALWAYS false. */
  readonly providerReady: false
  readonly missingForHostedBaselineApply: readonly string[]
}

export function computeHostedBaselineGateReport(
  evidence: HostedBaselineGateEvidence,
): HostedBaselineGateReport {
  const gates = evaluateHostedBaselineGates(evidence)

  return {
    gates,
    baselineApplied: false,
    stagingApplied: false,
    hostedReady: false,
    providerReady: false,
    missingForHostedBaselineApply: [
      ...gates.filter((g) => !g.passed).map((g) => `gate ${g.id} failed: ${g.detail}`),
      `the baseline has NEVER been applied to any hosted database — all ${BASELINE_ORDER.length} units are planned, none are applied`,
      'CHECKPOINT B0 has no result, because it can only run after a write this train did not perform',
      'whether the `postgres` role of the staging project may CREATE TRIGGER on auth.users is UNVERIFIED (unit 40, class C). The runner now refuses PHASE_BASELINE without the probe, but the probe has not been run',
      'whether that role OWNS storage.objects — which CREATE POLICY requires — is UNVERIFIED (unit 41, class C, reclassified from B by adversarial review A). Same refusal, same un-run probe',
      "whether the 'uellix-evidence' Storage bucket exists on the staging project is UNVERIFIED. supabase/config.toml creates it locally and NOTHING in the fifty units creates it hosted; all three storage policies gate on it",
      'the local rehearsal is a regression test and a defect reproduction. The Supabase CLI stack applies supabase/migrations at container start, and the rehearsal shims auth and storage as OUR objects — so a green run says nothing about managed-Supabase privileges',
      'the Train 4 E2E (scripts/stella-ticket-e2e.sh) restores db/baseline/**, a pg_dump of a PRE-capability Supabase database with different schemas, owners and counts. It is regression evidence for Train 4, NOT for these fifty units, and must not be cited as the latter',
      'db/hosted/target-identity.ts KNOWN_PRODUCTION_IDENTIFIERS.projectRefs is still EMPTY. An unfilled denylist removes a veto; the three positive signals remain required, but P5 of the provisioning requirements is open',
      'the TargetStateProbe is operator-attested, not machine-verified: this planner opens no connection by design, so it trusts the read-only measurements it is handed. CHECKPOINT B0 is what re-checks them after the fact',
      "Lorenzo's explicit authorization for the first hosted write has not been given",
    ],
  }
}
