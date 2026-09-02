'use client'
// components/stella/use-stella-operation.ts
// INTEGRATION — Train 4.3, FASE 10. The client seam that tells a NEW SUBMIT
// apart from a RETRY OF THE CURRENT OPERATION.
//
// ---------------------------------------------------------------------------
// WHY THE CLIENT HAS TO BE THE ONE THAT KNOWS
// ---------------------------------------------------------------------------
// The server cannot recover the distinction from the request. Identical
// arguments are a legitimate second run — a reviewer re-asking the advisor
// after editing an indicator wants a second answer and expects to pay for it.
// Elapsed time is not identity. A fresh uuid per invocation double-charges
// every retry. A digest of the content makes the second legitimate run free.
//
// So the operation identity is a TICKET, minted by the server before the work
// begins, and the only thing the client contributes is whether it presents the
// SAME one again or asks for a NEW one. That is a structural fact about which
// function ran, not a heuristic:
//
//     start()  ->  mint a ticket, then run    (a new operation, a new unit)
//     retry()  ->  present the ticket in hand (the same operation, zero units)
//
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES, AND WHY IT WAS WRONG
// ---------------------------------------------------------------------------
// Before this train every sibling panel wired its error notice's retry
// affordance to the SAME function its primary button called:
//
//     <StellaErrorNotice onRetry={handleAskStella} />
//
// With `db.insert`-based charging that was merely imprecise. With reservations
// it would be a defect: each press would mint a ticket, reserve a unit and
// charge it, so a reviewer clicking "Reintentar" three times against a
// flapping provider would spend three units on one question. The two
// affordances are now two functions, and `retry` cannot mint.
//
// ---------------------------------------------------------------------------
// A REF, NOT STATE
// ---------------------------------------------------------------------------
// `useRef` and not `useState` because the ticket is read INSIDE an async
// handler that started before the re-render. State read there would be a render
// behind — and a render behind means `retry` presenting the PREVIOUS
// operation's ticket, which is a settled ticket and would surface as
// `ALREADY_COMPLETED_RESULT_UNAVAILABLE` on a question the reviewer never got
// an answer to. Same reasoning `StellaGroundedQueryPanel` states for its own
// `currentTicket`.

import { useCallback, useRef } from 'react'
import type { StellaTicket, StellaTicketIssueResult } from './operation-ticket'

/**
 * What one press produced.
 *
 * `disabled` and `issue_error` come from the MINT and never reached the
 * operation; `ran` carries whatever the action returned, success or typed
 * failure, untouched. The hook maps nothing — each panel owns its own
 * presentation.
 */
export type StellaOperationAttempt<R> =
  | { readonly kind: 'ran'; readonly result: R }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'issue_error'; readonly code: string; readonly message: string }
  /**
   * `retry()` was called with no operation in hand. Cannot happen through the
   * UI — the retry affordance only renders inside an error notice, which only
   * renders after an attempt — and is reported rather than silently minting a
   * ticket, because silently minting is exactly the behaviour this hook exists
   * to remove.
   */
  | { readonly kind: 'no_operation' }

export interface StellaOperationHandle<R> {
  /** A NEW operation: mint a ticket, remember it, run under it. Charges a unit. */
  start: () => Promise<StellaOperationAttempt<R>>
  /** THE SAME operation: present the ticket already in hand. Charges nothing. */
  retry: () => Promise<StellaOperationAttempt<R>>
}

export function useStellaOperation<R>(
  issue: () => Promise<StellaTicketIssueResult>,
  run: (ticket: StellaTicket) => Promise<R>,
): StellaOperationHandle<R> {
  const currentTicket = useRef<StellaTicket | null>(null)

  const start = useCallback(async (): Promise<StellaOperationAttempt<R>> => {
    const issued = await issue()
    if (issued.status === 'disabled') return { kind: 'disabled' }
    if (issued.status === 'error') {
      return { kind: 'issue_error', code: issued.code, message: issued.message }
    }
    // Recorded BEFORE the run, not after. If the run never returns — a dropped
    // connection, a navigation, a closed laptop — `retry` must still find the
    // ticket that was reserved for this operation, or the retry becomes a
    // second charge for work the ledger may already hold.
    currentTicket.current = issued.ticket
    return { kind: 'ran', result: await run(issued.ticket) }
  }, [issue, run])

  const retry = useCallback(async (): Promise<StellaOperationAttempt<R>> => {
    const ticket = currentTicket.current
    if (ticket === null) return { kind: 'no_operation' }
    // No mint here. That single omission is the whole difference between the
    // two functions, and the reason they are two.
    return { kind: 'ran', result: await run(ticket) }
  }, [run])

  return { start, retry }
}
