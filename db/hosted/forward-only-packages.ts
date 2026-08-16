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
import {
  PRECHAIN_OWNERSHIP,
  PRECHAIN_STORAGE_TABLE_READ,
  PRECHAIN_STORAGE_USAGE,
} from './prechain-ownership'

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
  {
    // M-2. Derived from the prechain-ownership declaration for the same reason
    // the first entry is derived from the remediation one: two files must not
    // be able to give different reasons for the same absence.
    id: PRECHAIN_OWNERSHIP.id,
    reason: PRECHAIN_OWNERSHIP.forwardOnlyNoRollbackReason,
    reversalPath:
      'There is none by script, and that is the point. A single administrative ' +
      '`ALTER FUNCTION public.can_read_evidence_object(text, uuid) OWNER TO postgres` and the same ' +
      'for can_write_evidence_object, issued by the principal that applied this package, restores ' +
      'the prior owner — with the consequence visible at the time: stella_0019 becomes ' +
      'uninstallable again, and any already-installed four-role body is left owned by a role the ' +
      'governed chain cannot reach.',
  },
  {
    // M-2, the SECOND OF THREE. It was written as "the second half of the
    // prechain pair", and the pair turned out not to be enough: see the entry
    // below. The package's own pinned SQL still says "pair" and is deliberately
    // NOT edited — it is audited and installed-shaped, and the correction
    // belongs where the reader looks (db/prepared/README.md), not in a rewrite
    // of the artefact. Separate from the first for the same reason stella_0005d
    // is separate from stella_0004 locally.
    id: PRECHAIN_STORAGE_USAGE.id,
    reason: PRECHAIN_STORAGE_USAGE.forwardOnlyNoRollbackReason,
    reversalPath:
      'There is none by script. A single administrative `REVOKE USAGE ON SCHEMA storage FROM ' +
      'uellix_owner`, issued by the principal that applied this package, undoes it — and returns ' +
      'the two SECURITY DEFINER helpers to answering false for every caller, which is the ' +
      'outage stella_0005d was written to close locally.',
  },
  {
    // M-2, the third of the prechain trio. Separate from the first two for the
    // same reason they are separate from each other: a different object class,
    // and two pinned contracts that both say they do not do this.
    id: PRECHAIN_STORAGE_TABLE_READ.id,
    reason: PRECHAIN_STORAGE_TABLE_READ.forwardOnlyNoRollbackReason,
    reversalPath:
      'There is none by script. A single administrative `REVOKE SELECT ON TABLE ' +
      'public.organization_members FROM uellix_owner`, issued by the principal that applied this ' +
      'package, undoes it — and returns both SECURITY DEFINER helpers to answering false for ' +
      'every caller on read and on write, which is the outage measured on the certification ' +
      'shape before this package existed.',
  },
]

/** The ids, for a caller that only needs membership. */
export const FORWARD_ONLY_PACKAGE_IDS: readonly string[] = FORWARD_ONLY_PACKAGES.map((p) => p.id)

/** The declaration for one package, or `null` when it must ship a rollback. */
export function forwardOnlyPackage(id: string): ForwardOnlyPackage | null {
  return FORWARD_ONLY_PACKAGES.find((p) => p.id === id) ?? null
}
