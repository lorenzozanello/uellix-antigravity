// db/hosted/remediation-operator.ts
// COMMIT 5.4 — the operator boundary of the prechain remediation (F-PS-05).
//
// ---------------------------------------------------------------------------
// WHAT WAS MISSING, AND WHY IT WAS NOT A DOCUMENTATION GAP
// ---------------------------------------------------------------------------
// Commit 5.3 built the whole decision path — `buildRemediationWitnessSql`,
// `parseRemediationWitness`, `planRemediationAttempt`, the attempt ledger — and
// certified it end to end on an exact-staging-shaped engine. It left them
// reachable from exactly one caller: `scripts/remediation-certify.ts`, whose
// declared target safety is that no connection string can name a target and the
// containers have no interface but loopback.
//
// That is the right guarantee for a laboratory and it is also a wall. An
// operator holding a staging DSN had no supported way to reach the functions
// that decide whether staging may be written, so the only routes left were the
// two the contract forbids: hand-deriving the witness from the Commit 5.1
// prechain probe (which measures four of the six facts and carries no attempt
// binding), or running psql with no consumed attempt at all — which is the hole
// 5.3 exists to close, on the one package that has no rollback.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS ALLOWED TO BE
// ---------------------------------------------------------------------------
// An ADAPTER. It composes certified functions and formats their answer; it
// decides nothing. Every verdict below is produced by a function Commit 5.3
// certified, and the tests assert that by comparing this module's output with
// those functions' own output rather than with a transcription of it.
//
// It also connects to nothing. There is no driver here, no environment read and
// no process spawned — the SQL is emitted for a human to run, and the document
// that comes back arrives as a file. The write itself stays manual, which is
// what keeps "one observation, one write" enforceable at all: the ledger is
// consumed BEFORE the operator is handed the command, so a lost acknowledgement
// leaves a spent attempt rather than a re-appliable one.

import {
  PRECHAIN_REMEDIATION,
  type RemediationState,
} from './prechain-remediation'
import {
  RemediationPinRefusal,
  planRemediationAttempt,
  remediationAttemptLine,
  verifyRemediationPin,
} from './remediation-attempt'
import {
  RemediationTransportRefusal,
  bodyDigest,
  buildRemediationWitnessSql,
  extractDollarQuotedBody,
  parseRemediationWitness,
} from './authority/certification/remediation-probes'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  type ProductionIdentifiers,
} from './target-identity'

/**
 * Where `open` leaves the probe.
 *
 * A file rather than stdout only, because the operator has to run it with
 * `psql -f` and a probe reassembled from a scrollback is a probe that can lose
 * a line. It is overwritten by the next `open`, deliberately: an old probe on
 * disk is an old attempt someone can re-run, and the ledger would then refuse
 * it — correct, but after the round trip rather than before it.
 */
export const REMEDIATION_PROBE_ARTIFACT = 'artifacts/hosted-remediation-witness-probe.sql'

/**
 * The function header whose dollar-quoted body the witness digests.
 *
 * Named here so the operator path and the certification harness cannot drift on
 * WHICH body is the certified one. The digest itself is never pinned as a
 * constant — see `certifiedCapabilitiesBodyDigest`.
 */
export const CERTIFIED_CAPABILITIES_BODY_HEADER =
  'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)'

/**
 * The digest the witness compares `prosrc` against, LIFTED FROM THE PACKAGE.
 *
 * Deriving rather than pinning is the point: a second pinned copy of this hash
 * would be a second thing to update, and the failure mode of forgetting is a
 * witness that reports `capabilitiesBodyIsCertified: false` on a correctly
 * remediated project — which classifies PARTIAL_OR_INCONSISTENT and sends a
 * healthy database to human recovery.
 */
export function certifiedCapabilitiesBodyDigest(remediationSql: string): string {
  return bodyDigest(extractDollarQuotedBody(remediationSql, CERTIFIED_CAPABILITIES_BODY_HEADER))
}

