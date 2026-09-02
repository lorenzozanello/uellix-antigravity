// lib/stella/operation-ticket/categories.ts
// INTEGRATION — Train 4.3, FASE 6/7. The governed operation vocabulary, as ONE
// list with ONE reader per boundary.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A MODULE AND NOT SIX STRING LITERALS
// ---------------------------------------------------------------------------
// Before Train 4.3 the five sibling actions each wrote their own `stellaRole`
// straight into a `db.insert`, so "which capability charged this unit?" was a
// literal typed six times in six files. Two of them (`reviewer.ts`) took the
// value from a PARAMETER, which is how a client got to name the row it was
// about to be billed for.
//
// The category is now welded onto the ticket at ISSUE, inside SQL, and read
// back out of the ticket row by `complete_operation_ticket` — no completion
// argument can move it. What remains for TypeScript is the half SQL cannot do:
// making sure the SERVER, not the caller, decides which category is issued in
// the first place. That is what `resolveIssuableCategory` is for, and why it
// takes an ALLOWED SET rather than trusting whatever arrived.
//
// ---------------------------------------------------------------------------
// SEVEN CATEGORIES, TWO POPULATIONS
// ---------------------------------------------------------------------------
// `operation_tickets_category_check` (prepared stella_0014 §3) admits seven.
// They split by which completion verb settles them:
//
//   grounded_query  ->  complete_operation_ticket(ticket, project, hash)
//                       — 3 arguments, charges through consume_stella_quota,
//                         files no interaction payload of its own.
//
//   the other six   ->  complete_operation_ticket(ticket, project, hash,
//                         pipeline_step, model_used, tokens_used, response_json)
//                       — 7 arguments, prepared stella_0017, files the
//                         `stella_interactions` row the five sibling actions
//                         used to write with `db.insert`.
//
// The split is not cosmetic: the 3-argument verb has no place to put a model
// response, and the 7-argument one would file a NULL-shaped row for a grounded
// query that has no `stella_interactions` representation. Keeping the two
// populations named here means a future category has to declare which side it
// is on rather than defaulting into one.

/**
 * The six capabilities that file a `stella_interactions` row — the five sibling
 * server actions' governed categories.
 *
 * BYTE-IDENTICAL to `v_governed` in `uellix_stella.settle_reserved_quota`
 * (prepared stella_0017 §3) and to `stella_interactions_stella_role_check` in
 * `db/schema.ts`. `tests/cross-workstream/governed-consumption.test.ts` asserts
 * the three agree; a seventh name added here without adding it there is a
 * `U0106` at runtime, which is fail-closed but silent until someone tries it.
 */
export const STELLA_INTERACTION_CATEGORIES = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
] as const

export type StellaInteractionCategory = (typeof STELLA_INTERACTION_CATEGORIES)[number]

/**
 * The three reviewer categories one parameterized action can act as.
 *
 * This is the ONLY place in the product where a single server action may issue
 * more than one category, and it is therefore the only place FASE 7's "valida
 * un enum server-side" has anything to validate. The other four actions name
 * their category as a module constant and take no category argument at all —
 * which is a stronger property than validating one, because there is nothing to
 * validate.
 */
export const STELLA_REVIEWER_CATEGORIES = [
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
] as const

export type StellaReviewerCategory = (typeof STELLA_REVIEWER_CATEGORIES)[number]

/** The grounded-query category. Settled by the 3-argument completion verb. */
export const GROUNDED_QUERY_CATEGORY = 'grounded_query' as const

/**
 * Every category `operation_tickets_category_check` admits, in the package's own
 * order. Used by the adapter to refuse an unknown category in Node rather than
 * sending it to be classified as `U0106`.
 */
export const STELLA_TICKET_CATEGORIES = [
  ...STELLA_INTERACTION_CATEGORIES,
  GROUNDED_QUERY_CATEGORY,
] as const

export type StellaTicketCategory = (typeof STELLA_TICKET_CATEGORIES)[number]

export function isStellaTicketCategory(value: unknown): value is StellaTicketCategory {
  return typeof value === 'string' && (STELLA_TICKET_CATEGORIES as readonly string[]).includes(value)
}

export function isStellaInteractionCategory(value: unknown): value is StellaInteractionCategory {
  return (
    typeof value === 'string' && (STELLA_INTERACTION_CATEGORIES as readonly string[]).includes(value)
  )
}

/**
 * Narrow an INBOUND value to a category the caller is allowed to issue.
 *
 * FASE 7, and the signature is the requirement: `allowed` is supplied by the
 * SERVER wrapper — for the reviewer action it is the set of reviewer roles whose
 * feature flag is on, so a category is not merely "in the vocabulary" but
 * "authorized in this deployment right now". A string from the client that is
 * spelled correctly but belongs to a disabled role gets `null`, exactly as an
 * invented one does.
 *
 * Returns `null` rather than throwing: the callers are server actions whose
 * contract is a typed result, and an exception here would surface as
 * `UNKNOWN_ERROR` where `UNAUTHORIZED` is the truthful code.
 */
export function resolveIssuableCategory<T extends StellaTicketCategory>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== 'string') return null
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}
