// db/hosted/prechain-ownership.ts
// M-2 — the identity and pin of the forward-only prechain OWNERSHIP
// reconciliation.
//
// ---------------------------------------------------------------------------
// WHY A SECOND PRECHAIN PACKAGE AND NOT AN EDIT TO THE FIRST
// ---------------------------------------------------------------------------
// `stella_hosted_0002_prechain_authority_reconciliation` is the obvious place
// to put "one more thing the installer cannot do for itself", and it is the
// wrong one, for two independent reasons that are both matters of record:
//
//   IT IS INSTALLED. artifacts/hosted-remediation-attempts.jsonl carries a
//   CONSUMED line for it against project bvyzblhqymxruxdguaee, and
//   docs/ops/staging/evidence records the post-apply witness reading INSTALLED.
//   Editing its bytes would make the installed artefact and the repository
//   disagree about what ran — the same rule that keeps baseline unit 41 and
//   grounding_0002 frozen.
//
//   ITS CONTRACT SAYS OTHERWISE. Its own pinned `purpose` ends "It creates no
//   capability role and transfers no ownership." Widening that sentence to
//   accommodate a transfer would retire the only description of the package a
//   reviewer can check it against.
//
// So this is a NEW forward-only package, which is exactly what that registry
// prescribes for a correction: "INSTALLED is never re-applied, and a correction
// is a NEW forward-only package."
//
// ---------------------------------------------------------------------------
// WHY IT REUSES THE SHAPE INSTEAD OF INVENTING A MECHANISM
// ---------------------------------------------------------------------------
// The prechain KIND is reusable and is reused verbatim: a governed SQL file,
// pinned by digest, forward-only, applied before HOSTED_CHAIN by a principal
// the chain installer is not. What is deliberately NOT reused is the ATTEMPT
// LEDGER of `remediation-attempt.ts`. That protocol exists because
// stella_hosted_0002 is a one-shot authority reconciliation with an ambiguous
// outcome — it can leave a project in a state only a fresh observation can
// classify, so it must never be blindly retried.
//
// `ALTER FUNCTION … OWNER TO` has no such outcome. It is idempotent, it is
// convergent, and re-running it against a pair that already moved is a no-op
// whose ACL is byte-identical afterwards — MEASURED on PG 17.6. A package that
// cannot be harmed by retrying does not need a mechanism whose whole purpose is
// to prevent retrying, and attaching one would be ceremony that a later reader
// would reasonably mistake for a real hazard.
//
// ---------------------------------------------------------------------------
// WHY IT IS NOT IN HOSTED_CHAIN
// ---------------------------------------------------------------------------
// Two reasons, and the second is the one that matters most.
//
//   IT IS A PREREQUISITE, NOT A LINK. The same argument prechain-remediation.ts
//   makes: a chain member acquires witnesses, appears in `nextChainPackage`,
//   and becomes something an operator can be told to apply "next".
//
//   IT IS APPLIED BY A DIFFERENT PRINCIPAL. Every link of HOSTED_CHAIN is
//   applied by `uellix_migrator`. This one cannot be — that is its entire
//   reason for existing. Counting it as a chain member would make the chain's
//   installed count a number no single identity can produce, and would quietly
//   assert that the governed installer had done something it is specifically
//   unable to do.

import { createHash } from 'node:crypto'

/** Deliberately distinct from `PreparedPackageKind` in prechain-remediation.ts. */
export type PrechainOwnershipKind = 'prechain-ownership'

export interface PrechainOwnershipPackage {
  readonly id: string
  readonly kind: PrechainOwnershipKind
  /** Repo-relative, POSIX. The file an operator applies, unmodified. */
  readonly sourceFile: string
  /** SHA-256 of the LF-normalized SQL. A byte change fails the gate. */
  readonly sourceSha256: string
  readonly purpose: string
  /** Why no `_rollback.sql` exists. Read by the registry tripwire. */
  readonly forwardOnlyNoRollbackReason: string
  /**
   * The functions it normalises, by exact signature.
   *
   * Stated as data so the certification harness and the tests can assert the
   * catalog against the SAME list the SQL names, rather than against a second
   * transcription of it.
   */
  readonly normalisedFunctions: readonly string[]
  /** The role every entry above must be owned by afterwards. */
  readonly destinationOwner: string
  /** Which chain package is unblocked by it, and where it refuses without it. */
  readonly unblocks: string
}

