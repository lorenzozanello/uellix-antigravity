// db/hosted/authority/window-plan.ts
// COMMIT 3 — plan-level invariants, stated so they can be checked WITHOUT the
// derivation that produced the plan.
//
// ---------------------------------------------------------------------------
// THE INDEPENDENCE RULE
// ---------------------------------------------------------------------------
// A generator and a validator that share reasoning cannot disagree, and a pair
// that cannot disagree cannot detect anything. Sharing the LEXICAL layer is
// unavoidable and harmless — both halves must agree on what a statement is, and
// a disagreement there would be a parse bug, not a plan bug. What must not be
// shared is the reasoning that decides where a window begins.
//
// So every function here is a property of the FINISHED plan, evaluated against
// the packages: "each anchor resolves once", "no window overlaps another", "the
// counts are what the plan says", "canonical order survived". None of them asks
// how the boundary was chosen, so none of them can be satisfied by agreeing with
// a wrong choice.
//
// ---------------------------------------------------------------------------
// WHY BOOKKEEPING IS EXEMPT FROM UNIQUENESS
// ---------------------------------------------------------------------------
// `SET ROLE uellix_owner` appears twice in stella_0016 and `RESET ROLE` twice
// alongside it — measured, and asserted by a test rather than assumed. Those are
// the only repeated statement identities in the whole chain. They are exempt
// because the plan never anchors on them: they are the authority bookkeeping the
// derived output REPLACES. Refusing them would force an occurrence index onto
// precisely the statements that least need identity, which is the shortcut this
// design rejected everywhere else.

import type { SqlStatement } from './sql-statements'
import { parseStatementIdentity, statementIdentityKey, type StatementClass } from './structural-identity'
import { AuthorityRefusal, type AuthorityWindow, type WindowAuthority } from './window-contract'

/* -------------------------------------------------------------------------- */
/* The chain, named                                                            */
/* -------------------------------------------------------------------------- */

export interface ChainPackageFile {
  /** `T1`..`T9` — the identifiers the authority plan uses. */
  readonly packageId: string
  /** File under `db/prepared/`. */
  readonly sourceFile: string
}

/**
 * T1..T9 in chain order.
 *
 * The bootstrap (`stella_hosted_0001`) is deliberately absent: it is
 * `native-hosted`, it is not derived from anything, and it is the package that
 * INSTALLS the roles every window below acts as. Giving it a Tn would invite a
 * window inside it, and there is no authority to elevate to before the roles
 * exist.
 */
export const CHAIN_PACKAGE_FILES: readonly ChainPackageFile[] = [
  { packageId: 'T1', sourceFile: 'grounding_0002_document_versions.sql' },
  { packageId: 'T2', sourceFile: 'grounding_0003_evidence_chunks.sql' },
  { packageId: 'T3', sourceFile: 'grounding_0004_runtime_attestation.sql' },
  { packageId: 'T4', sourceFile: 'stella_0013_grounded_query_quota.sql' },
  { packageId: 'T5', sourceFile: 'stella_0014_operation_tickets.sql' },
  { packageId: 'T6', sourceFile: 'stella_0015_project_bound_operation_tickets.sql' },
  { packageId: 'T7', sourceFile: 'stella_0016_reserved_quota_semantics.sql' },
  { packageId: 'T8', sourceFile: 'stella_0017_governed_stella_consumption.sql' },
  { packageId: 'T9', sourceFile: 'stella_0018_category_bound_operation_tickets.sql' },
]

/* -------------------------------------------------------------------------- */
/* Classes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Statement classes that only the INSTALLER may execute, and that therefore may
 * never appear inside an owner, capability or transfer window.
 *
 * The membership statements are here for the reason RT-06 named: a window that
 * can grant role membership can grant ITSELF more authority than the window was
 * reviewed for, and the review would still read as correct. `CREATE ROLE` and
 * `ALTER ROLE` are here because managed Supabase gates them on CREATEROLE,
 * which the elevated roles deliberately do not hold — so a package that tried
 * would fail at apply time in the middle of a window, which is the worst place
 * for it to fail.
 */
export const INSTALLER_ONLY_CLASSES: readonly StatementClass[] = [
  'create-role',
  'alter-role',
  'grant-membership',
  'revoke-membership',
]

/** Classes that are authority bookkeeping: never governed, never an anchor. */
export const BOOKKEEPING_CLASSES: readonly StatementClass[] = [
  'set-role',
  'reset-role',
  'set-parameter',
]

const BOOKKEEPING = new Set<StatementClass>(BOOKKEEPING_CLASSES)
const INSTALLER_ONLY = new Set<StatementClass>(INSTALLER_ONLY_CLASSES)

export function isBookkeeping(statementClass: StatementClass): boolean {
  return BOOKKEEPING.has(statementClass)
}

/* -------------------------------------------------------------------------- */
/* Invariant 1 — governed identities are unique                                */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a package in which two GOVERNED statements share one identity.
 *
 * The alternative — quietly appending an occurrence index — was rejected
 * explicitly. An occurrence index re-points at a different statement the moment
 * an earlier one is added, which is the exact silent failure that structural
 * identity exists to remove; adding it back as a tie-breaker would reintroduce
 * it in the one place nobody would think to look.
 */
