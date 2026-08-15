// db/hosted/authority/forward-boundaries.ts
// M-8 — classification windows for packages that came AFTER the recovered
// partition, declared as what they are.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE FILE
// ---------------------------------------------------------------------------
// `recovered-boundaries.ts` opens by stating what its 51 entries ARE:
//
//   "These boundaries come from the original A_FINAL stateful partition …
//    transferred verbatim by the operator. They were NOT inferred here, and an
//    earlier attempt to re-derive them from the published counts was abandoned
//    on purpose."
//
// That is a provenance claim, and it is the load-bearing one in this whole
// subsystem: it is why the counts (26/15/10, 167/99/27, 320) can CHECK the
// plan instead of merely restating it. `grounding_0005` has no such provenance
// — it did not exist when the partition was taken, and there is no historical
// table to transfer. Its windows are AUTHORED.
//
// Appending them to RECOVERED_WINDOWS would have been one line and would have
// destroyed exactly that property: the file would then hold two kinds of thing
// under one name, RECOVERED_TOTALS would have to be edited to match new code,
// and every future reader would have to take on trust which entries were
// evidence and which were design. So the two live apart, they carry different
// `authoritySource` markers, and a test asserts that the recovered set is
// still 51 and still says ORIGINAL_STATEFUL_PARTITION.
//
// ---------------------------------------------------------------------------
// WHAT IS STILL CHECKED, AND WHAT CANNOT BE
// ---------------------------------------------------------------------------
// Everything structural: each anchor must resolve to EXACTLY one statement in
// the package (zero and many are separate refusals), the windows must not
// overlap, the declared count must equal the measured count, no installer-only
// class may sit inside an elevated window, and the executor is re-derived from
// the ownership simulation rather than taken from this file.
//
// What cannot be checked is the thing a recovered window gets for free: whether
// the BOUNDARY IS THE RIGHT ONE. For T1..T9 the answer came from history. Here
// it comes from a decision, stated below, that a reviewer has to read. Saying
// so is the point — `declaredAs` is not decoration, it is the part of this file
// that no digest can verify.

import {
  CHAIN_ROUTINE_SIGNATURES as FN,
  commentOn,
  createFn,
  type RecoveredWindow,
} from './recovered-boundaries'

const GROUNDING_SCHEMA = 'uellix_grounding'

/**
 * A window nobody recovered.
 *
 * Structurally identical to `RecoveredWindow` — the planner resolves both the
 * same way, which is the point: an authored window gets NO weaker treatment.
 * The difference is the provenance marker the plan stamps on it and the
 * `declaredAs` prose, which states the reasoning a recovered window does not
 * have to because history supplied it.
 */
export interface ForwardWindow extends RecoveredWindow {
  /** Why THIS boundary, in a form a reviewer can disagree with. */
  readonly declaredAs: string
}

