// db/hosted/authority/window-contract.ts
// COMMIT 3 — what one authority window pins, and every way it refuses.
//
// ---------------------------------------------------------------------------
// WHY FOUR PINS AND NOT TWO
// ---------------------------------------------------------------------------
// The economical version of this file pins a start anchor, an end anchor, a
// statement count and a set of allowed classes. It was rejected, because there
// are three edits it cannot see and each of them is an authority change:
//
//   same-class replacement  swap `GRANT USAGE ... TO uellix_app` for
//                           `... TO uellix_writer`. Same count, same class.
//   reordering              move two statements inside the window past each
//                           other. Same count, same classes, same multiset.
//   body mutation           change one line inside a DO block. The statement
//                           count does not move at all.
//
// So the window also pins `statementDigestSequence`: the ordered digests of the
// statements it governs. It is the least human-readable field in the manifest
// and the only one that closes those three. The readable fields stay because a
// reviewer needs something to check by eye, and because a count mismatch gives
// a far better diagnostic than a hash mismatch — which is why the checks run in
// the order count, classes, digests, and stop at the first that fires.
//
// ---------------------------------------------------------------------------
// FAIL CLOSED, ALWAYS
// ---------------------------------------------------------------------------
// Every path out of this module is either a resolved window or a throw. There
// is no "best effort" resolution and, in particular, no first-match: an anchor
// that matches two statements is AMBIGUOUS, not "the first one". First-match is
// how an anchor silently re-points at a different statement after an edit, and
// re-pointing quietly is the single failure this whole design exists to stop.

import type { SqlStatement } from './sql-statements'
import {
  normalizedExecutableDigest,
  parseStatementIdentity,
  statementIdentityKey,
  type StatementClass,
} from './structural-identity'

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

export const AUTHORITY_REFUSAL_CODES = [
  'AUTHORITY_WINDOW_START_ANCHOR_MISSING',
  'AUTHORITY_WINDOW_START_ANCHOR_AMBIGUOUS',
  'AUTHORITY_WINDOW_END_ANCHOR_MISSING',
  'AUTHORITY_WINDOW_END_ANCHOR_AMBIGUOUS',
  'AUTHORITY_WINDOW_ANCHOR_ORDER',
  'AUTHORITY_WINDOW_COUNT_DRIFT',
  'AUTHORITY_WINDOW_CLASS_DRIFT',
  'AUTHORITY_WINDOW_DIGEST_DRIFT',
  'AUTHORITY_WINDOW_OVERLAP',
  'AUTHORITY_STATEMENT_IDENTITY_DUPLICATE',
  'AUTHORITY_INSTALLER_ONLY_IN_ELEVATED_WINDOW',
  'AUTHORITY_CANONICAL_ORDER_VIOLATION',
  'AUTHORITY_WINDOW_COUNT_TOTALS',
  'AUTHORITY_MEMBERSHIP_SELF_REFERENCE',
  'AUTHORITY_UNKNOWN_ROLE',
  'AUTHORITY_STATE_TRANSITION_INVALID',
  'AUTHORITY_CLEANUP_INCOMPLETE',
  'AUTHORITY_OWNER_BEFORE_MISMATCH',
  'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
  'AUTHORITY_EXECUTION_SEGMENT_MULTIPLE_ROLES',
  'AUTHORITY_DO_MULTIPLE_EXECUTORS',
  'AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES',
  'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
  'AUTHORITY_ROLE_CONTEXT_AMBIGUOUS',
  'AUTHORITY_EXECUTOR_OWNER_UNKNOWN',
  'AUTHORITY_PRIVILEGE_EVENT_UNSUPPORTED',
  'AUTHORITY_TEMP_MEMBER_NOT_INSTALLER',
] as const

export type AuthorityRefusalCode = (typeof AUTHORITY_REFUSAL_CODES)[number]

export class AuthorityRefusal extends Error {
  readonly code: AuthorityRefusalCode
  constructor(code: AuthorityRefusalCode, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'AuthorityRefusal'
  }
}

/* -------------------------------------------------------------------------- */
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What kind of authority the window needs held while its statements run.
 *
 * `transfer` is its own kind rather than a flavour of `owner` because the
 * requirement is genuinely different: an ownership change needs membership in
 * BOTH the current and the incoming owner, and on PostgreSQL 16+ it also needs
 * CREATE on the containing schema against the NEW owner. A window that merely
 * needed to BE the owner would not have caught that, and the chain measured it
 * the hard way (S1-DEFECT-001).
 */
export type WindowAuthority = 'owner' | 'capability' | 'transfer'

export interface AuthorityWindow {
  /** `T1`..`T9`. */
  readonly packageId: string
  /** `W01`.. — unique across the whole plan, not per package. */
  readonly windowId: string
  readonly authority: WindowAuthority
  /**
   * DEPRECATED and deliberately unusable as an executor.
   *
   * A classification window can involve TWO capability roles (W38, W46, W47,
   * W51), and PostgreSQL has one effective `current_role`. A scalar field here
   * would have to name one of them, and any caller reading it would run the
   * other role's statements under the wrong identity while the manifest
   * recorded the result as correct.
   *
   * The exact executor lives on `ExecutionSegment.executor` and nowhere else.
   * The field is kept only so an older pinned window still parses; it is typed
   * `never` on purpose so that reading it does not compile.
   */
  readonly capabilityRole?: never
  /** The schema the window's objects live in, when it has exactly one. */
  readonly schema: string | null
  /** Whether the installer must be granted membership for the window's span. */
  readonly needsTemporaryMembership: boolean
  /** Whether the acting role must be granted CREATE on `schema` temporarily. */
  readonly needsTemporarySchemaCreate: boolean
  /** StatementIdentity key of the first governed statement. */
  readonly start: string
  /** StatementIdentity key of the last governed statement. */
  readonly end: string
  readonly expectedStatementCount: number
  readonly allowedStatementClasses: readonly StatementClass[]
  /** Ordered digests of every governed statement. Order is part of the pin. */
  readonly statementDigestSequence: readonly string[]
}

