'use server'
// app/actions/stella/decisions.ts
// WS3b U4: recordStellaDecision — persists what a human DID with a Stella
// suggestion (accepted / accepted_edited / rejected / undone) into
// stella_suggestion_decisions.
//
// DORMANT BY DEFAULT: the target table exists only as PREPARED SQL
// (db/prepared/stella_0003_suggestion_decisions.sql). Enabling
// STELLA_DECISIONS_PERSISTENCE_ENABLED before gate G2 applies that script
// (docs/ops/gates/G2_PACKAGE.md) will make every call fail at the INSERT.
// The flag defaults to false and this action returns DISABLED without
// touching the database until Lorenzo flips it post-G2.
//
// Security invariants:
// - organization_id and decided_by ALWAYS come from the authenticated session
//   (requireOrganizationAccess) — never from client input.
// - projectId is re-verified to belong to the session organization.
// - previousValue (raw text being replaced) is NEVER persisted — only its
//   SHA-256 hex digest goes to previous_value_hash. appliedText (editedText)
//   is persisted as provided (it becomes project content anyway).
//
// ---------------------------------------------------------------------------
// CLIENT-CALLABLE CONTRACT (for the UI agent building the suggestion panel):
//
//   import { recordStellaDecision } from '@/app/actions/stella/decisions'
//   import {
//     StellaDecisionInputSchema,          // Zod schema — client-side pre-validation
//     type StellaDecisionInput,           // { projectId, suggestionKey, decision,
//                                         //   interactionId?, editedText?,
//                                         //   rejectionReason?, previousValue? }
//     type StellaDecisionValue,           // 'accepted'|'accepted_edited'|'rejected'|'undone'
//   } from '@/app/actions/stella/decisions-schema'
//
//   // Suggested onDecision hook wiring:
//   const onDecision = async (input: StellaDecisionInput) => {
//     const result = await recordStellaDecision(input)
//     // result: { ok: true, data: { id } }
//     //       | { ok: false, error: 'DISABLED'|'UNAUTHORIZED'|'INVALID_INPUT'|'DB_ERROR', message }
//     // 'DISABLED' is the EXPECTED result until G2 + flag flip — the UI must
//     // treat it as a silent no-op (decisions simply aren't persisted yet).
//   }
//
//   Notes for the UI:
//   - Pass previousValue with the text a suggestion replaces (undo support);
//     the server hashes it — never render it back from the decision record.
//   - 'undone' is a NEW decision row referencing the same suggestionKey, not
//     a mutation of the earlier row (the table is append-only).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
import { stellaConfig } from '@/lib/stella/config'
import { db } from '@/db/client'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { logAuditAction, AUDIT_ACTIONS, type AuditLogEntry } from '@/lib/audit/logger'
import { StellaDecisionInputSchema, type StellaDecisionInput } from './decisions-schema'

export type StellaDecisionErrorCode = 'DISABLED' | 'UNAUTHORIZED' | 'INVALID_INPUT' | 'DB_ERROR'

export type StellaDecisionResult =
  | { ok: true; data: { id: string | null } }
  | { ok: false; error: StellaDecisionErrorCode; message: string }

// Fire-and-forget audit trail write (WS3b): an audit_logs failure must NEVER
// change the user-facing result. Metadata only — no suggestion/previous text.
async function logStellaAudit(entry: AuditLogEntry): Promise<void> {
  try {
    // Its own short transaction — see the same note in app/actions/stella/advisor.ts.
    await withOrganizationDatabaseContext(() => logAuditAction(entry))
  } catch (error) {
    console.error('[stella-audit] audit write failed:', error instanceof Error ? error.name : 'unknown')
  }
}

