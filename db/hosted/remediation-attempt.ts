// db/hosted/remediation-attempt.ts
// COMMIT 5.3 — the remediation's place in the forward-only attempt
// architecture, and the planner that is the only thing allowed to authorise a
// remediation write.
//
// ---------------------------------------------------------------------------
// WHAT COMMIT 5.2 LEFT OPEN
// ---------------------------------------------------------------------------
// 5.2 reported REMEDIATION_FRESH_OBSERVATION = ENFORCED, and the witness half
// was true: `classifyRemediation` reads catalog facts and never "the file was
// run". What was missing is the other half of freshness, and it is the half
// RT-02 was actually about:
//
//   a measurement is only fresh if something REFUSES to authorise a second
//   write from it.
//
// Without a ledger, "fresh" means "the operator believes this is recent", and
// the failure mode is the one already measured on the chain: the apply reaches
// the server and commits, the connection dies before the acknowledgement, and
// the operator re-plans from the observation still on their screen. For the
// chain that would re-apply a package. For the remediation it would re-apply a
// FORWARD-ONLY authority reconciliation — and §0 (S6) would refuse it, which is
// the right outcome arrived at by the wrong mechanism: the refusal would come
// from the database after the operator had already decided to write.
//
// ---------------------------------------------------------------------------
// WHY THIS SHARES THE CHAIN'S MACHINERY AND NOT ITS REGISTRY
// ---------------------------------------------------------------------------
// The rules are identical — an attempt is opened before the probe, the probe
// echoes it, opening an attempt retires every earlier one, and an attempt is
// spent by the plan it authorises — so the parsing and status functions are
// IMPORTED rather than rewritten. A second implementation of "one observation,
// one write" is a second place for it to be almost right.
//
// What is NOT shared is the identity. The remediation is not in HOSTED_CHAIN,
// has no chain witness, and never appears in `nextChainPackage`; it is a
// PREREQUISITE of T1. So it has:
//
//   * its own typed attempt KIND, refused if absent — a chain attempt cannot be
//     mistaken for a remediation attempt even if the two files were swapped;
//   * its own ledger FILE, because they are two independently-serialized
//     resources and a chain attempt opened later must not retire a remediation
//     attempt that is still the current measurement of a different question.
//
// ---------------------------------------------------------------------------
// THE CONSUMPTION POINT IS BEFORE THE WRITE, NOT AFTER
// ---------------------------------------------------------------------------
// An attempt is marked CONSUMED when the plan is issued — before psql is
// invoked — and that is the whole of the ambiguity contract. If the process
// dies at any point after the plan, the ledger says CONSUMED, the planner
// refuses to reuse it, and the operator's only route forward is a NEW attempt
// with a NEW observation. Which is correct in BOTH ambiguous directions:
//
//   committed but unacknowledged  the new observation reads INSTALLED and the
//                                 planner refuses to re-apply.
//   rolled back but unobserved    the new observation reads ABSENT and the
//                                 planner authorises a fresh attempt.
//
// Consuming AFTER a successful write would have left the lost-acknowledgement
// case with an attempt still OPEN, which is exactly the hole.

import {
  ATTEMPT_ID_SHAPE,
  attemptStatus,
  parseAttemptLedger,
  type AttemptStatus,
  type ChainAttemptRecord,
} from './fresh-observation'
import {
  PRECHAIN_REMEDIATION,
  classifyRemediation,
  sha256OfPreparedSql,
  type RemediationClassification,
  type RemediationObservation,
} from './prechain-remediation'

/** Append-only. One JSON object per line. Never rewritten, never truncated. */
export const REMEDIATION_ATTEMPT_LEDGER = 'artifacts/hosted-remediation-attempts.jsonl'

/** The typed kind. A record without it is not a remediation attempt. */
export const REMEDIATION_ATTEMPT_KIND = 'prechain-remediation'

/**
 * The ONLY package a remediation plan may name.
 *
 * A list of one, deliberately, rather than a constant compared with `===`: the
 * shape states that selection is a lookup in a closed set. `stella_hosted_0001`
 * is not in it and there is no branch that adds it — see
 * `OLD_BOOTSTRAP_SECOND_PASS`.
 */
export const SELECTABLE_REMEDIATION_PACKAGES: readonly string[] = [PRECHAIN_REMEDIATION.id]

/**
 * The bootstrap's second pass, named so a test can assert the prohibition
 * rather than assert the absence of a string.
 *
 * MEASURED: `stella_hosted_0001` section 5 ends with
 * `ALTER SCHEMA uellix_bootstrap OWNER TO uellix_owner`, and seventeen of its
 * statements then require an ownership `postgres` no longer has. It fails at
 * its first `COMMENT ON SCHEMA`, before reconciling anything. It is not a
 * fallback for a failed remediation and there is no path that selects it.
 */
