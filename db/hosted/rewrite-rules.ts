// db/hosted/rewrite-rules.ts
// TRAIN 5B — the ENUMERATED rewrite set that derives a managed-Supabase variant
// of a canonical prepared package.
//
// ---------------------------------------------------------------------------
// WHY A GENERATOR AND NOT TEN HAND-WRITTEN VARIANTS
// ---------------------------------------------------------------------------
// Train 5A measured that all ten packages of the hosted chain abort unless
// `current_user` has `rolsuper`, which managed Supabase never grants. The naive
// fix is to copy each package and edit the guard. That produces two sources for
// one contract, and the second one drifts the first time somebody patches only
// the original — which is precisely how `grounding_0001` stopped matching
// GR-001 and had to be superseded.
//
// So the canonical files under `db/prepared/**` stay BYTE-IDENTICAL and remain
// the only source of truth. The hosted artefact is DERIVED from them by the
// four rules below, and `db/hosted/hosted-package-manifest.ts` pins both the
// SHA-256 of the source and the exact number of times each rule must fire. A
// rule that silently matches nothing cannot ship: the generator refuses.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY *NOT* REWRITTEN
// ---------------------------------------------------------------------------
// Every property Train 4 verified stays where it was. No rule touches a policy
// predicate's scope columns, an ownership transfer, a REVOKE, a SECURITY
// DEFINER marker, a `search_path` setting, a CHECK, or a self-verification
// block. The four rules address exactly two things: the identity of the role
// allowed to APPLY the package, and the path by which a capability role
// RESOLVES the session actor. Nothing else is in scope, and the manifest's
// expected-count assertions are what keep it that way.

/** One mechanical transformation, with the reason it is allowed to exist. */
export interface HostedRewriteRule {
  /** Stable identifier — used by the manifest's expected-count contract. */
  readonly id: string
  /** Why managed Supabase forces this, in one paragraph an auditor can check. */
  readonly why: string
  /** Applies the rule. MUST report how many times it fired. */
  apply(packageName: string, sql: string): { sql: string; count: number }
}

/* -------------------------------------------------------------------------- */
/* Rule 1 — superuser-precondition                                            */
/* -------------------------------------------------------------------------- */

/**
 * The guard is textually uniform across all nine chain packages: three lines,
 * differing only in the message. Anchoring on the exact shape rather than on
 * the token `rolsuper` is deliberate — a loose match could eat a *different*
 * superuser check that a future package adds for a different reason, and the
 * rewrite would then be removing a guard nobody reviewed.
 */
const SUPERUSER_GUARD =
  /^([ \t]*)IF NOT \(SELECT rolsuper FROM pg_roles WHERE rolname = current_user\) THEN\n[ \t]*RAISE EXCEPTION '((?:[^']|'')*)', current_user;\n[ \t]*END IF;$/gm

const superuserPrecondition: HostedRewriteRule = {
  id: 'superuser-precondition',
  why:
    'Managed Supabase exposes no superuser: the highest role available is `postgres`, which is ' +
    'NOSUPERUSER. The guard is replaced by uellix_bootstrap.assert_hosted_capabilities(), which ' +
    'checks the CONCRETE capabilities the package needs (CREATEROLE, CREATE on the target schemas, ' +
    'membership in the owner role, the auth shim) instead of a role attribute that stands in for ' +
    'them. The substitution is strictly narrower than the original: a superuser passes every ' +
    'capability check, so nothing that used to be refused is now allowed.',
  apply(packageName, sql) {
    let count = 0
    const out = sql.replace(SUPERUSER_GUARD, (_m, indent: string, message: string) => {
      count += 1
      return (
        `${indent}-- HOSTED VARIANT (Train 5B, generated — do not edit by hand).\n` +
        `${indent}-- The superuser check below was replaced by a capability assertion installed by\n` +
        `${indent}-- db/prepared/stella_hosted_0001_managed_role_bootstrap.sql. Original message,\n` +
        `${indent}-- preserved verbatim so the refusal it encoded stays reviewable:\n` +
        `${indent}--   ${message.replace(/''/g, "'")}\n` +
        `${indent}PERFORM uellix_bootstrap.assert_hosted_capabilities('${packageName}');`
      )
    })
    return { sql: out, count }
  },
}

