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

import { lexSql } from './sql-statements'
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

interface DynamicExecute {
  /** Everything from `EXECUTE` to its terminator, verbatim. */
  readonly expression: string
  /** The string literals inside it, unescaped. */
  readonly literals: readonly string[]
  /** The code outside those literals, upper-cased. */
  readonly code: string
}

/**
 * Every `EXECUTE` expression in `sql`, at any nesting depth.
 *
 * F-04. The first version collected only the string LITERALS of an EXECUTE,
 * which caught `EXECUTE 'GRANT owner TO CURRENT_USER'` and missed both of the
 * shapes that actually appear in the wild:
 *
 *   EXECUTE 'GRANT uellix_owner TO ' || current_user;
 *   EXECUTE format('GRANT %I TO %I', 'uellix_owner', current_user);
 *
 * In both, the session principal never appears inside a literal — it is an
 * EXPRESSION operand, evaluated at run time. So the expression as a whole is
 * captured, and its code half is inspected separately from its literal half.
 *
 * The expression ends at the first terminator or at the next statement keyword,
 * so a `RAISE` on the following line is not swept into it.
 */
function dynamicExecutes(sql: string): DynamicExecute[] {
  const found: DynamicExecute[] = []

  const walk = (text: string): void => {
    const segments = lexSql(text)
    let collecting: { literals: string[]; code: string[]; raw: string[] } | null = null

    const flush = (): void => {
      if (collecting === null) return
      found.push({
        expression: collecting.raw.join(''),
        literals: collecting.literals,
        code: collecting.code.join(' ').toUpperCase(),
      })
      collecting = null
    }

    for (const segment of segments) {
      if (segment.kind === 'line-comment' || segment.kind === 'block-comment') continue

      if (segment.kind === 'dollar-string') {
        flush()
        walk(segment.dollarBody ?? '')
        continue
      }

      if (segment.kind === 'string') {
        if (collecting !== null) {
          collecting.literals.push(segment.text.slice(1, -1).replace(/''/g, "'"))
          collecting.raw.push(segment.text)
        }
        continue
      }

      if (segment.kind === 'quoted-identifier') {
        if (collecting !== null) collecting.raw.push(segment.text)
        continue
      }

      // code
      let buffer = ''
      for (const token of segment.text.split(/([;\s(),|])/)) {
        const word = token.trim().toUpperCase()
        if (word === 'EXECUTE') {
          flush()
          collecting = { literals: [], code: [], raw: [] }
          buffer = ''
          continue
        }
        if (word === ';' || word === 'RAISE' || word === 'PERFORM' || word === 'RETURN') {
          if (collecting !== null) {
            collecting.code.push(buffer)
            collecting.raw.push(buffer)
          }
          flush()
          buffer = ''
          continue
        }
        buffer += token
      }
      if (collecting !== null && buffer.length > 0) {
        collecting.code.push(buffer)
        collecting.raw.push(buffer)
      }
    }

    flush()
  }

  walk(sql)
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

  for (const execute of dynamicExecutes(sql)) {
    // (a) the whole membership statement sits in one literal.
    for (const literal of execute.literals) {
      const completed = literal.replace(/%[IsL]/g, 'uellix_owner')
      const terminated = completed.trim().endsWith(';') ? completed : `${completed};`
      if (isSessionRoleMembership(terminated)) refuse('dynamic SQL inside this statement', literal)
    }

    // (b) F-04: the principal is an EXPRESSION operand, so it never appears in
    //     a literal at all. The discriminator is structural rather than lexical:
    //     a session-role keyword in the CODE half of an EXECUTE, together with a
    //     membership verb in its LITERAL half, can only be building a membership
    //     statement whose grantee is decided at run time. Prose cannot reach
    //     here — comments are dropped by the lexer, and a RAISE message is not
    //     an operand of EXECUTE.
    const namesSessionPrincipal = SESSION_ROLE_KEYWORDS.some((keyword) =>
      new RegExp(`\\b${keyword}\\b`).test(execute.code),
    )
    if (!namesSessionPrincipal) continue

    const buildsMembership = execute.literals.some((literal) =>
      /\b(GRANT|REVOKE)\b/i.test(literal),
    )
    if (buildsMembership) {
      refuse('dynamic membership construction inside this statement', execute.expression)
    }
  }
}
