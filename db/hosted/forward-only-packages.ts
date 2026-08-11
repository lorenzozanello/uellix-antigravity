// db/hosted/forward-only-packages.ts
// M-8 — the registry of prepared packages that ship NO `_rollback.sql`, and the
// reason each one does not.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A REGISTRY AND NOT A SECOND `if` IN THE TEST
// ---------------------------------------------------------------------------
// `tests/prepared-sql-source-of-truth.test.ts` requires a rollback script for
// every forward package, and until now carried exactly one exemption. Its
// comment states the rule the exemption was written under:
//
//   "Exactly ONE exemption, and it is typed rather than spelled here … Writing
//    the filename into this test instead would make the next exemption a
//    one-line edit nobody has to justify."
//
// This is the next exemption. Adding a second `if (file === '…')` would have
// been the one-line edit that comment forbids, so the shape is generalised
// instead: the test iterates THIS list, every member has to carry a reason, and
// the reason has to be long enough that it cannot be a shrug. What was a
// property of one package is now a property of a KIND of package.
//
// ---------------------------------------------------------------------------
// WHAT "FORWARD-ONLY" MEANS HERE, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// It means: there is no script whose job is to put the database back. It does
// NOT mean the package is irreversible, and it does not mean a failure leaves
// debris:
//
//   PRE-COMMIT FAILURE   the transaction rolls back and PostgreSQL restores the
//                        prior posture. MEASURED, per package, by the failure
//                        injections in scripts/pg176-certify.ts — never assumed
//                        from "DDL is transactional".
//   INSTALLED            never re-applied, never downgraded. A correction is a
//                        NEW forward-only package.
//   REVERSAL             where it is genuinely wanted, it goes through the
//                        surrounding unit's own rollbacks, which were written
//                        and measured for that purpose.
//
// The distinction matters because the two are easy to conflate, and conflating
// them produces the worst artefact of all: a `_rollback.sql` written to satisfy
// a registry, whose correctness nobody measured, sitting next to a package
// whose whole argument is that the state it removed should not come back.

import { PRECHAIN_REMEDIATION } from './prechain-remediation'

export interface ForwardOnlyPackage {
  /** Basename WITHOUT `.sql`, exactly as it appears in db/prepared/. */
  readonly id: string
  /**
   * Why undoing this is not something a script can do.
   *
   * Read by the registry tripwire, which asserts it is substantial. A short
   * reason is the failure mode this field exists to make visible: "no rollback"
   * is a decision, and a decision with a one-line justification is a decision
   * nobody made.
   */
  readonly reason: string
  /** What an operator does INSTEAD, when reversal is genuinely wanted. */
  readonly reversalPath: string
}

export const FORWARD_ONLY_PACKAGES: readonly ForwardOnlyPackage[] = [
  {
    // Derived from the prechain declaration rather than restated, so the two
    // cannot drift into giving different reasons for the same absence.
    id: PRECHAIN_REMEDIATION.id,
    reason: PRECHAIN_REMEDIATION.forwardOnlyNoRollbackReason,
    reversalPath:
      'There is none by script. An ambiguous result is classified by a fresh catalog observation; ' +
      'a correction is a new forward-only package.',
  },
  {
    id: 'grounding_0005_claim_advisory_lock',
    reason:
      'FORWARD-ONLY. What this package removes is a DEFECT, not a feature: grounding_0002 published ' +
      'claim_active_document_version taking a row lock on public.evidence_items, and PostgreSQL ' +
      'requires UPDATE on a table to take one, which uellix_cap_grounding deliberately does not ' +
      'hold. "Restore the previous version of claim_active_document_version" and "republish a lock ' +
      'no principal can take" are therefore the same sentence, and a rollback script would be one ' +
      'whose only effect is to make a governed function uncallable again — 42501 on every call, ' +
      'the governed ingestion path dead on the write side, which is exactly the state M-8 names. ' +
      'The same reasoning stella_0016 and stella_0017 record for R1 and R6-INT: a package that ' +
      'closes a vulnerability cannot ship a script that reopens it and call that a revert.',
    reversalPath:
      'The grounding unit\'s own rollbacks, in order: grounding_0004_rollback.sql, then ' +
      'grounding_0003_rollback.sql, then grounding_0002_rollback.sql. That withdraws the whole ' +
      'surface deliberately, which is the honest way to remove a function four packages depend on ' +
      '— rather than leaving a broken version of it behind.',
  },
]

/** The ids, for a caller that only needs membership. */
export const FORWARD_ONLY_PACKAGE_IDS: readonly string[] = FORWARD_ONLY_PACKAGES.map((p) => p.id)

/** The declaration for one package, or `null` when it must ship a rollback. */
export function forwardOnlyPackage(id: string): ForwardOnlyPackage | null {
  return FORWARD_ONLY_PACKAGES.find((p) => p.id === id) ?? null
}
