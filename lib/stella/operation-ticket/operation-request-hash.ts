// lib/stella/operation-ticket/operation-request-hash.ts
// INTEGRATION — Train 4.3, FASE 6. The digest a sibling Stella ticket is BOUND
// to, and the reason it is not the operation's identity.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, IN ONE SENTENCE
// ---------------------------------------------------------------------------
// It stops ONE ticket from being reused for a DIFFERENT request. Nothing else.
//
// `bind_operation_ticket` writes this digest onto the ticket once and refuses a
// second, different one with `U0107`; `complete_operation_ticket` re-checks it
// before charging. So a ticket minted for "advise me on step Indicators" cannot
// be presented later for "draft the executive summary" and settle as though it
// were the same operation.
//
// ---------------------------------------------------------------------------
// IT IS NOT THE IDENTITY, AND THAT IS THE WHOLE POINT OF INT-INT-001
// ---------------------------------------------------------------------------
// The identity a unit is charged under is
//
//     sha256('stella/ticket/charge/v1' || LF || ticket_id || LF || charge_nonce)
//
// derived INSIDE the completion verb from a nonce no function returns. This
// module cannot compute it and must not try. Reading a content digest as an
// identity is the specific defect INT-INT-001 §1 names: it would make a
// reviewer's second, legitimate, identical request free, and it would make two
// different requests that happen to canonicalize alike collide into one charge.
//
//   RETRY of one operation  ->  same ticket, same digest   (charge once)
//   NEW operation           ->  NEW ticket, same digest    (charge again)
//
// The second line is the one a content hash cannot express, and the reason the
// ticket exists at all.
//
// ---------------------------------------------------------------------------
// WHAT GOES INTO THE DIGEST — AND WHAT MUST NOT
// ---------------------------------------------------------------------------
// The REQUEST DESCRIPTOR: the category, the execution project, and the
// functional arguments the caller named (a pipeline step, a report and section,
// a reviewer role). All of them are known BEFORE any row is read.
//
// The built CONTEXT is deliberately absent, and the omission is load-bearing.
// `lib/stella/context/build-context-hash.ts` fingerprints the assembled project
// context, which is a function of live project data — so a retry issued thirty
// seconds after an indicator was edited would produce a DIFFERENT digest and be
// refused as `U0107` on the ticket it legitimately holds. The digest has to be
// stable over exactly the window a retry can span, and only the request is.
//
// The context fingerprint is not lost: it is recorded in the metadata-only
// `audit_logs` entry each action already writes. What changes is where it
// lives, and that change is declared in docs/ops/contracts/CONTRACT_LEDGER.md
// rather than absorbed silently — `stella_interactions.context_hash` now holds
// the REQUEST digest, because prepared stella_0017 files the digest the ticket
// was bound to and nothing the caller supplies can move it.

import { createHash } from 'node:crypto'
import { canonicalizeQuery } from './canonical-query-hash'
import type { StellaTicketCategory } from './categories'

/**
 * The version namespace.
 *
 * Distinct from `stella/query/v1` (the grounded-query text digest) and from
 * `stella/ticket/charge/v1` (the charge key derived in SQL). Three namespaces,
 * three preimage spaces: a request digest can never be presented as a query
 * digest or as a charge key, whatever an attacker controls on either side.
 */
export const OPERATION_REQUEST_NAMESPACE = 'stella/operation/v1'

/** U+000A as an escape, never a literal — see canonical-query-hash.ts. */
const LF = '\n'

/**
 * One functional argument of the operation, canonicalized.
 *
 * `canonicalizeQuery` is reused rather than reimplemented: it NFC-normalizes,
 * trims and collapses every whitespace run to a single U+0020. The consequence
 * that matters here is that NO canonicalized part can contain a line feed — so
 * joining the parts with LF below is unambiguous and no part can be crafted to
 * impersonate a part boundary. A separate escaping scheme would be a second
 * place for that property to be got wrong.
 *
 * `null` and `undefined` are represented by the empty string rather than by the
 * text "null": an argument that is absent and an argument whose value is the
 * four characters n-u-l-l must not collide.
 */
function canonicalPart(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : canonicalizeQuery(value)
}

/**
 * The descriptor of ONE sibling Stella operation, as the server derived it.
 *
 * `projectId` is the execution project — the same server-derived value the
 * ticket verbs compare against — and it is IN the digest so that a ticket bound
 * under one project cannot be re-bound under another even in a hypothetical
 * database where the project comparison had been removed. Defence in depth, not
 * the primary control: `U0110` is.
 */
export interface StellaOperationRequest {
  readonly category: StellaTicketCategory
  readonly projectId: string
  /**
   * The functional arguments, in a FIXED order chosen by the action and never
   * by the caller. Order is part of the digest: ['a','b'] and ['b','a'] are
   * different requests, which is correct for a positional argument list.
   */
  readonly parts: readonly (string | null | undefined)[]
}

/**
 * `operation_request_hash` — 64 lowercase hex, the shape every ticket verb
 * enforces with `~ '^[0-9a-f]{64}$'`.
 *
 * Taken over BYTES (`Buffer.from(..., 'utf8')`), not over a JavaScript string,
 * so an astral-plane character in a section title cannot hash differently
 * depending on how an engine counts characters.
 */
export function operationRequestHash(request: StellaOperationRequest): string {
  const canonical = [
    OPERATION_REQUEST_NAMESPACE,
    request.category,
    canonicalPart(request.projectId),
    ...request.parts.map(canonicalPart),
  ].join(LF)

  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
}
