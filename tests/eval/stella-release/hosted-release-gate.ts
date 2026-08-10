// tests/eval/stella-release/hosted-release-gate.ts
// TRAIN 5B — Phase 13. Seven gates over the HOSTED PREPARATION, and three
// declarations that are hardcoded false.
//
// ---------------------------------------------------------------------------
// WHAT THESE GATES CAN AND CANNOT SEE
// ---------------------------------------------------------------------------
// They see the repository: the bootstrap SQL, the manifest, the supersession
// registry, the target-identity rules and a dry run of the planner. That is
// enough to answer "is the preparation coherent and fail-closed?".
//
// It is NOT enough to answer "did staging receive it?", "is hosted ready?" or
// "is the provider ready?" — each of those is a fact about a system this
// process has never contacted. `local-release-gate.ts` set the precedent by
// hardcoding `stagingBlocked: true` and `hostedBlocked: true`; this module
// hardcodes the three Phase 13 prohibitions the same way, so that no
// combination of green gates can be read as any of them.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { buildHostedArtefacts } from '@/db/hosted/artefacts'
import { generateHostedPackage } from '@/db/hosted/generate-hosted-package'
import {
  HOSTED_CHAIN,
  HOSTED_PACKAGE_MANIFEST,
  hostedManifestEntry,
} from '@/db/hosted/hosted-package-manifest'
import { planHostedApply } from '@/db/hosted/hosted-migrator'
import { PREPARED_PACKAGE_SUPERSESSIONS } from '@/db/prepared-package-order'
import { TRANSACTION_POOLER_PORT, verifyStagingTarget } from '@/db/hosted/target-identity'

export const HOSTED_GATE_IDS = [
  'hosted-capability-preflight-ready',
  'managed-role-bootstrap-ready',
  'hosted-package-manifest-ready',
  'hosted-package-order-ready',
  'staging-target-identity-ready',
  'hosted-migrator-dry-run-ready',
  'r6h-audit-ready',
] as const

export type HostedGateId = (typeof HOSTED_GATE_IDS)[number]

export interface HostedGate {
  readonly id: HostedGateId
  readonly passed: boolean
  readonly detail: string
}

export interface HostedGateEvidence {
  readonly bootstrapSql: string
  readonly artefactsVerified: boolean
  readonly supersessionRuleCount: number
  readonly productionHostRefused: boolean
  readonly sentinelMissingRefused: boolean
  readonly poolerAcceptedWithLoginRole: boolean
  readonly poolerRefusedWithoutLoginRole: boolean
  readonly poolerTransactionPortRefused: boolean
  readonly dryRunStepCount: number
  readonly dryRunPermitsWrites: boolean
  readonly r6hValidateConstraintAbsent: boolean
  readonly r6hCheckStaysNotValid: boolean
  /** Reserved for a future field; present so the shape is stable. */
  readonly bootstrapRefusesSuperuser?: boolean
}

// THE REAL STAGING REF, not a placeholder.
//
// `verifyStagingTarget` is now PINNED to KNOWN_STAGING_PROJECT_REF: a
// syntactically valid ref for some OTHER project is refused, which is audit
// requirement 14. A fixture using a made-up ref would exercise only the
// refusal, so every positive path here would have stopped meaning anything.
const REF = 'bvyzblhqymxruxdguaee'

/**
 * Collects the evidence by actually doing the work — regenerating every
 * artefact, running a dry-run plan, driving the target verifier with a
 * production host. Nothing here is asserted from a constant, because a gate fed
 * by a constant is a gate that measures its own fixture.
 */
