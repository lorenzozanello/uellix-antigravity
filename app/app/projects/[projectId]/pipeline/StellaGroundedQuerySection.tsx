// app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection.tsx
// INTEGRATION (Stella parallel train 3) — the typed server/client wrapper for
// PRODUCT-002.
//
// NOT A ROUTE. It sits inside the pipeline segment because that is where the
// mount will happen, but Next.js only routes `page.tsx` / `route.ts`; this is
// an ordinary server component colocated with its future call site.
//
// WHY IT EXISTS SEPARATELY FROM THE PANEL
//
// `StellaGroundedQueryPanel` is a client component and must stay one: it owns
// the request lifecycle, the loading state and the human decision. It cannot
// read `stellaConfig` (server-only) and it cannot construct a runner (that
// would put `db/**` and `node:crypto` in the browser bundle). This wrapper is
// the server half: it asks the capability table, binds the project, and hands
// the client exactly one prop it could not have made itself.
//
// `runStellaGroundedQueryForProject.bind(null, projectId)` is the whole trick,
// and it is worth being precise about what it does and does not do. Next.js
// serializes a bound server-action argument into an ENCRYPTED closure
// reference that does travel to the browser and back — it is not that the
// value never crosses the network, it is that the browser cannot read or
// forge it. What the client's own payload carries is `{ query }` and nothing
// else, which is what `StellaGroundedQueryRequest` having a single property
// is protecting.
//
// The action does NOT trust the bound value either: `runStellaGroundedQuery`
// re-verifies the project against the authenticated session's organization
// before any chunk is read, exactly as `getStellaContextualAdvisor` does with
// the `projectId` its own callers pass. Organization membership is this
// product's project-access boundary — there is no per-project membership
// table — so naming a project of one's own organization is not an escalation
// here any more than it is there.
//
// STATUS: IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE.
// Nothing renders this yet, on purpose. See the note below.

import { StellaGroundedQueryPanel } from '@/components/stella'
import { isStellaCapabilityReady } from '@/lib/stella/capability-readiness'
import {
  issueStellaGroundedQueryTicketForProject,
  runStellaGroundedQueryForProject,
} from '@/app/actions/stella/grounded-query'
import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'
import type { GroundedCitationView } from '@/components/stella/grounding-adapter'

export interface StellaGroundedQuerySectionProps {
  /** Server-resolved route param. Never read from a client payload. */
  projectId: string
  /** The pipeline step the reviewer is on — carried into the decision record. */
  step: AdvisorPipelineStep
  title?: string
  onNavigateCitation?: (citation: GroundedCitationView) => void
}

/**
 * Mirrors the server action's own readiness gate — and mirrors it by CALLING
 * that gate, not by restating it.
 *
 * WHAT THIS USED TO READ, AND WHY IT WAS WRONG
 *
 *   stellaConfig.isEnabled && stellaConfig.isGroundedQueryEnabled
 *     && stellaState.canUseStella
 *
 * — the shape the seven pipeline pages use for the advisor and reviewer
 * gates. The third term is `GEMINI_API_KEY` presence, and `grounded_query`
 * does not call Gemini. Both server entry points
 * (`runStellaGroundedQuery`, `issueStellaGroundedQueryTicket`) gate on
 * `isStellaCapabilityReady('grounded_query')`, which deliberately omits the
 * provider requirement because this path answers through
 * `createExtractiveAnswerProvider` — local, offline, and incapable of
 * opening a socket. A deployment with both flags on and no key therefore had
 * a READY server sitting behind an inert panel, and the panel is the only way
 * a human reaches the action.
 *
 * The fix is NOT to drop the key term here. That would state the provider
 * rule in a second place and leave the two free to drift apart again — the
 * exact failure lib/stella/capability-readiness.ts was written to prevent. It
 * is to ask the one table the actions ask.
 *
 * Nothing is loosened by that. `STELLA_ENABLED` and
 * `STELLA_GROUNDED_QUERY_ENABLED` are still both required: they are the first
 * two checks inside `stellaCapabilityBlocker`, in that order, and the
 * capabilities that DO reach `StellaGeminiAdapter` still keep their key
 * requirement in the same table (`GEMINI_BACKED_STELLA_CAPABILITIES`).
 *
 * The mirror is still not the enforcement — `runStellaGroundedQuery` checks
 * the capability FIRST, before auth and before any database work — it only
 * stops the panel from rendering an input the server would refuse.
 */
export function StellaGroundedQuerySection({
  projectId,
  step,
  title,
  onNavigateCitation,
}: StellaGroundedQuerySectionProps) {
  const enabled = isStellaCapabilityReady('grounded_query')

  const runQuery = runStellaGroundedQueryForProject.bind(null, projectId)

  // INT-INT-001. The SECOND bound action: the panel cannot mint an operation
  // identity itself (that is the whole point — a client-chosen identity is a
  // client-chosen discount), so issuance is a governed server surface bound
  // to the same server-resolved project id.
  //
  // Both are bound to `projectId` and both re-verify it against the session's
  // organization server-side, so the two actions cannot be made to disagree
  // about which project the operation belongs to.
  const issueTicket = issueStellaGroundedQueryTicketForProject.bind(null, projectId)

  return (
    <StellaGroundedQueryPanel
      step={step}
      runQuery={runQuery}
      issueTicket={issueTicket}
      enabled={enabled}
      title={title ?? 'Consultar a Stella (respuesta fundamentada)'}
      onNavigateCitation={onNavigateCitation}
      // `onDecision` is deliberately NOT wired. There is no canonical decision
      // key for a grounded answer: `recordStellaDecision` keys on
      // `suggestionKey`, and a grounded answer is not a suggestion — reusing
      // that key would file two different entities in one table and make
      // "was this decision saved?" answerable in two divergent ways.
      // Registered as contract request INT-PR-001.
      //
      // Leaving the prop off is not by itself enough to be honest about it:
      // the panel's decision badge ("Aceptada" / "Rechazada") looks identical
      // to the one flows with real persistence show. So the panel states the
      // absence in words when no `onDecision` is supplied — see the
      // `decision-not-persisted` note in StellaGroundedQueryPanel.
    />
  )
}