export function assertGovernedIdentitiesUnique(
  packageId: string,
  statements: readonly SqlStatement[],
): void {
  const seen = new Map<string, number[]>()

  for (const statement of statements) {
    const identity = parseStatementIdentity(statement.raw)
    if (isBookkeeping(identity.statementClass)) continue
    const key = statementIdentityKey(identity)
    const at = seen.get(key)
    if (at === undefined) seen.set(key, [statement.index])
    else at.push(statement.index)
  }

  for (const [key, indexes] of seen) {
    if (indexes.length > 1) {
      throw new AuthorityRefusal(
        'AUTHORITY_STATEMENT_IDENTITY_DUPLICATE',
        `${packageId}: statements ${indexes.join(', ')} all have identity \`${key}\`. An anchor ` +
          `naming it could not resolve to one statement, and no occurrence index will be invented ` +
          `to paper over it. Either the duplicate is a defect in the package, or the plan needs a ` +
          `different anchor.`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Invariant 2 — the totals                                                    */
/* -------------------------------------------------------------------------- */

export interface WindowTotals {
  readonly owner: number
  readonly capability: number
  readonly transfer: number
}

export function countWindows(windows: readonly AuthorityWindow[]): WindowTotals {
  const count = (authority: WindowAuthority): number =>
    windows.filter((w) => w.authority === authority).length
  return { owner: count('owner'), capability: count('capability'), transfer: count('transfer') }
}

/**
 * Refuses a plan whose window counts have moved.
 *
 * The totals are a checksum over the whole authority surface: a window added,
 * removed or reclassified changes one of the three numbers, and no combination
 * of package-local edits can leave all three unchanged while changing what the
 * plan does.
 */
export function assertWindowTotals(
  windows: readonly AuthorityWindow[],
  expected: WindowTotals,
): void {
  const actual = countWindows(windows)
  if (
    actual.owner !== expected.owner ||
    actual.capability !== expected.capability ||
    actual.transfer !== expected.transfer
  ) {
    throw new AuthorityRefusal(
      'AUTHORITY_WINDOW_COUNT_TOTALS',
      `the plan holds OWNER=${actual.owner} CAPABILITY=${actual.capability} ` +
        `TRANSFER=${actual.transfer} (total ${actual.owner + actual.capability + actual.transfer}), ` +
        `but declares OWNER=${expected.owner} CAPABILITY=${expected.capability} ` +
        `TRANSFER=${expected.transfer} (total ${expected.owner + expected.capability + expected.transfer}).`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Invariant 4 — canonical order survives derivation                           */
/* -------------------------------------------------------------------------- */

/**
 * Refuses derived output that reorders or drops a canonical statement.
 *
 * Authority bookkeeping may be interleaved freely — that is the whole point of
 * deriving an output at all — so the check is a SUBSEQUENCE test rather than an
 * equality test: strip the bookkeeping the derivation is allowed to insert, and
 * what remains must be the canonical sequence, in order, complete.
 *
 * A weaker "same multiset" check was rejected: swapping a REVOKE and a GRANT on
 * the same object changes the end state and leaves the multiset identical.
 */
export function assertCanonicalSubsequence(
  canonicalKeys: readonly string[],
  derivedKeys: readonly string[],
  insertableKeys: ReadonlySet<string>,
): void {
  const governed = derivedKeys.filter((key) => !insertableKeys.has(key))

  if (governed.length !== canonicalKeys.length) {
    throw new AuthorityRefusal(
      'AUTHORITY_CANONICAL_ORDER_VIOLATION',
      `derived output carries ${governed.length} canonical statements, the canonical package has ` +
        `${canonicalKeys.length}. A statement was dropped or invented, not merely moved.`,
    )
  }

  for (const [i, key] of canonicalKeys.entries()) {
    if (governed[i] !== key) {
      throw new AuthorityRefusal(
        'AUTHORITY_CANONICAL_ORDER_VIOLATION',
        `at canonical position ${i} the derived output has \`${governed[i]}\` where the canonical ` +
          `package has \`${key}\`. Two canonical statements changed places: A before B must stay ` +
          `A before B, because the packages depend on their own order (a REVOKE that precedes a ` +
          `GRANT is a different end state from one that follows it).`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Invariant 5 — installer-only never sits inside an elevated window           */
/* -------------------------------------------------------------------------- */

export function assertNoInstallerOnlyInElevatedWindow(
  where: string,
  statements: readonly SqlStatement[],
): void {
  for (const statement of statements) {
    const identity = parseStatementIdentity(statement.raw)
    if (INSTALLER_ONLY.has(identity.statementClass)) {
      throw new AuthorityRefusal(
        'AUTHORITY_INSTALLER_ONLY_IN_ELEVATED_WINDOW',
        `${where}: statement ${statement.index} is \`${identity.statementClass}\`, which only the ` +
          `installer may execute. Inside an elevated window it would either fail at apply time ` +
          `(the elevated roles hold no CREATEROLE) or, worse for membership, succeed and widen the ` +
          `very authority the window was reviewed against.\n    ${statement.executable.slice(0, 160)}`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Overlap                                                                     */
/* -------------------------------------------------------------------------- */

export interface WindowSpan {
  readonly windowId: string
  readonly startIndex: number
  readonly endIndex: number
}

/**
 * Refuses two windows that govern the same statement.
 *
 * Overlap is not a tidiness concern. Two windows over one statement means two
 * different authorities were declared sufficient for it, and whichever the
 * generator emits second silently wins.
 */
export function assertNoWindowOverlap(packageId: string, spans: readonly WindowSpan[]): void {
  const sorted = [...spans].sort((a, b) => a.startIndex - b.startIndex)
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]
    const current = sorted[i]
    if (current.startIndex <= previous.endIndex) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_OVERLAP',
        `${packageId}: ${previous.windowId} governs statements ${previous.startIndex}..` +
          `${previous.endIndex} and ${current.windowId} governs ${current.startIndex}..` +
          `${current.endIndex}. They share at least statement ${current.startIndex}, so two ` +
          `authorities are declared sufficient for it and the generator's emission order decides ` +
          `which one applies.`,
      )
    }
  }
}
