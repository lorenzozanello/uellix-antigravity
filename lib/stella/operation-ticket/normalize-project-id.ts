// lib/stella/operation-ticket/normalize-project-id.ts
// G1-B PRECONDITIONS — ONE normalisation for the execution project, applied at
// BOTH ends of the governed protocol.
//
// ---------------------------------------------------------------------------
// THE DRIFT THIS CLOSES
// ---------------------------------------------------------------------------
// `issueGovernedStellaTicket` normalised its project id (a private
// `derivedProject` that trimmed and rejected the empty form).
// `runGovernedStellaOperation` did not: it hashed and bound whatever string the
// action handed it.
//
// So `" <uuid> "` was ISSUABLE — the ticket is welded to the trimmed id — and
// then UNEXECUTABLE, because `isProjectId` in db/stella/operation-tickets.ts
// rejects the padded form and the request digest is computed over the padded
// string. The reviewer sees a ticket minted successfully and then "esta
// operación ya no es válida".
//
// The posture was FAIL-CLOSED, which is why this was a P1 and not a P0. It is
// still worth closing: "eligible in one layer, rejected in the next" is the
// shape that becomes a tenancy bug on the day either layer is made more
// permissive, and the two layers here had no shared definition to keep them
// honest.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
// It is NOT an authorization check and NOT a UUID validator. It answers one
// question — "what is the canonical form of this identifier, if it has one?" —
// and nothing else. Whether the project exists, belongs to the session's
// organization, and may be executed against is re-imposed inside
// `issue_operation_ticket` and every ticket verb, in SQL, against the
// organization derived from the session. That is the only copy no request can
// influence, and this function must never look like a substitute for it.

/**
 * The canonical form of an execution project id, or `null` when the input
 * carries no identifier at all.
 *
 * `null` rather than `''` deliberately: an empty string is a VALUE that a later
 * layer can carry, compare, and find equal to another empty string. `null`
 * forces the caller to branch, which is what both call sites do.
 */
export function normalizeStellaProjectId(value: string): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
