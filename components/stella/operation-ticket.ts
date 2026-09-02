// components/stella/operation-ticket.ts
// INTEGRATION — Train 4.3, FASE 7/10. The client-visible half of the operation
// ticket, for the five SIBLING Stella panels.
//
// Presentation-layer types only: no `db/**`, no `node:crypto`, no server
// import. `components/stella/grounded-query.ts` states the same shapes for the
// grounded panel and states them FIRST — this module deliberately does not
// re-derive the reasoning, it points at it.
//
// ---------------------------------------------------------------------------
// WHY A SECOND MODULE INSTEAD OF IMPORTING THE GROUNDED ONE
// ---------------------------------------------------------------------------
// `grounded-query.ts` is the contract surface of PRODUCT-002 — it also declares
// `StellaGroundedQueryRequest`, `StellaGroundedQueryResult` and the runner prop
// type, none of which the advisor, validator, composer or reviewer panels have
// any business seeing. Importing it for two type aliases would put a grounded
// answer model in the import graph of five panels that never render one.
//
// The two definitions are kept in agreement by machine rather than by
// discipline: `tests/cross-workstream/governed-consumption.test.ts` asserts the
// ticket alias and the issue-result union are structurally identical on both
// sides.

import type { StellaPanelErrorCode } from './error-messages'

/**
 * An opaque, server-issued operation ticket. 64 lowercase hex characters and
 * nothing else — see `components/stella/grounded-query.ts` for why the client
 * may hold it, why it is never trusted, and why it is not a uuid.
 */
export type StellaTicket = string

/**
 * What a ticket-minting server surface returns.
 *
 * `disabled` is a first-class member rather than an error because a false
 * feature flag must cost zero authentication, zero database work, zero ticket
 * and zero telemetry. It is distinct from an error, which means the flag was ON
 * and the mint genuinely failed.
 */
export type StellaTicketIssueResult =
  | { readonly status: 'issued'; readonly ticket: StellaTicket }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly code: StellaPanelErrorCode; readonly message: string }