/* -------------------------------------------------------------------------- */
/* Rule 2 — auth-schema-grant                                                 */
/* -------------------------------------------------------------------------- */

const AUTH_SCHEMA_GRANT =
  /^GRANT USAGE ON SCHEMA auth TO (\w+);\nGRANT EXECUTE ON FUNCTION auth\.uid\(\) TO \1;$/gm

const authSchemaGrant: HostedRewriteRule = {
  id: 'auth-schema-grant',
  why:
    'Schema `auth` is owned by supabase_auth_admin and `postgres` holds USAGE WITHOUT GRANT ' +
    'OPTION, so neither grant is issuable on managed Supabase (RR-09, measured in Train 5A). The ' +
    'capability role instead receives EXECUTE on public.uellix_auth_uid(), the SECURITY DEFINER ' +
    'shim the bootstrap installs, owned by the role that ALREADY governs identity in this ' +
    'database. The identity derivation is not duplicated — the shim body is `SELECT auth.uid()` ' +
    'and nothing else — so the objection the original comment raised (a second copy that drifts) ' +
    'does not apply. The role still cannot reach auth.users: each package re-asserts that.',
  apply(_packageName, sql) {
    let count = 0
    const out = sql.replace(AUTH_SCHEMA_GRANT, (_m, role: string) => {
      count += 1
      return (
        '-- HOSTED VARIANT (Train 5B, generated): the two grants this replaces are not issuable\n' +
        '-- on managed Supabase — `postgres` holds USAGE on schema auth WITHOUT GRANT OPTION.\n' +
        '-- EXECUTE on the bootstrap shim is the narrowest equivalent: it resolves the session\n' +
        '-- actor and confers nothing else. auth.users stays unreachable, asserted below.\n' +
        `GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO ${role};`
      )
    })
    return { sql: out, count }
  },
}

/* -------------------------------------------------------------------------- */
/* Rule 3 — auth-uid-precondition                                             */
/* -------------------------------------------------------------------------- */

const AUTH_UID_PRECONDITION = /to_regprocedure\('auth\.uid\(\)'\) IS NULL/g

const authUidPrecondition: HostedRewriteRule = {
  id: 'auth-uid-precondition',
  why:
    'The rewritten bodies resolve the actor through public.uellix_auth_uid(), so the precondition ' +
    'has to observe THAT function rather than only the one it delegates to. The replacement is a ' +
    'CONJUNCTION, not a substitution: both must exist. That makes the hosted precondition strictly ' +
    'stronger than the original — a database with auth.uid() but no bootstrap now refuses, where ' +
    'before it would have proceeded and failed later, at runtime, inside a definer.',
  apply(_packageName, sql) {
    let count = 0
    const out = sql.replace(AUTH_UID_PRECONDITION, () => {
      count += 1
      return "to_regprocedure('public.uellix_auth_uid()') IS NULL OR to_regprocedure('auth.uid()') IS NULL"
    })
    return { sql: out, count }
  },
}

/* -------------------------------------------------------------------------- */
/* Rule 4 — auth-uid-call                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Line eligibility, and why it is expressed as exclusions rather than as a
 * pattern for the call sites.
 *
 * The real call sites are three shapes (`v_actor := auth.uid();`,
 * `actor_id = auth.uid()`, `created_by = auth.uid()`), and matching those three
 * would be over-fitted: a fourth shape added later would be silently skipped,
 * and the package would ship with an unrewritten call that only fails at
 * runtime, inside a SECURITY DEFINER, as an empty result rather than an error.
 *
 * So every occurrence is rewritten EXCEPT on lines that provably are not calls:
 *
 *   - comment lines (`--` before the occurrence) — the historical rationale;
 *   - lines containing a single quote — a RAISE/COMMENT message, or the
 *     `to_regprocedure('auth.uid()')` precondition that rule 3 owns. None of
 *     the genuine call sites contains a quote;
 *   - GRANT/REVOKE lines — that surface belongs to rule 2 alone, and letting
 *     two rules touch it would make the counts unattributable.
 */