/* -------------------------------------------------------------------------- */
/* The target                                                                  */
/* -------------------------------------------------------------------------- */

export type RemediationOperatorRefusalCode =
  | 'REMEDIATION_PIN_MISMATCH'
  | 'HOSTED_TARGET_IS_PRODUCTION'
  | 'HOSTED_TARGET_NOT_EXPECTED_PROJECT'
  | string

export interface RemediationOperatorRefusal {
  readonly ok: false
  readonly code: RemediationOperatorRefusalCode
  readonly detail: string
}

const refuse = (code: string, detail: string): RemediationOperatorRefusal => ({
  ok: false,
  code,
  detail,
})

/**
 * The declared target, checked against the two lists that outrank it.
 *
 * NOT `verifyStagingTarget`: that function requires a connection host and the
 * in-database sentinel, and the remediation witness carries neither — it is a
 * catalog measurement, not a corroboration document. What is checkable here is
 * the ref the operator declares and the ledger will record, so that is what is
 * checked, with the production veto first for the same reason it is first
 * there: three agreeing signals are a reason to proceed and a known production
 * identifier is a reason to stop.
 */
function checkTarget(
  ref: string,
  production: ProductionIdentifiers,
  expected: string,
): RemediationOperatorRefusal | null {
  if (production.projectRefs.includes(ref) || production.hosts.includes(ref)) {
    return refuse(
      'HOSTED_TARGET_IS_PRODUCTION',
      `${ref} is a KNOWN PRODUCTION identifier. The prechain remediation is a forward-only ` +
        `authority reconciliation with no rollback script; there is no state of any observation ` +
        `that makes this target acceptable.`,
    )
  }
  if (ref !== expected) {
    return refuse(
      'HOSTED_TARGET_NOT_EXPECTED_PROJECT',
      `${ref} is not the expected staging project (${expected}). An attempt is recorded against a ` +
        `ref, and a ledger line naming the wrong database is a ledger that describes work nobody did.`,
    )
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* open                                                                        */
/* -------------------------------------------------------------------------- */

export interface RemediationOpenResult {
  readonly attemptId: string
  readonly packageId: string
  readonly sourceFile: string
  readonly sourceSha256: string
  readonly certifiedBodyDigest: string
  readonly targetProjectRef: string
  /** Read-only. Emitted for a human to run; nothing here executes it. */
  readonly probeSql: string
  /** One append-only line. The caller appends it; this function writes nothing. */
  readonly ledgerLine: string
}

export interface RemediationOpenInputs {
  /** Minted by the caller, before the probe. `att_` + 32 hex. */
  readonly attemptId: string
  /** The pinned package's bytes. Verified before a probe is built. */
  readonly remediationSql: string
  readonly at: string
  readonly targetProjectRef?: string
  readonly production?: ProductionIdentifiers
  readonly expectedProjectRef?: string
}

/**
 * Mint the binding, emit the probe.
 *
 * The pin is verified FIRST and throws rather than returning: an operator who
 * is about to measure a database for a package whose bytes moved should not
 * receive a probe at all, and a refusal that arrived as a value could be
 * ignored by a caller that only checked the SQL field.
 */
export function openRemediationAttempt(inputs: RemediationOpenInputs): RemediationOpenResult {
  const production = inputs.production ?? KNOWN_PRODUCTION_IDENTIFIERS
  const expected = inputs.expectedProjectRef ?? KNOWN_STAGING_PROJECT_REF
  const ref = inputs.targetProjectRef ?? expected

  const sourceSha256 = verifyRemediationPin(inputs.remediationSql)

  const target = checkTarget(ref, production, expected)
  if (target !== null) throw new Error(`${target.code}: ${target.detail}`)

  const certifiedBodyDigest = certifiedCapabilitiesBodyDigest(inputs.remediationSql)

  return {
    attemptId: inputs.attemptId,
    packageId: PRECHAIN_REMEDIATION.id,
    sourceFile: PRECHAIN_REMEDIATION.sourceFile,
    sourceSha256,
    certifiedBodyDigest,
    targetProjectRef: ref,
    probeSql: buildRemediationWitnessSql(inputs.attemptId, certifiedBodyDigest),
    ledgerLine: remediationAttemptLine('OPENED', inputs.attemptId, ref, inputs.at),
  }
}

/* -------------------------------------------------------------------------- */
/* plan                                                                        */
/* -------------------------------------------------------------------------- */

/** The operator record. Field names are the report's vocabulary, not prose. */
export interface RemediationOperatorRecord {
  readonly REMEDIATION_ATTEMPT_ID: string
  readonly WITNESS: RemediationState
  readonly PACKAGE_ID: string
  readonly PACKAGE_PATH: string
  readonly PIN_STATUS: string
  readonly ATTEMPT_STATUS: 'CONSUMED'
  readonly DECISION: 'AUTHORIZED'
  readonly TARGET_PROJECT_REF: string
}

export interface RemediationOperatorAuthorization {
  readonly ok: true
  readonly record: RemediationOperatorRecord
  /** Appended by the caller BEFORE the operator is given the write command. */
  readonly consumedLedgerLine: string
  readonly log: readonly string[]
}

export type RemediationOperatorResult =
  | RemediationOperatorAuthorization
  | RemediationOperatorRefusal

export interface RemediationPlanOperatorInputs {
  /** The witness document the operator's read-only probe produced. */
  readonly witnessRaw: string | null
  readonly expectedAttemptId: string
  readonly attemptLedger: string | null
  readonly remediationSql: string
  readonly requestedPackageId?: string
  readonly at: string
  readonly targetProjectRef?: string
  readonly production?: ProductionIdentifiers
  readonly expectedProjectRef?: string
}

/**
 * Whether ONE remediation write may be planned — every step delegated.
 *
 * Order is part of the contract. The pin is checked before the witness is even
 * parsed, so a package whose bytes moved is refused without the operator being
 * told anything about the database; and the planner is consulted last, because
 * it is the only thing entitled to say AUTHORIZED.
 */
export function planRemediationWrite(
  inputs: RemediationPlanOperatorInputs,
): RemediationOperatorResult {
  const production = inputs.production ?? KNOWN_PRODUCTION_IDENTIFIERS
  const expected = inputs.expectedProjectRef ?? KNOWN_STAGING_PROJECT_REF
  const ref = inputs.targetProjectRef ?? expected

  let sourceSha256: string
  try {
    sourceSha256 = verifyRemediationPin(inputs.remediationSql)
  } catch (error) {
    if (error instanceof RemediationPinRefusal) return refuse(error.code, error.message)
    throw error
  }

  const target = checkTarget(ref, production, expected)
  if (target !== null) return target

  let document: ReturnType<typeof parseRemediationWitness>
  try {
    document = parseRemediationWitness(inputs.witnessRaw, inputs.expectedAttemptId)
  } catch (error) {
    if (error instanceof RemediationTransportRefusal) return refuse(error.code, error.message)
    throw error
  }

  const plan = planRemediationAttempt({
    observation: document.observation,
    expectedAttemptId: inputs.expectedAttemptId,
    attemptLedger: inputs.attemptLedger,
    ...(inputs.requestedPackageId !== undefined
      ? { requestedPackageId: inputs.requestedPackageId }
      : {}),
  })
  if (!plan.ok) return refuse(plan.code, plan.detail)

  return {
    ok: true,
    record: {
      REMEDIATION_ATTEMPT_ID: plan.attemptId,
      WITNESS: plan.classification.state,
      PACKAGE_ID: plan.packageId,
      PACKAGE_PATH: plan.sourceFile,
      PIN_STATUS: `VERIFIED sha256=${sourceSha256}`,
      ATTEMPT_STATUS: 'CONSUMED',
      DECISION: 'AUTHORIZED',
      TARGET_PROJECT_REF: ref,
    },
    consumedLedgerLine: remediationAttemptLine('CONSUMED', plan.attemptId, ref, inputs.at),
    log: plan.log,
  }
}