export const FORWARD_WINDOWS: readonly ForwardWindow[] = [
  {
    windowId: 'W52',
    packageId: 'T10',
    authorityClass: 'CAPABILITY',
    historicalCount: 1,
    describedAs:
      'CREATE OR REPLACE FUNCTION claim_active_document_version(uuid) — already owned by uellix_cap_grounding; needs temporary schema CREATE',
    declaredAs:
      'ONE STATEMENT, and the narrowness is the decision. `CREATE OR REPLACE` over a routine the ' +
      'capability role already owns requires becoming that role AND holding CREATE on the ' +
      'containing schema — measured, and the same shape T8/W44 and T9/W49 already carry for ' +
      'settle_reserved_quota(5) and bind_operation_ticket(3). The COMMENT that follows also ' +
      'requires ownership, so a single window spanning both would have segmented identically and ' +
      'emitted one lifecycle instead of two. It is deliberately NOT written that way: the ' +
      'segmenter grants CREATE to the whole segment whenever any member creates something, so ' +
      'merging them would hold CREATE on uellix_grounding for a statement that only writes a ' +
      'comment. Two windows cost one extra open/close and keep the temporary CREATE grant scoped ' +
      'to the single statement that cannot proceed without it.',
    start: createFn(FN.claim),
    end: createFn(FN.claim),
  },
  {
    windowId: 'W53',
    packageId: 'T10',
    authorityClass: 'CAPABILITY',
    historicalCount: 1,
    describedAs: 'COMMENT ON FUNCTION claim_active_document_version(uuid)',
    declaredAs:
      'CAPABILITY and not OWNER, because COMMENT ON requires OWNERSHIP of the object and ' +
      'uellix_cap_grounding owns this function — uellix_owner does not, and running it as the ' +
      'owner would fail. It needs no schema CREATE, and the segmenter derives that on its own: ' +
      'the window contains no create-* class, so requiredTemporarySchemaCreate resolves to null. ' +
      'The comment is in the package at all because grounding_0002 left one asserting that this ' +
      'function "takes the same evidence-row lock the registrar takes" — false since the train-2 ' +
      'repair, and half of why M-8 survived review: the catalog told every reader the two ' +
      'functions agreed.',
    start: commentOn(FN.claim),
    end: commentOn(FN.claim),
  },
  {
    windowId: 'W54',
    packageId: 'T11',
    authorityClass: 'OWNER',
    historicalCount: 1,
    describedAs:
      'CREATE OR REPLACE FUNCTION public.can_write_evidence_object(text, uuid) — already owned by uellix_owner; no temporary schema CREATE',
    declaredAs:
      'OWNER and not CAPABILITY, which is the whole difference between this window and W52. ' +
      'can_write_evidence_object is a BASELINE object — unit 41 publishes it, stella_0004 (local) ' +
      'and stella_hosted_0001 (managed) transfer it to uellix_owner — so no capability role is ' +
      'involved and `CREATE OR REPLACE` needs exactly one thing: to be executed BY the owner. ' +
      'MEASURED on PG 17.6 against a restored baseline: as uellix_migrator without the owner ' +
      'window the statement fails with `permission denied for schema public`, and inside it the ' +
      'statement succeeds with owner, ACL, SECURITY DEFINER, search_path and argument names all ' +
      'preserved. ' +
      'It opens NO temporary schema CREATE, and that is derived rather than asserted: ' +
      'requiredTemporarySchemaCreate is non-null only for a transfer or for a CAPABILITY window ' +
      'that creates, and this is neither — uellix_owner already holds CREATE on public ' +
      'permanently, which is the same fact assert_hosted_capabilities (C4) checks before any ' +
      'chain package runs. FORWARD_TEMPORARY_CREATE_SCHEMAS is therefore unchanged, and that is ' +
      'the tripwire working rather than being edited around. ' +
      'ONE STATEMENT, like W52: the package publishes exactly one CREATE OR REPLACE and issues no ' +
      'COMMENT, so there is no second owner-requiring statement to span. Its §0 and §2 are DO ' +
      'blocks, which run as the installer and are outside every window by construction.',
    start: createFn(FN.canWriteEvidenceObject),
    end: createFn(FN.canWriteEvidenceObject),
  },
]

/**
 * The chain packages whose windows are AUTHORED, derived from the list above.
 *
 * Derived rather than transcribed: a second list of ids is a second thing to
 * forget, and the arithmetic that keeps RECOVERED_TOTALS meaningful depends on
 * knowing exactly which packages to leave out of it.
 */
export const FORWARD_PACKAGE_IDS: readonly string[] = [
  ...new Set(FORWARD_WINDOWS.map((w) => w.packageId)),
]

/**
 * The declared totals for the AUTHORED windows, kept separate from
 * RECOVERED_TOTALS so neither can be edited to make the other add up.
 */
export const FORWARD_TOTALS = {
  owner: 1,
  capability: 2,
  transfer: 0,
  ownerStatements: 1,
  capabilityStatements: 2,
  transferStatements: 0,
} as const

/**
 * The one schema an authored capability window may open CREATE on.
 *
 * Stated as a value so a test can assert it rather than read it out of prose:
 * a forward package that needed CREATE on a SECOND schema would be doing
 * something this design has not reviewed, and the assertion is where that gets
 * noticed instead of being emitted.
 */
export const FORWARD_TEMPORARY_CREATE_SCHEMAS: readonly string[] = [GROUNDING_SCHEMA]
