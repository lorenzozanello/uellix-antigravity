// db/hosted/authority/canonical-role-context.ts
// COMMIT 3.1 — F-01. The seam between "needs elevated AUTHORITY" and "must run
// under an elevated ROLE".
//
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO PREVENT
// ---------------------------------------------------------------------------
// `CREATE TABLE public.evidence_document_versions` sits outside every A_FINAL
// classification window — correctly, because the recovered partition counts
// authority statements and a table creation inside an owner span is not one of
// them. But the canonical migration wraps it in `SET ROLE uellix_owner`, and the
// role that runs a CREATE TABLE BECOMES ITS OWNER.
//
// So if Commit 4 read "not in a window" as "run it as the installer", the
// generated hosted package would create three tables owned by `postgres`
// instead of `uellix_owner`. Nothing would fail at apply time. Every later
// `GRANT`, `CREATE POLICY` and `ALTER TABLE` on them would still work, because
// the installer owns them. The chain would come up looking correct and the
// entire ownership model would be wrong — discovered, at best, when the ledger
// was audited months later.
//
// ---------------------------------------------------------------------------
// TWO QUESTIONS, TWO ANSWERS
// ---------------------------------------------------------------------------
//   ClassificationWindow      WHY does this statement need elevated authority?
//   CanonicalExecutionContext WHICH role must execute this statement, because
//                             the canonical migration deliberately encloses it
//                             in a SET ROLE span?
//
// They are not the same question and must not share a field. A statement can be
// outside every window (no authority claim to make about it) and still have a
// hard execution requirement.
//
// ---------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------
// Role context is derived from the SET ROLE / RESET ROLE statements themselves,
// structurally, never by "inherit from the previous statement". A second
// `SET ROLE` inside an open span, a `RESET ROLE` with nothing open, or a span
// still open at end of file all refuse: PostgreSQL does not stack SET ROLE
// (lab M6), so any of those means the file's role structure is not what the
// derivation assumed.

import { AuthorityRefusal } from './window-contract'
import { normalizedExecutableDigest, statementIdentityKey } from './structural-identity'
import { INSTALLER_OWNER, type SimulatedStatement } from './ownership-simulation'
import { hostedRole } from './role-registry'

/** The role a statement must run as. `INSTALLER_OWNER` means "no elevation". */
export type RequiredExecutor = string

export interface CanonicalExecutionContext {
  readonly packageId: string
  readonly statementIndex: number
  readonly statementIdentity: string
  /** SHA-256 of the normalized executable text, so the pin survives comments. */
  readonly digest: string
  readonly requiredExecutor: RequiredExecutor
  readonly provenance: 'CANONICAL_SET_ROLE_SPAN'
  /** Identity of the `SET ROLE` that opened the span. Structural, not a line. */
  readonly spanOpenedBy: string
}

/**
 * The role in force at each statement, derived from the package's own
 * `SET ROLE` / `RESET ROLE` statements.
 *
 * Returns one entry per statement, in file order. `INSTALLER_OWNER` means the
 * statement runs unelevated.
 */
export function canonicalRoleContextOf(
  packageId: string,
  rows: readonly SimulatedStatement[],
): { context: RequiredExecutor; openedBy: string | null }[] {
  const out: { context: RequiredExecutor; openedBy: string | null }[] = []
  let context: RequiredExecutor = INSTALLER_OWNER
  let openedBy: string | null = null

  for (const row of rows) {
    const statementClass = row.identity.statementClass

    if (statementClass === 'set-role') {
      if (context !== INSTALLER_OWNER) {
        throw new AuthorityRefusal(
          'AUTHORITY_ROLE_CONTEXT_AMBIGUOUS',
          `${packageId} statement ${row.statement.index}: SET ROLE while a ${context} span is ` +
            `already open. PostgreSQL does not stack SET ROLE (lab M6) — the inner RESET would ` +
            `return to the session role, not to ${context} — so the role in force after this ` +
            `point cannot be derived and is refused rather than guessed.`,
        )
      }
      const role = row.identity.operands[0]
      hostedRole(role) // refuses a role the registry does not know
      context = role
      openedBy = statementIdentityKey(row.identity)
      out.push({ context: INSTALLER_OWNER, openedBy: null })
      continue
    }

    if (statementClass === 'reset-role') {
      if (context === INSTALLER_OWNER) {
        throw new AuthorityRefusal(
          'AUTHORITY_ROLE_CONTEXT_AMBIGUOUS',
          `${packageId} statement ${row.statement.index}: RESET ROLE with no open span. Either a ` +
            `SET ROLE was removed or the file's role structure is not what this derivation reads.`,
        )
      }
      context = INSTALLER_OWNER
      openedBy = null
      out.push({ context: INSTALLER_OWNER, openedBy: null })
      continue
    }

    out.push({ context, openedBy })
  }

  if (context !== INSTALLER_OWNER) {
    throw new AuthorityRefusal(
      'AUTHORITY_ROLE_CONTEXT_AMBIGUOUS',
      `${packageId}: a ${context} span is still open at end of package. A generated artefact that ` +
        `ended elevated would leave the applying session as ${context}.`,
    )
  }

  return out
}

/**
 * The statements that need an execution context ONLY because the canonical
 * migration encloses them in a SET ROLE span.
 *
 * `governed` names the statements a classification window already covers — for
 * those the ExecutionSegment decides the executor, and a second answer here
 * would be a second source of truth.
 */
export function deriveCanonicalExecutionContexts(
  packageId: string,
  rows: readonly SimulatedStatement[],
  governed: ReadonlySet<number>,
): CanonicalExecutionContext[] {
  const contexts = canonicalRoleContextOf(packageId, rows)
  const out: CanonicalExecutionContext[] = []

  for (const [i, row] of rows.entries()) {
    const { context, openedBy } = contexts[i]
    if (context === INSTALLER_OWNER) continue
    if (governed.has(row.statement.index)) continue

    out.push({
      packageId,
      statementIndex: row.statement.index,
      statementIdentity: statementIdentityKey(row.identity),
      digest: normalizedExecutableDigest(row.statement.raw),
      requiredExecutor: context,
      provenance: 'CANONICAL_SET_ROLE_SPAN',
      spanOpenedBy: openedBy as string,
    })
  }

  return out
}