export const OLD_BOOTSTRAP_ID = 'stella_hosted_0001_managed_role_bootstrap'
export const OLD_BOOTSTRAP_SECOND_PASS = 'PROHIBITED' as const

export interface RemediationAttemptRecord extends ChainAttemptRecord {
  readonly kind: typeof REMEDIATION_ATTEMPT_KIND
}

/**
 * The remediation attempts in a ledger, and nothing else.
 *
 * A line that parses as a generic attempt but does not declare the remediation
 * kind is DROPPED rather than accepted, on the same principle as a corrupt
 * line: something that is not a remediation attempt can never make one OPEN.
 */
export function parseRemediationAttemptLedger(
  raw: string | null,
): readonly RemediationAttemptRecord[] {
  return parseAttemptLedger(raw).filter(
    (r): r is RemediationAttemptRecord => r.kind === REMEDIATION_ATTEMPT_KIND,
  )
}

export function remediationAttemptStatus(
  records: readonly RemediationAttemptRecord[],
  attemptId: string,
): AttemptStatus {
  return attemptStatus(records, attemptId)
}

/** One ledger line. The caller appends it; nothing here writes. */
export function remediationAttemptLine(
  event: 'OPENED' | 'CONSUMED',
  attemptId: string,
  targetProjectRef: string,
  at: string,
): string {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new Error(
      `[remediation] refusing to write a ledger line for attempt id ${JSON.stringify(attemptId)}: ` +
        `an attempt id is att_ followed by 32 hex characters.`,
    )
  }
  const record: RemediationAttemptRecord = {
    attemptId,
    event,
    targetProjectRef,
    at,
    kind: REMEDIATION_ATTEMPT_KIND,
    ...(event === 'CONSUMED' ? { packageId: PRECHAIN_REMEDIATION.id } : {}),
  }
  return `${JSON.stringify(record)}\n`
}

/* -------------------------------------------------------------------------- */
/* The pin                                                                     */
/* -------------------------------------------------------------------------- */

export class RemediationPinRefusal extends Error {
  readonly code = 'REMEDIATION_PIN_MISMATCH'
  constructor(detail: string) {
    super(`REMEDIATION_PIN_MISMATCH: ${detail}`)
    this.name = 'RemediationPinRefusal'
  }
}

/**
 * The bytes, or a refusal — BEFORE a server is contacted.
 *
 * The digest is over the LF-normalized text, so a CRLF checkout matches; the
 * point of the pin is that the SQL an operator applies is the SQL that was
 * reviewed, not that the file has particular line endings.
 */
export function verifyRemediationPin(sql: string): string {
  const actual = sha256OfPreparedSql(sql)
  if (actual !== PRECHAIN_REMEDIATION.sourceSha256) {
    throw new RemediationPinRefusal(
      `${PRECHAIN_REMEDIATION.sourceFile} hashes to ${actual} and the registry pins ` +
        `${PRECHAIN_REMEDIATION.sourceSha256}. A byte moved. This package performs a one-shot, ` +
        `forward-only authority reconciliation with no rollback script, so an unreviewed edit is ` +
        `the one change that cannot be undone by re-running anything — the refusal happens here, ` +
        `before any SQL reaches a server.`,
    )
  }
  return actual
}

/* -------------------------------------------------------------------------- */
/* The planner                                                                 */
/* -------------------------------------------------------------------------- */

export type RemediationPlanRefusalCode =
  | 'REMEDIATION_ATTEMPT_MALFORMED'
  | 'REMEDIATION_ATTEMPT_NOT_OPEN'
  | 'REMEDIATION_ALREADY_INSTALLED'
  | 'REMEDIATION_PARTIAL_HUMAN_ONLY'
  | 'REMEDIATION_PACKAGE_NOT_PERMITTED'

export interface RemediationPlanRefusal {
  readonly ok: false
  readonly code: RemediationPlanRefusalCode
  readonly detail: string
}

export interface RemediationPlan {
  readonly ok: true
  readonly attemptId: string
  readonly packageId: string
  readonly sourceFile: string
  readonly sourceSha256: string
  readonly classification: RemediationClassification
  readonly log: readonly string[]
}

export interface RemediationPlanInputs {
  /**
   * The observation measured FOR THIS ATTEMPT, already parsed and typed.
   *
   * Typed rather than raw on purpose: `parseRemediationWitness` binds the
   * document to the attempt and refuses an untyped field, and repeating either
   * job here would be a second contract. The planner's question is a different
   * one — what does this measurement authorise.
   */
  readonly observation: RemediationObservation
  /** The attempt the caller opened, in memory, before the probe ran. */
  readonly expectedAttemptId: string
  /** The append-only ledger's bytes, or null when nothing has been opened. */
  readonly attemptLedger: string | null
  /** What the operator asked to apply. Must be selectable when present. */
  readonly requestedPackageId?: string
}

const refuse = (
  code: RemediationPlanRefusalCode,
  detail: string,
): RemediationPlanRefusal => ({ ok: false, code, detail })