export const PRECHAIN_OWNERSHIP: PrechainOwnershipPackage = {
  id: 'stella_hosted_0003_storage_helper_ownership',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0003_storage_helper_ownership.sql',
  sourceSha256: '390c4fb9a4325f8ac6f4aed3dcfa8f63342d71fbfc7f5d50356c00280b49be60',
  purpose:
    'Transfers ownership of the two Storage helper functions from the role that created them on a ' +
    'managed project — postgres, because the fifty baseline units carry ownershipStatements = 0 and ' +
    'are applied as postgres — to uellix_owner, which is the posture stella_0004 produces locally ' +
    'and the one the governed chain is written against. It changes no function body, issues no ' +
    'GRANT or REVOKE, recreates no policy, creates no role and alters no membership. It also does ' +
    'NOT grant uellix_owner USAGE on schema storage: that is stella_0005d\'s question locally and ' +
    'remains open on the hosted side, and the package asserts the state rather than answering it.',
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY, in the same shape grounding_0005 records. What it removes is the reason a ' +
    'governed package cannot be applied, so "restore the previous owner" and "make the chain ' +
    'uninstallable again" are the same sentence: stella_0019 would refuse once more, in the same ' +
    'guard, and a project that had already installed stella_0019 would be left holding a four-role ' +
    'body owned by postgres — a state neither package produces and nothing measures. A rollback ' +
    'script here would be one whose only effect is to reopen M-2, and whose correctness after ' +
    'stella_0019 had run nobody has measured. Deliberate reversal, if it were ever wanted, is a ' +
    'single administrative ALTER FUNCTION taken by the same principal that applied this, with the ' +
    'consequences visible at the time rather than encoded in advance.',
  normalisedFunctions: [
    'public.can_read_evidence_object(text,uuid)',
    'public.can_write_evidence_object(text,uuid)',
  ],
  destinationOwner: 'uellix_owner',
  unblocks:
    'stella_0019_storage_write_roles (T11), which republishes can_write_evidence_object through ' +
    'uellix_migrator -> SET ROLE uellix_owner and refuses in its §0.6 against a postgres-owned ' +
    'function. Measured: with this package applied first, the governed CREATE OR REPLACE succeeds ' +
    'as uellix_migrator with rolsuper = false and no administrative privilege of any kind.',
}

/**
 * The storage-schema USAGE grant the owner needs once it owns the helpers.
 *
 * A SEPARATE package from the ownership transfer, for the same reason
 * stella_0005d is separate from stella_0004 locally: it grants on a schema the
 * PLATFORM owns, it answers a different question, and PRECHAIN_OWNERSHIP
 * states in its own contract that it grants nothing.
 *
 * MEASURED: with the ownership transfer applied and this absent, stella_0019
 * still refuses — at its §0.7 instead of its §0.6 — because the definer bodies
 * call storage.foldername() and would answer false for every caller.
 */
export const PRECHAIN_STORAGE_USAGE: PrechainOwnershipPackage = {
  id: 'stella_hosted_0004_storage_schema_usage',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0004_storage_schema_usage.sql',
  sourceSha256: '00071f423801df29771bd284e33e34c1c3d731d96efbd90136f57feebedb552a',
  purpose:
    'Grants uellix_owner USAGE on schema storage — one privilege, one schema — so that the '  +
    'SECURITY DEFINER bodies of the two Storage helpers can resolve storage.foldername(name) '  +
    'once uellix_owner owns them. Without it the qualified reference raises inside the definer, '  +
    'the bodies own EXCEPTION WHEN OTHERS swallows it, and every evidence object operation is '  +
    'refused silently for every role. It is the hosted counterpart of stella_0005d and asserts '  +
    'the same three facts: the USAGE is present, storage.foldername is executable, and NO table '  +
    'privilege in storage was granted. uellix_app is compared before and after and must not move.',
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY. Revoking it re-opens the exact failure it closes — every evidence object '  +
    'operation refused, silently, for every role — on a project whose helpers uellix_owner now '  +
    'owns, so "restore the previous state" and "return the Storage surface to denying everyone '  +
    'without saying so" are the same sentence. It is also the half of the pair that cannot be '  +
    'undone independently: with ownership already moved, removing the USAGE leaves a posture '  +
    'neither the local model nor the hosted one produces. Deliberate reversal is a single '  +
    'administrative REVOKE by the same principal, with the consequence visible at the time.',
  normalisedFunctions: [],
  destinationOwner: 'uellix_owner',
  unblocks:
    'stella_0019_storage_write_roles (T11) at its §0.7 guard, which refuses to correct a role '  +
    'list over a surface that already denies everyone. Measured: with PRECHAIN_OWNERSHIP applied '  +
    'and this absent, the chain reaches 10/11 and T11 names this exact privilege.',
}

/**
 * Both prechain administrative units, IN APPLICATION ORDER.
 *
 * Order is load-bearing and asserted by stella_hosted_0004 §0.4: the USAGE
 * grant refuses unless a SECURITY DEFINER helper is already owned by
 * uellix_owner, so applying it first is a refusal rather than a silent
 * reordering.
 */
export const PRECHAIN_ADMINISTRATIVE_UNITS: readonly PrechainOwnershipPackage[] = [
  PRECHAIN_OWNERSHIP,
  PRECHAIN_STORAGE_USAGE,
]

export function sha256OfPreparedSql(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
}