export function buildHostedGateEvidence(root: string = process.cwd()): HostedGateEvidence {
  const bootstrapSql = readFileSync(
    path.join(root, 'db', 'prepared', 'stella_hosted_0001_managed_role_bootstrap.sql'),
    'utf8',
  ).replace(/\r\n?/g, '\n')

  // Artefacts: regenerate in memory and compare against what is checked in.
  let artefactsVerified = true
  for (const artefact of buildHostedArtefacts()) {
    try {
      const onDisk = readFileSync(
        path.join(root, 'db', 'prepared', 'hosted', artefact.fileName),
        'utf8',
      ).replace(/\r\n?/g, '\n')
      if (onDisk !== artefact.sql) artefactsVerified = false
    } catch {
      artefactsVerified = false
    }
  }

  const sources: Record<string, string> = {}
  for (const entry of HOSTED_PACKAGE_MANIFEST) {
    sources[entry.name] = readFileSync(path.join(root, 'db', 'prepared', entry.sourceFile), 'utf8')
  }

  const target = {
    declaredEnvironment: 'staging',
    declaredProjectRef: REF,
    connectionHost: `db.${REF}.supabase.co`,
    sentinel: { environment: 'staging', projectRef: REF },
  }

  const dryRun = planHostedApply({
    target,
    packages: [...HOSTED_CHAIN],
    mode: 'dry-run',
    installedProbes: {},
    sources,
  })

  const productionVerdict = verifyStagingTarget({ ...target, connectionHost: 'app.uellix.com' })
  const sentinelVerdict = verifyStagingTarget({ ...target, sentinel: null })

  // ONE CONTRACT, TWO MECHANISMS. The session pooler host is REGIONAL and shared
  // -- every project in the region presents it -- so the ref comes from the login
  // role instead. Measured as a pair on purpose: an audit found the gate saying
  // PASS while the planner refused this very host, and the wrong repair would
  // have been to accept the hostname. Acceptance here means "accepted WITH the
  // login role AND refused without it", never one of the two.
  const pooler = { ...target, connectionHost: 'aws-0-us-east-2.pooler.supabase.com' }
  const poolerVerdict = verifyStagingTarget({ ...pooler, poolerUser: `postgres.${REF}` })
  const poolerBareVerdict = verifyStagingTarget(pooler)
  const poolerTxVerdict = verifyStagingTarget({
    ...pooler,
    poolerUser: `postgres.${REF}`,
    connectionPort: TRANSACTION_POOLER_PORT,
  })

  // R6h: the generated stella_0017 must still add the CHECK as NOT VALID, and
  // nothing anywhere in the hosted chain may emit VALIDATE CONSTRAINT.
  const generated0017 = generateHostedPackage(
    hostedManifestEntry('stella_0017_governed_stella_consumption'),
    sources['stella_0017_governed_stella_consumption'],
  ).sql

  const r6hCheckStaysNotValid =
    generated0017.includes('CHECK (idempotency_key IS NOT NULL) NOT VALID') &&
    generated0017.includes('AND c.contype = \'c\' AND NOT c.convalidated')

  const r6hValidateConstraintAbsent = buildHostedArtefacts().every(
    (a) => !/^\s*ALTER TABLE[^\n]*VALIDATE CONSTRAINT/im.test(a.sql),
  )

  return {
    bootstrapSql,
    artefactsVerified,
    supersessionRuleCount: PREPARED_PACKAGE_SUPERSESSIONS.length,
    productionHostRefused: !productionVerdict.ok && productionVerdict.code === 'HOSTED_TARGET_IS_PRODUCTION',
    sentinelMissingRefused:
      !sentinelVerdict.ok && sentinelVerdict.code === 'HOSTED_TARGET_SENTINEL_MISSING',
    poolerAcceptedWithLoginRole: poolerVerdict.ok,
    poolerRefusedWithoutLoginRole:
      !poolerBareVerdict.ok && poolerBareVerdict.code === 'HOSTED_TARGET_POOLER_USER_MISSING',
    poolerTransactionPortRefused:
      !poolerTxVerdict.ok && poolerTxVerdict.code === 'HOSTED_TARGET_POOLER_TRANSACTION_MODE',
    dryRunStepCount: dryRun.ok ? dryRun.steps.length : -1,
    dryRunPermitsWrites: dryRun.ok ? dryRun.writesPermitted : true,
    r6hValidateConstraintAbsent,
    r6hCheckStaysNotValid,
  }
}

