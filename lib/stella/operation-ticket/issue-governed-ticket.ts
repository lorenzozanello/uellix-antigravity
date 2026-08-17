// lib/stella/operation-ticket/issue-governed-ticket.ts
// INTEGRATION — Train 4.3, FASE 7. ONE issuance path for the five sibling
// Stella actions.
//
// ---------------------------------------------------------------------------
// WHAT THE CLIENT CANNOT SEND
// ---------------------------------------------------------------------------
//   organization  <- `requireOrganizationAccess()`, the session
//   project       <- the SERVER-BOUND argument of the calling action
//   actor         <- `auth.uid()`, inside the SQL function — no parameter
//   category      <- a module constant of the CALLING SURFACE, or, for the one
//                    action that legitimately has three, a value already
//                    narrowed by `resolveIssuableCategory` against the set of
//                    roles whose feature flag is on
//   TTL           <- prepared stella_0014, bounded to 15 minutes by a CHECK
//   nonce         <- prepared stella_0014, and never returned by any function
//   identity      <- derived in SQL from that nonce
//
// This function takes `category` as a PARAMETER, which is the one thing that
// changed from the grounded issuer. That parameter is what makes it shareable,
// and it is also the thing an adversarial review will point at — so state the
// property precisely: a parameter is safe when every ARGUMENT is a server
// value. There are exactly six call sites, five pass a module constant, and the
// sixth passes the output of `resolveIssuableCategory`. A test pins that no
// call site passes anything read out of a request.
//
// ---------------------------------------------------------------------------
// THE ORDER, AND WHAT `disabled` COSTS
// ---------------------------------------------------------------------------
// The FLAG is checked by the CALLER, before this function is reached, because
// the flags are per-category (`isAdvisorEnabled`, `isProxyReviewerEnabled`, …)
// and this module must not learn six of them. With the flag false the calling
// action returns `{ status: 'disabled' }` at its first line: zero
// authentication, zero database work, zero ticket, zero observability.
//
// Everything after that is here, in order:
//
//   1 auth -> 2 organization -> 3 project -> 4 permission -> 5 rate limit ->
//   6 issue
//
// ---------------------------------------------------------------------------
// WHY THE RATE LIMIT IS HERE AND NOT AT EXECUTION
// ---------------------------------------------------------------------------
// It moved for the same two reasons it moved for the grounded query in Train
// 4.1, and both are improvements rather than side effects:
//
//   * MINTING IS BOUNDED. Issuance reserves nothing, so it is not
//     self-limiting: without this, an authenticated member could mint unbounded
//     rows into `operation_tickets`, which nothing reclaims.
//   * A RETRY NO LONGER SPENDS THE LIMIT. It is the same operation, already
//     counted when its ticket was minted. Charging the hourly budget again for
//     re-delivering one answer would penalise exactly the callers the protocol
//     exists to protect.
//
// This is a narrowing of what the limit is spent on, never a removal: every
// path into a governed operation requires a ticket, and every ticket was
// rate-limited when it was issued.

import { randomUUID } from 'node:crypto'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { normalizeStellaProjectId } from './normalize-project-id'
import { issueOperationTicket } from '@/db/stella/operation-tickets'
import { emitTicketEvent } from './ticket-observability'
import type { StellaInteractionCategory } from './categories'
import type { StellaTicketIssueResult } from '@/components/stella/operation-ticket'

// G1-B PRECONDITIONS: the private `derivedProject` that used to live here is
// gone. It trimmed, and `runGovernedStellaOperation` did not, so one padded
// project id was issuable and then unexecutable. Both ends now call
// `normalizeStellaProjectId` — see lib/stella/operation-ticket/normalize-project-id.ts
// for why a shared definition is the fix rather than a second copy of the trim.

/**
 * Mint one operation ticket for one sibling Stella operation.
 *
 * Returns 64 hex characters and nothing else — not the nonce, not the stored
 * digest, not an internal id, not a scope. The opaque identifier needed to
 * continue, and no more.
 */
export async function issueGovernedStellaTicket(
  projectId: string,
  category: StellaInteractionCategory,
): Promise<StellaTicketIssueResult> {
  // 1. AUTHENTICATE. (The flag was checked by the caller — see the header.)
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { status: 'error', code: 'UNAUTHORIZED', message: 'Se requiere autenticación.' }
  }

  // 2/3. SCOPE — derived, never received.
  const organizationId = ctx.organization.id
  const boundProjectId = normalizeStellaProjectId(projectId)
  if (boundProjectId === null) {
    return {
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'El proyecto solicitado no es válido para esta sesión.',
    }
  }

  // 4. PERMISSION — set inclusion, the same gate every Stella action uses, and
  //    the last check that costs no I/O.
  if (!canUseStella(ctx.membership.role)) {
    return {
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'Tu rol no tiene permiso para usar Stella.',
    }
  }

  // 5. RATE LIMIT — per hour, per organization. See the header.
  const rate = await consumeStellaRateLimit(organizationId).catch(() => null)
  if (rate === null) {
    return {
      status: 'error',
      code: 'RATE_LIMIT_UNAVAILABLE',
      message: 'No se pudo verificar el límite de uso de Stella.',
    }
  }
  if (!rate.allowed) {
    return {
      status: 'error',
      code: 'RATE_LIMITED',
      message: 'Alcanzaste el límite de consultas por hora. Intentá de nuevo más tarde.',
    }
  }

  // 6. ISSUE. The project is re-verified against the organization INSIDE the
  //    SQL function, so no read is duplicated here to do it again in a weaker
  //    place.
  const issued = await issueOperationTicket(organizationId, boundProjectId, category)
  if (issued.kind === 'rejected') {
    if (issued.reason === 'out_of_scope') {
      return {
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'El proyecto solicitado no es válido para esta sesión.',
      }
    }
    return { status: 'error', code: 'UNKNOWN_ERROR', message: 'No se pudo iniciar la operación.' }
  }

  emitTicketEvent(
    'operation_ticket_issued',
    { organizationId, projectId: boundProjectId, requestId: randomUUID() },
    { ticketId: issued.ticketId },
  )

  return { status: 'issued', ticket: issued.ticketId }
}
