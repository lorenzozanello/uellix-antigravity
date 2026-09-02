// db/hosted/authority/membership.ts
// COMMIT 3 — ONE structural reading of a role-membership statement.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS (FABLE F2, AND THE DRIFT UNDERNEATH IT)
// ---------------------------------------------------------------------------
// An independent read-only review found that the cleanup checker and the
// reachability model each carried their OWN regex for membership, and that both
// required the statement to contain `WITH`. Measured in the disposable 17.6 lab
// (image 17.6.1.143, network none, destroyed afterwards):
//
//   GRANT lab_cap TO lab_owner;
//     -> admin_option = f, inherit_option = f, set_option = TRUE
//     -> pg_has_role('lab_owner','lab_cap','SET') = TRUE
//
// A bare GRANT confers the option that decides elevation. Both checkers were
// blind to it. Neither was blind by accident: they were written at different
// times, against different examples, and drifted — which is exactly the failure
// the structural identity layer exists to remove, reintroduced one layer down.
//
// So there is now one parser, built on `parseStatementIdentity`, and the
// tripwire, the cleanup checker and the reachability model all consume it. A
// fourth consumer that wants its own regex is a defect by construction.
//
// ---------------------------------------------------------------------------
// WHAT THE DEFAULTS MODEL, AND WHY THEY ARE NOT GUESSES
// ---------------------------------------------------------------------------
// `WITH` is optional and each option has a default. `set_option` defaults TRUE
// (measured above) — which is the dangerous direction, so modelling it wrongly
// would under-report elevation. `inherit_option` follows the MEMBER's
// `rolinherit` attribute and therefore cannot be known from the statement text
// alone; it is reported as `null` rather than assumed, because a checker that
// invented a value here would be asserting something the text does not say.

import { parseStatementIdentity, UnsupportedStructuralIdentityError } from './structural-identity'
import { lexSql } from './sql-statements'

export interface MembershipStatement {
  readonly kind: 'grant' | 'revoke'
  /** Roles whose privileges are conferred. Folded. */
  readonly roles: readonly string[]
  /** Grantees / revokees. Folded, except session-role keywords, kept upper. */
  readonly members: readonly string[]
  /** Whether the member may `SET ROLE` into the role. Defaults TRUE (measured). */
  readonly setOption: boolean
  /** `null` when the statement does not say — it follows the member's rolinherit. */
  readonly inheritOption: boolean | null
  readonly adminOption: boolean
  /**
   * True for `REVOKE ADMIN OPTION FOR r FROM m` and `GRANT OPTION FOR`.
   *
   * These do NOT remove the membership — they narrow it. A cleanup checker that
   * treated one as a release would report a window balanced while the member
   * still held SET on the role, which is the whole thing the checker exists to
   * catch.
   */
  readonly optionOnly: boolean
  /** True when any member is CURRENT_USER, SESSION_USER or CURRENT_ROLE. */
  readonly namesSessionRole: boolean
}

export const SESSION_ROLE_KEYWORDS: readonly string[] = [
  'CURRENT_USER',
  'SESSION_USER',
  'CURRENT_ROLE',
]

const SESSION_ROLE_SET = new Set(SESSION_ROLE_KEYWORDS)

/** Reads the `WITH ...` option list, if present. Absent options keep their default. */
function readOptions(sql: string): {
  setOption: boolean
  inheritOption: boolean | null
  adminOption: boolean
} {
  // Only the CODE segments are searched, so a `WITH SET FALSE` inside a RAISE
  // message cannot flip an option.
  const code = lexSql(sql)
    .filter((s) => s.kind === 'code')
    .map((s) => s.text)
    .join(' ')
    .toUpperCase()

  const read = (name: string): boolean | null => {
    const match = new RegExp(`\\b${name}\\s+(TRUE|FALSE)\\b`).exec(code)
    if (match !== null) return match[1] === 'TRUE'
    // The legacy spelling: `WITH ADMIN OPTION` with no TRUE/FALSE.
    if (new RegExp(`\\bWITH\\s+${name}\\s+OPTION\\b`).test(code)) return true
    return null
  }

  return {
    setOption: read('SET') ?? true,
    inheritOption: read('INHERIT'),
    adminOption: read('ADMIN') ?? false,
  }
}

/**
 * Parses a role-membership statement, or returns `null` if `sql` is not one.
 *
 * `null` rather than a throw: callers routinely walk mixed statement streams
 * and "this is a privilege grant, not a membership grant" is a normal answer,
 * not an error. An unmodelled statement form still throws, from the identity
 * layer, because that IS an error.
 */
export function parseMembershipStatement(sql: string): MembershipStatement | null {
  let identity
  try {
    identity = parseStatementIdentity(sql)
  } catch (error) {
    if (error instanceof UnsupportedStructuralIdentityError) return null
    throw error
  }

  if (
    identity.statementClass !== 'grant-membership' &&
    identity.statementClass !== 'revoke-membership'
  ) {
    return null
  }

  const code = lexSql(sql)
    .filter((seg) => seg.kind === 'code')
    .map((seg) => seg.text)
    .join(' ')
    .toUpperCase()
  const optionOnly = /\b(ADMIN|GRANT)\s+OPTION\s+FOR\b/.test(code)

  const roles = identity.operands[0].split('+').filter((r) => r.length > 0)
  const members = identity.operands[1].split('+').filter((r) => r.length > 0)
  const options = readOptions(sql)

  return {
    kind: identity.statementClass === 'grant-membership' ? 'grant' : 'revoke',
    roles,
    members,
    optionOnly,
    ...options,
    namesSessionRole: members.some((m) => SESSION_ROLE_SET.has(m.toUpperCase())),
  }
}