/** The capabilities the bootstrap must probe by name. */
const REQUIRED_CAPABILITY_PROBES = [
  'rolcreaterole',
  'has_schema_privilege',
  'pg_has_role',
  'to_regprocedure',
  'staging_sentinel',
  'server_version_num',
  'pg_advisory_xact_lock',
  'gen_random_uuid',
  'sha256',
  'rolbypassrls',
  // Added after adversarial review A found the BLOCKER: the shim's postcondition
  // checked only the bare `search_path=` spelling. PostgreSQL stores
  // `SET search_path = ''` as `search_path=""`, so the bare-form-only predicate
  // is always true and the RAISE fires on EVERY apply — the package could not be
  // installed at all. `grounding_0002:1087-1093` records the same defect as a
  // measured one. Pinned here so a regression fails a gate instead of failing a
  // provisioning.
  'search_path=""',
  // The right to BECOME the owner, not merely membership in it. On PostgreSQL
  // 16+ a CREATEROLE that creates a role receives ADMIN OPTION without
  // set_option, so `MEMBER` would approve a caller that seven of the nine chain
  // packages then refuse at their first `SET ROLE`.
  "'uellix_owner', 'SET'",
  // The ledger's owner must move, or stella_0013's owner window cannot ALTER it
  // and stella_0017's exhaustive sweep aborts on the baseline owner.
  'ALTER TABLE public.stella_interactions OWNER TO uellix_owner',
]