function occurrenceIsInsideStringLiteral(line: string, occurrence: number): boolean {
  // Counts UNESCAPED single quotes before the occurrence. In SQL a literal quote
  // inside a string is written `''`, so a doubled pair returns to "outside" and
  // the parity works out. An odd count means the occurrence sits inside a
  // literal — a RAISE message, a COMMENT, or the `to_regprocedure('auth.uid()')`
  // that rule 3 owns.
  let quotes = 0
  for (let i = 0; i < occurrence; i += 1) if (line[i] === "'") quotes += 1
  return quotes % 2 === 1
}

function occurrenceIsEligible(line: string, occurrence: number): boolean {
  const commentStart = line.indexOf('--')
  if (commentStart !== -1 && commentStart < occurrence) return false
  if (occurrenceIsInsideStringLiteral(line, occurrence)) return false

  const trimmed = line.trimStart()
  if (trimmed.startsWith('GRANT ') || trimmed.startsWith('REVOKE ')) return false

  return true
}

const authUidCall: HostedRewriteRule = {
  id: 'auth-uid-call',
  why:
    'A SECURITY DEFINER body and a policy predicate both resolve `auth.uid()` as the CAPABILITY ' +
    'role, not as the session role, so both need schema-auth access that managed Supabase will ' +
    'not grant to a role we created. Routing them through public.uellix_auth_uid() moves that ' +
    'requirement to a single shim whose owner already has it. Actor binding is unchanged: the ' +
    'shim returns the same value auth.uid() would have returned in the same session, and the ' +
    'actor is still derived from the session rather than from an argument.',
  apply(_packageName, sql) {
    let count = 0
    const out = sql
      .split('\n')
      .map((line) => {
        if (!line.includes('auth.uid()')) return line
        // PER OCCURRENCE, not per line. The first version excluded a whole line
        // if it contained ANY single quote, which meant a real call sharing a
        // line with a message — `RAISE NOTICE 'actor=%', auth.uid();` — would be
        // skipped in silence. Adversarial review B found it: no canonical source
        // has that shape today, but "no current source does" is an observation,
        // not an invariant, and the skip would only surface at runtime as a
        // permission error inside a definer.
        return line.replace(/auth\.uid\(\)/g, (match, offset: number) => {
          if (!occurrenceIsEligible(line, offset)) return match
          count += 1
          return 'public.uellix_auth_uid()'
        })
      })
      .join('\n')
    return { sql: out, count }
  },
}

/**
 * The rules, in application order.
 *
 * Order is part of the contract, not an implementation detail: rule 2 consumes
 * the GRANT pair before rule 4 could see it, and rule 3 consumes the
 * `to_regprocedure` literal before rule 4's quote exclusion would have had to
 * carry it alone. Reordering them changes the counts, and the manifest pins the
 * counts, so a reorder cannot pass unnoticed.
 */
export const HOSTED_REWRITE_RULES: readonly HostedRewriteRule[] = [
  superuserPrecondition,
  authSchemaGrant,
  authUidPrecondition,
  authUidCall,
]

export interface HostedRewriteResult {
  readonly sql: string
  /** One entry per rule — including the rules that fired zero times. */
  readonly counts: Record<string, number>
}

/**
 * Applies the whole set to one package.
 *
 * Normalizes CRLF to LF FIRST. `db/prepared/**` is pinned to LF by
 * `.gitattributes`, but the generator must not depend on a checkout honouring
 * it: a CRLF working copy would otherwise make every multi-line rule match zero
 * times and produce a "hosted" package that still carried the superuser guard.
 */
export function rewriteForManagedSupabase(packageName: string, sql: string): HostedRewriteResult {
  let current = sql.replace(/\r\n?/g, '\n')
  const counts: Record<string, number> = {}

  for (const rule of HOSTED_REWRITE_RULES) {
    const result = rule.apply(packageName, current)
    current = result.sql
    counts[rule.id] = result.count
  }

  return { sql: current, counts }
}
