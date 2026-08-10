// db/hosted/authority/membership-tripwire.ts
// COMMIT 3 — RT-09. A membership statement may never name the session role.
//
// ---------------------------------------------------------------------------
// WHAT GOES WRONG WITHOUT IT
// ---------------------------------------------------------------------------
// Measured in the 17.6 laboratory (M7): inside an owner window, `CURRENT_USER`
// and `CURRENT_ROLE` resolve to the ELEVATED role and `SESSION_USER` to the
// installer. So `GRANT uellix_owner TO CURRENT_USER`, read on the page, appears
// to grant the installer something it already has. Executed inside a window, it
// grants to whoever the window happens to be acting as — and the resulting
// membership row outlives the window, because nothing revokes a grant the plan
// did not know was made.
//
// The statement is therefore refused outright rather than resolved. There is no
// legitimate use of it in a governed package: every grantee the plan needs is a
// registry role it can name.
//
// ---------------------------------------------------------------------------
// THE HARD HALF: DYNAMIC SQL WITHOUT FALSE POSITIVES
// ---------------------------------------------------------------------------
// The text must also be caught when it only exists at run time, inside
// `EXECUTE`. But the very package that FORBIDS the pattern has to quote it — in
// a comment, and in the RAISE message that explains the refusal. A scanner that
// grepped for `CURRENT_USER` near `GRANT` would fire on its own documentation.
//
// The discriminator is structural, not lexical: in PL/pgSQL, dynamic SQL is the
// operand of `EXECUTE`. A RAISE message is the operand of `RAISE`. A comment is
// not an operand of anything — the lexer has already dropped it. So the scan
// walks code bodies, finds `EXECUTE`, and analyses ONLY the string literals that
// belong to it.

import { lexSql, type SqlSegment } from './sql-statements'
import { parseMembershipStatement, SESSION_ROLE_KEYWORDS } from './membership'
import { AuthorityRefusal } from './window-contract'

/**
 * The three spellings PostgreSQL accepts for "whoever is running this".
 *
 * Re-exported from `./membership` rather than redeclared. Fable's independent
 * review found the cleanup checker and the reachability model each carrying
 * their own membership regex, which had drifted apart; a second copy of this
 * list would be the same defect in miniature.
 */
export { SESSION_ROLE_KEYWORDS }

/**
 * True when `sql` is, at top level, a membership statement naming a session
 * role as grantee or revokee.
 *
 * Unparseable text answers `false` rather than throwing: this is used on the
 * inside of dynamic SQL, where a fragment built by `format()` is often not a
 * complete statement, and a refusal there would be about the fragment rather
 * than about authority.
 */
function isSessionRoleMembership(sql: string): boolean {
  return parseMembershipStatement(sql)?.namesSessionRole === true
}

/** Every string literal that is an operand of an `EXECUTE`, at any nesting depth. */
function dynamicSqlLiterals(sql: string): string[] {
  const found: string[] = []

  const walk = (segments: readonly SqlSegment[]): void => {
    let executePending = false

    for (const segment of segments) {
      switch (segment.kind) {
        case 'line-comment':
        case 'block-comment':
          break

        case 'code': {
          // `EXECUTE` opens a dynamic-SQL expression; the next terminator closes
          // it. `RAISE`, `PERFORM`, an assignment — anything else — closes it
          // too, so a message following an EXECUTE on the next line is not
          // swept up with it.
          for (const token of segment.text.split(/([;\s(),])/)) {
            const word = token.trim().toUpperCase()
            if (word.length === 0) continue
            if (word === 'EXECUTE') {
              executePending = true
            } else if (word === ';' || word === 'RAISE' || word === 'PERFORM' || word === 'RETURN') {
              executePending = false
            }
          }
          break
        }

        case 'string':
          if (executePending) {
            found.push(segment.text.slice(1, -1).replace(/''/g, "'"))
          }
          break

        case 'dollar-string':
          walk(lexSql(segment.dollarBody ?? ''))
          break

        case 'quoted-identifier':
          break
      }
    }
  }

  walk(lexSql(sql))
  return found
}

/**
 * Refuses `sql` if it grants or revokes role membership to a session role,
 * whether written literally or assembled inside dynamic SQL.
 *
 * A dynamic fragment is completed before analysis when it obviously is one:
 * `format('GRANT %I TO SESSION_USER', ...)` is not a parseable statement while
 * `%I` sits where a role name belongs, so the placeholder is replaced with a
 * neutral name. That substitution can only ever make the fragment MORE
 * parseable — it never invents a grantee, which is the half that decides.
 */
export function assertNoSessionRoleGrantee(sql: string): void {
  const refuse = (where: string, offending: string): never => {
    throw new AuthorityRefusal(
      'AUTHORITY_MEMBERSHIP_SELF_REFERENCE',
      `${where} names a session role as grantee or revokee:\n    ${offending.trim().slice(0, 200)}\n` +
        `Measured (lab M7): inside an owner window CURRENT_USER and CURRENT_ROLE resolve to the ` +
        `ELEVATED role, not to the installer, so this grants membership to whoever the window is ` +
        `acting as and leaves a row the plan never recorded and therefore never revokes. Name the ` +
        `registry role instead.`,
    )
  }

  if (isSessionRoleMembership(sql)) refuse('this statement', sql)

  for (const literal of dynamicSqlLiterals(sql)) {
    const completed = literal.replace(/%[IsL]/g, 'uellix_owner')
    const terminated = completed.trim().endsWith(';') ? completed : `${completed};`
    if (isSessionRoleMembership(terminated)) refuse('dynamic SQL inside this statement', literal)
  }
}