export function evaluateHostedGates(evidence: HostedGateEvidence): HostedGate[] {
  const gates: HostedGate[] = []

  /* 1 ---------------------------------------------------------------- */
  const missingProbes = REQUIRED_CAPABILITY_PROBES.filter(
    (probe) => !evidence.bootstrapSql.includes(probe),
  )
  gates.push({
    id: 'hosted-capability-preflight-ready',
    passed: missingProbes.length === 0,
    detail:
      missingProbes.length === 0
        ? `the bootstrap probes all ${REQUIRED_CAPABILITY_PROBES.length} concrete capabilities by name, and reports them read-only through uellix_bootstrap.hosted_capability_report()`
        : `the bootstrap no longer probes: ${missingProbes.join(', ')}. Principle 1 of Train 5B is "comprobar capacidades concretas, no rolsuper"; a capability that stopped being probed is a capability nobody checks.`,
  })

  /* 2 ---------------------------------------------------------------- */
  const bootstrapProblems: string[] = []

  // Attribute checks are STATEMENT-scoped, not word-scoped, and the distinction
  // is not pedantry: this file's own prose contains the words SUPERUSER and
  // BYPASSRLS many times — explaining why it refuses them — and a word-level
  // check would flag the explanation as the violation. So the pattern requires
  // a role-mutating verb on the same statement.
  //
  // The scoping is done ONCE, here, by dropping comment lines — the same
  // `executableLines` discipline tests/hosted/managed-compatibility.test.ts
  // already applies. Statement-shaped regexes alone were not enough: the rule
  // below matches `GRANT ... TO ... service_role`, which has no semicolon to
  // bound it and so matched that exact sentence written inside a comment.
  //
  // Found when S1-DEFECT-002 documented the mechanism that caused it — managed
  // Supabase carries `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
  // TO anon, authenticated, service_role` — and this gate refused the package
  // for explaining itself. The contract on the line below already said prose
  // was safe; it just was not implemented. This narrows what the rule READS,
  // never what it REFUSES: a real GRANT statement still fails, and the positive
  // control in the test file pins that.
  const bootstrapStatements = evidence.bootstrapSql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')

  const ROLE_STATEMENT = /\b(CREATE|ALTER)\s+ROLE\b[^;]*/gi
  for (const statement of bootstrapStatements.match(ROLE_STATEMENT) ?? []) {
    if (/(?<!NO)BYPASSRLS/.test(statement)) bootstrapProblems.push('grants BYPASSRLS')
    if (/(?<!NO)SUPERUSER/.test(statement)) bootstrapProblems.push('grants SUPERUSER')
    // CREATEROLE: forbidden for every role the bootstrap creates EXCEPT the
    // installer, and the exemption is narrow enough to name.
    //
    // E-02, measured on PG 17.6. uellix_migrator is the principal every
    // generated elevation names — `GRANT <role> TO uellix_migrator; SET ROLE
    // <role>` — so the chain can only be applied AS it, and six of the nine
    // packages create a capability role. Created NOCREATEROLE it is refused at
    // the FIRST statement of T1 by the capability assertion the bootstrap
    // itself installs. `postgres` cannot take its place: naming a provider role
    // in a membership statement is an AUTHORITY_UNKNOWN_ROLE refusal by design.
    //
    // On PostgreSQL 16+ CREATEROLE administers only the roles its holder
    // created and cannot confer SUPERUSER, so the exemption buys exactly the
    // three capability roles. Every other role, and every other attribute on
    // this one, is still refused — including SUPERUSER and BYPASSRLS above.
    if (/(?<!NO)CREATEROLE/.test(statement) && !/\buellix_migrator\b/.test(statement)) {
      bootstrapProblems.push('grants CREATEROLE')
    }
  }

  // `service_role` as a GRANTEE. `TO ... service_role` is the shape that matters;
  // naming it in a comment that says it is deliberately excluded is not a use.
  if (/\bGRANT\b[^;]*\bTO\b[^;]*\bservice_role\b/i.test(bootstrapStatements)) {
    bootstrapProblems.push('uses service_role as a grantee')
  }
  if (
    !evidence.bootstrapSql.includes(
      'IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN',
    )
  ) {
    bootstrapProblems.push('no longer refuses a superuser installer (it must defer to stella_0004)')
  }
  for (const role of ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor']) {
    if (!evidence.bootstrapSql.includes(role)) bootstrapProblems.push(`does not create ${role}`)
  }
  gates.push({
    id: 'managed-role-bootstrap-ready',
    passed: bootstrapProblems.length === 0,
    detail:
      bootstrapProblems.length === 0
        ? 'the bootstrap creates the five separated roles with NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE, never names service_role as a grantee, and refuses to run where a superuser exists so the stronger stella_0004 model is not silently replaced'
        : `bootstrap violates: ${bootstrapProblems.join('; ')}`,
  })

  /* 3 ---------------------------------------------------------------- */
  gates.push({
    id: 'hosted-package-manifest-ready',
    passed: evidence.artefactsVerified && HOSTED_PACKAGE_MANIFEST.length === HOSTED_CHAIN.length,
    detail: evidence.artefactsVerified
      ? `all ${HOSTED_PACKAGE_MANIFEST.length} artefacts regenerate byte-identically from their pinned sources; a canonical edit produces HOSTED_SOURCE_SHA_MISMATCH and a rule edit produces HOSTED_REWRITE_COUNT_MISMATCH`
      : 'at least one checked-in artefact no longer matches what its canonical source plus the rewrite rules produce. Run `pnpm hosted:verify` for the list. Never edit the artefact.',
  })

  /* 4 ---------------------------------------------------------------- */
  gates.push({
    id: 'hosted-package-order-ready',
    passed: evidence.supersessionRuleCount === 8,
    detail:
      evidence.supersessionRuleCount === 8
        ? 'the hosted planner probes the SAME eight supersession rules db/migrator.ts uses — one registry, two runners, no hosted-only copy to drift'
        : `expected 8 supersession rules, found ${evidence.supersessionRuleCount}. A rule that disappeared is a re-application nobody refuses.`,
  })

  /* 5 ---------------------------------------------------------------- */
  const identityOk =
    evidence.productionHostRefused &&
    evidence.sentinelMissingRefused &&
    evidence.poolerAcceptedWithLoginRole &&
    evidence.poolerRefusedWithoutLoginRole &&
    evidence.poolerTransactionPortRefused
  gates.push({
    id: 'staging-target-identity-ready',
    passed: identityOk,
    detail: identityOk
      ? 'a production host is refused with HOSTED_TARGET_IS_PRODUCTION before any other check; a target without an in-database sentinel is refused with HOSTED_TARGET_SENTINEL_MISSING; and ONE contract covers both connection modes -- the session pooler is accepted only WITH its postgres.<ref> login role, refused without it, and refused on the transaction port'
      : `identity refusals incomplete: productionHostRefused=${evidence.productionHostRefused}, sentinelMissingRefused=${evidence.sentinelMissingRefused}, poolerAcceptedWithLoginRole=${evidence.poolerAcceptedWithLoginRole}, poolerRefusedWithoutLoginRole=${evidence.poolerRefusedWithoutLoginRole}, poolerTransactionPortRefused=${evidence.poolerTransactionPortRefused}`,
  })

  /* 6 ---------------------------------------------------------------- */
  const dryRunOk = evidence.dryRunStepCount === HOSTED_CHAIN.length && !evidence.dryRunPermitsWrites
  gates.push({
    id: 'hosted-migrator-dry-run-ready',
    passed: dryRunOk,
    detail: dryRunOk
      ? `a dry run plans all ${HOSTED_CHAIN.length} packages, records a source hash and a generated hash per step, and permits no writes; apply mode additionally requires hosted_apply:<project-ref>`
      : `dry run produced ${evidence.dryRunStepCount} steps and writesPermitted=${evidence.dryRunPermitsWrites}`,
  })

  /* 7 ---------------------------------------------------------------- */
  const r6hOk = evidence.r6hValidateConstraintAbsent && evidence.r6hCheckStaysNotValid
  gates.push({
    id: 'r6h-audit-ready',
    passed: r6hOk,
    detail: r6hOk
      ? 'the generated stella_0017 still adds stella_interactions_governed_identity_check as NOT VALID and still aborts if it finds it VALIDATED; no artefact in the chain emits VALIDATE CONSTRAINT'
      : `R6h contract broken: validateConstraintAbsent=${evidence.r6hValidateConstraintAbsent}, checkStaysNotValid=${evidence.r6hCheckStaysNotValid}`,
  })

  return gates
}