/**
 * Whether ONE remediation write may be planned, and which package it is.
 *
 * Every refusal below is a state the certification exercises on a real engine.
 */
export function planRemediationAttempt(
  inputs: RemediationPlanInputs,
): RemediationPlan | RemediationPlanRefusal {
  if (!ATTEMPT_ID_SHAPE.test(inputs.expectedAttemptId)) {
    return refuse(
      'REMEDIATION_ATTEMPT_MALFORMED',
      `the caller supplied attempt id ${JSON.stringify(inputs.expectedAttemptId)}, which is not ` +
        `att_ followed by 32 hex characters.`,
    )
  }

  // THE PACKAGE, FIRST. A request naming the old bootstrap is refused before
  // anything is measured: no state of the database makes it selectable, and a
  // refusal that arrived only after a clean observation would read as "the
  // database is not ready" rather than "that is not a remediation vehicle".
  if (inputs.requestedPackageId !== undefined) {
    if (!SELECTABLE_REMEDIATION_PACKAGES.includes(inputs.requestedPackageId)) {
      return refuse(
        'REMEDIATION_PACKAGE_NOT_PERMITTED',
        inputs.requestedPackageId === OLD_BOOTSTRAP_ID
          ? `${OLD_BOOTSTRAP_ID} is the FIRST-PROVISION bootstrap and its second pass is ` +
              `${OLD_BOOTSTRAP_SECOND_PASS}. Measured: section 5 hands schema uellix_bootstrap to ` +
              `uellix_owner, and from the second apply onwards seventeen of its statements require ` +
              `an ownership postgres no longer holds — it dies at its first COMMENT ON SCHEMA, ` +
              `having reconciled nothing. It is not a fallback when ${PRECHAIN_REMEDIATION.id} ` +
              `fails; a correction is a NEW forward-only package.`
          : `${inputs.requestedPackageId} is not a selectable remediation package. The set is ` +
              `exactly [${SELECTABLE_REMEDIATION_PACKAGES.join(', ')}].`,
      )
    }
  }

  const status = remediationAttemptStatus(
    parseRemediationAttemptLedger(inputs.attemptLedger),
    inputs.expectedAttemptId,
  )
  if (status !== 'OPEN') {
    return refuse(
      'REMEDIATION_ATTEMPT_NOT_OPEN',
      status === 'UNKNOWN'
        ? `attempt ${inputs.expectedAttemptId} was never opened in ${REMEDIATION_ATTEMPT_LEDGER}. An ` +
            `attempt is opened BEFORE the probe runs; one that appears only now was not the attempt ` +
            `anything measured, so the observation offered with it is stale by construction.`
        : `attempt ${inputs.expectedAttemptId} is spent — it was consumed by a plan already, or a ` +
            `later attempt superseded it. One observation authorises one write. If the previous ` +
            `attempt ended ambiguously, the recovery is a NEW attempt and a NEW observation, never ` +
            `the reuse of this one: the database may have committed after the acknowledgement was ` +
            `lost, and this measurement cannot tell you which.`,
    )
  }

  const classification = classifyRemediation(inputs.observation)

  if (classification.state === 'INSTALLED') {
    return refuse(
      'REMEDIATION_ALREADY_INSTALLED',
      `${PRECHAIN_REMEDIATION.id} measured INSTALLED in this observation. It is forward-only: a ` +
        `committed authority reconciliation is never written again. If the acknowledgement was ` +
        `lost, this measurement IS the answer — the package committed. Proceed to the prechain ` +
        `authority gate; do not re-apply.`,
    )
  }

  if (classification.state === 'PARTIAL_OR_INCONSISTENT') {
    return refuse(
      'REMEDIATION_PARTIAL_HUMAN_ONLY',
      `${PRECHAIN_REMEDIATION.id} measured PARTIAL_OR_INCONSISTENT: ` +
        `${[...classification.problems, ...classification.missing.map((m) => `missing: ${m}`)].join('; ')}. ` +
        `Half a reconciliation is neither absent nor installed, so applying over it and re-running ` +
        `it are both wrong and neither is authorised. There is no automatic repair: this package ` +
        `has no rollback by design, and a repair chosen by a machine would be a guess about what ` +
        `happened. Human recovery.`,
    )
  }

  return {
    ok: true,
    attemptId: inputs.expectedAttemptId,
    packageId: PRECHAIN_REMEDIATION.id,
    sourceFile: PRECHAIN_REMEDIATION.sourceFile,
    sourceSha256: PRECHAIN_REMEDIATION.sourceSha256,
    classification,
    log: [
      `attempt ${inputs.expectedAttemptId} is OPEN in ${REMEDIATION_ATTEMPT_LEDGER}`,
      `witness classified here from ${classification.missing.length} absent fact(s): ABSENT`,
      `authorised EXACTLY ONE write: ${PRECHAIN_REMEDIATION.id}`,
    ],
  }
}