export async function recordStellaDecision(input: StellaDecisionInput): Promise<StellaDecisionResult> {
  // Flag gate FIRST — while dormant (pre-G2) nothing below runs and the
  // database is never touched.
  if (!stellaConfig.isDecisionsPersistenceEnabled) {
    return { ok: false, error: 'DISABLED', message: 'Stella decision persistence is not enabled.' }
  }

  // Validate shape before doing anything with the payload.
  const parsed = StellaDecisionInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'INVALID_INPUT', message: 'Invalid decision payload.' }
  }
  const data = parsed.data

  // Auth + org context — org and user identity come from the session ONLY.
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Authentication required.' }
  }

  // Role gate — same set as every other Stella surface (viewer denied).
  if (!canUseStella(ctx.membership.role)) {
    return { ok: false, error: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  try {
    // Hash-not-content invariant: the raw previous value never reaches the DB.
    const previousValueHash =
      data.previousValue !== undefined
        ? createHash('sha256').update(data.previousValue, 'utf8').digest('hex')
        : null

    // ONE transaction for the two ownership checks AND the insert. They are a
    // single decision: splitting them would leave a window in which the
    // project or the interaction stops belonging to this organisation between
    // the check and the write.
    const outcome = await withOrganizationDatabaseContext(async () => {
      // Project ownership: the client-supplied projectId must belong to the
      // session organization. This check remains MANDATORY even now that RLS
      // applies to this connection: `projects_select_member_or_admin` scopes
      // the row to organisations the caller belongs to, but a user who belongs
      // to TWO organisations would still pass RLS while naming a project from
      // the other one. RLS bounds the blast radius; this bounds the intent.
      //
      // (Historical note: before db/prepared/stella_0005_runtime_cutover.sql
      // this connection was the table OWNER and RLS did not apply here at all.
      // It is `uellix_app` now — verified per connection by db/runtime-bootstrap.ts.)
      const owned = await db.execute(
        sql`SELECT 1 FROM projects WHERE id = ${data.projectId} AND organization_id = ${ctx.organization.id} LIMIT 1`,
      )
      if ((owned as unknown as unknown[]).length === 0) {
        return { kind: 'unauthorized' as const }
      }

      // interactionId ownership: a client-supplied interaction UUID must exist
      // AND belong to the session organization and this same project — the FK
      // alone would let an org-A member attribute a decision to an org-B
      // interaction (cross-org misattribution). Not-found and cross-org return
      // the SAME error code and message as schema validation on purpose, so the
      // response is not an existence oracle for foreign interaction ids.
      if (data.interactionId !== undefined) {
        const interaction = await db.execute(
          sql`SELECT 1 FROM stella_interactions
            WHERE id = ${data.interactionId}
              AND organization_id = ${ctx.organization.id}
              AND project_id = ${data.projectId}
            LIMIT 1`,
        )
        if ((interaction as unknown as unknown[]).length === 0) {
          return { kind: 'invalid' as const }
        }
      }

      const inserted = await db.execute(sql`
      INSERT INTO stella_suggestion_decisions
        (organization_id, project_id, interaction_id, suggestion_key, decision,
         previous_value_hash, applied_text, rejection_reason, decided_by)
      VALUES
        (${ctx.organization.id}, ${data.projectId}, ${data.interactionId ?? null},
         ${data.suggestionKey}, ${data.decision}, ${previousValueHash},
         ${data.editedText ?? null}, ${data.rejectionReason ?? null}, ${ctx.user.id})
      RETURNING id
    `)

      const rows = inserted as unknown as Array<{ id?: string }>
      return { kind: 'created' as const, decisionId: rows[0]?.id ?? null }
    })

    if (outcome.kind === 'unauthorized') {
      return { ok: false, error: 'UNAUTHORIZED', message: 'Project access denied.' }
    }
    if (outcome.kind === 'invalid') {
      return { ok: false, error: 'INVALID_INPUT', message: 'Invalid decision payload.' }
    }
    const decisionId = outcome.decisionId

    await logStellaAudit({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'project',
      entityId: data.projectId,
      action: AUDIT_ACTIONS.STELLA_DECISION_RECORDED,
      afterJson: {
        decisionId,
        decision: data.decision,
        suggestionKey: data.suggestionKey,
        interactionId: data.interactionId ?? null,
        hasPreviousValueHash: previousValueHash !== null,
      },
    })

    return { ok: true, data: { id: decisionId } }
  } catch (error) {
    console.error('[stella] recordStellaDecision insert failed:', error instanceof Error ? error.name : 'unknown')
    return { ok: false, error: 'DB_ERROR', message: 'Failed to record decision. Please try again.' }
  }
}