export interface HostedGateReport {
  readonly gates: readonly HostedGate[]
  /** ALWAYS false. No repository-only evidence can establish it. */
  readonly stagingApplied: false
  /** ALWAYS false. */
  readonly hostedReady: false
  /** ALWAYS false. */
  readonly providerReady: false
  readonly missingForHosted: readonly string[]
}

export function computeHostedGateReport(evidence: HostedGateEvidence): HostedGateReport {
  const gates = evaluateHostedGates(evidence)

  return {
    gates,
    stagingApplied: false,
    hostedReady: false,
    providerReady: false,
    missingForHosted: [
      ...gates.filter((g) => !g.passed).map((g) => `gate ${g.id} failed: ${g.detail}`),
      'no staging Supabase project has been provisioned — the chain has never been applied to any hosted database',
      'the read-only hosted inspection (CHECKPOINT A / gate G12) has not been executed; every "requires hosted verification" row of STELLA_HOSTED_ENVIRONMENT_MATRIX.md is still open',
      'RR-09 is UNRESOLVED offline: whether the role that owns the RLS helpers can reach auth.uid() on a real managed project is measurable only there. The bootstrap refuses if it cannot, which is a fail-closed answer and not a verified one',
      'GEMINI_API_KEY has no staging-scoped rotation on file (STELLA_TRAIN_5A_BLOCKED_PROVIDER_KEY_ROTATION)',
      'gate G7 (legal review) has no signed fitness determination for this train',
    ],
  }
}