export interface ResolvedWindow {
  readonly window: AuthorityWindow
  readonly startIndex: number
  readonly endIndex: number
  readonly statements: readonly SqlStatement[]
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/** Identity keys for a whole package, in file order. Throws on any unmodelled form. */
export function statementIdentityKeys(statements: readonly SqlStatement[]): string[] {
  return statements.map((s) => statementIdentityKey(parseStatementIdentity(s.raw)))
}

/**
 * Finds the ONE statement an anchor names.
 *
 * Zero matches and two matches are different diagnoses and get different codes,
 * because they call for different operator actions: a missing anchor means the
 * statement was edited or removed, an ambiguous one means the package grew a
 * second statement with the same identity and the plan needs a different anchor
 * (or the duplicate is itself the defect).
 */
export function resolveAnchor(
  statements: readonly SqlStatement[],
  identityKey: string,
  position: 'start' | 'end',
): number {
  const keys = statementIdentityKeys(statements)
  const matches: number[] = []
  for (const [i, key] of keys.entries()) {
    if (key === identityKey) matches.push(i)
  }

  const missing =
    position === 'start'
      ? 'AUTHORITY_WINDOW_START_ANCHOR_MISSING'
      : 'AUTHORITY_WINDOW_END_ANCHOR_MISSING'
  const ambiguous =
    position === 'start'
      ? 'AUTHORITY_WINDOW_START_ANCHOR_AMBIGUOUS'
      : 'AUTHORITY_WINDOW_END_ANCHOR_AMBIGUOUS'

  if (matches.length === 0) {
    throw new AuthorityRefusal(
      missing,
      `no statement in the package has identity \`${identityKey}\`. The statement it named was ` +
        `edited, removed, or never existed. The plan is not re-pointed automatically.`,
    )
  }
  if (matches.length > 1) {
    throw new AuthorityRefusal(
      ambiguous,
      `identity \`${identityKey}\` matches ${matches.length} statements (indexes ` +
        `${matches.join(', ')}). An anchor must name exactly one. First-match is never used.`,
    )
  }
  return matches[0]
}

/**
 * Resolves one window against a package and verifies every pin.
 *
 * Check order is deliberate: count, then classes, then digests. Each later check
 * is strictly harder for a human to act on than the one before it, so the first
 * one that can explain the drift is the one that reports it.
 */
export function resolveWindow(
  statements: readonly SqlStatement[],
  window: AuthorityWindow,
): ResolvedWindow {
  const where = `${window.packageId}/${window.windowId}`

  const startIndex = resolveAnchor(statements, window.start, 'start')
  const endIndex = resolveAnchor(statements, window.end, 'end')

  if (endIndex < startIndex) {
    throw new AuthorityRefusal(
      'AUTHORITY_WINDOW_ANCHOR_ORDER',
      `${where}: the end anchor resolves to statement ${endIndex}, before the start anchor at ` +
        `${startIndex}. Two statements swapped places, or the window was written backwards.`,
    )
  }

  const span = statements.slice(startIndex, endIndex + 1)

  if (span.length !== window.expectedStatementCount) {
    throw new AuthorityRefusal(
      'AUTHORITY_WINDOW_COUNT_DRIFT',
      `${where}: pinned to govern ${window.expectedStatementCount} statements, found ` +
        `${span.length} between its anchors. A statement was added to or removed from the window.`,
    )
  }

  const allowed = new Set<StatementClass>(window.allowedStatementClasses)
  for (const [offset, statement] of span.entries()) {
    const statementClass = parseStatementIdentity(statement.raw).statementClass
    if (!allowed.has(statementClass)) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_CLASS_DRIFT',
        `${where}: statement ${startIndex + offset} is \`${statementClass}\`, which this window ` +
          `does not permit (allowed: ${[...allowed].join(', ')}).`,
      )
    }
  }

  if (window.statementDigestSequence.length !== span.length) {
    throw new AuthorityRefusal(
      'AUTHORITY_WINDOW_DIGEST_DRIFT',
      `${where}: pinned ${window.statementDigestSequence.length} digests for ${span.length} ` +
        `statements. The manifest entry is internally inconsistent and was not regenerated.`,
    )
  }

  for (const [offset, statement] of span.entries()) {
    const actual = normalizedExecutableDigest(statement.raw)
    if (actual !== window.statementDigestSequence[offset]) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_DIGEST_DRIFT',
        `${where}: statement ${startIndex + offset} (position ${offset} in the window) hashes to ` +
          `${actual.slice(0, 16)}…, pinned ${window.statementDigestSequence[offset].slice(0, 16)}…. ` +
          `Its executable content changed, it was replaced by another statement of the same class, ` +
          `or the window's statements were reordered. Comments and whitespace are excluded from ` +
          `this digest, so none of those explains it.`,
      )
    }
  }

  return { window, startIndex, endIndex, statements: span }
}
