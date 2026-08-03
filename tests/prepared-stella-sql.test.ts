// tests/prepared-stella-sql.test.ts
// WS3b U1: offline sanity lint for the PREPARED (not applied) stella_* SQL in
// db/prepared/. Sibling of lib/grounding/__tests__/prepared-sql.test.ts (which
// covers the grounding_* scripts) — kept in its own file because db/prepared
// is not a test directory and the grounding test is owned by WS5.
//
// This is intentionally a basic structural lint — balanced parentheses,
// terminated statements, expected/forbidden keywords — not a Postgres parse.
// Full validation against a real database is part of the external gate G2
// (docs/ops/gates/G2_PACKAGE.md).
//
// Extended 2026-07-31 (G2 pre-execution hardening) with assertions for:
// explicit search_path, public-qualified objects, precondition + shape guards,
// convergent reconciliation, and transaction compatibility.

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

/** Strip -- line comments, block comments and single-quoted strings. */
function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
}

/**
 * Additionally collapse $$-quoted DO bodies so that ';' splitting does not
 * break statements apart mid-procedure. The stella_0002/0003 scripts use DO $$
 * blocks (precondition guards, shape guard, idempotent reconciliation).
 */
function stripDollarBodies(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$body$$')
}

function statements(sql: string): string[] {
  return stripDollarBodies(stripCommentsAndStrings(sql))
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function expectBalancedParens(code: string) {
  let depth = 0
  for (const ch of code) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    expect(depth).toBeGreaterThanOrEqual(0)
  }
  expect(depth).toBe(0)
}

// Destructive statements are forbidden against PRE-EXISTING tables. The only
// documented exceptions in this package are: DROP TRIGGER / REVOKE on
// stella_interactions (0002 hardening + rollback) and DROP TABLE of the NEW
// stella_suggestion_decisions table (0003 rollback).
function expectNoDestructiveStatements(code: string) {
  // [\w.]+ (not \w+): `\w` does not cross the dot, so the qualified form
  // `ALTER TABLE public.stella_interactions DROP COLUMN ...` would slip past a
  // \w+ pattern — and stella_0002 is exactly the script that touches a
  // pre-existing table holding audit data.
  expect(code).not.toMatch(/\b(DROP SCHEMA|DELETE FROM|DROP EXTENSION)\b/i)
  expect(code).not.toMatch(/ALTER TABLE\s+[\w."]+\s+DROP COLUMN/i)
  expectNoTruncateCommand(code)
}

/**
 * TRUNCATE plays three unrelated roles in this package, so banning the bare
 * word — as this helper originally did — would forbid the very defence that
 * stella_0002b exists to add:
 *
 *   1. trigger EVENT    `BEFORE TRUNCATE ON t ... FOR EACH STATEMENT`  (the guard)
 *   2. privilege NAME   `REVOKE TRUNCATE, REFERENCES, TRIGGER ON t ...` (removing it)
 *   3. COMMAND          `TRUNCATE TABLE t`                              (destructive)
 *
 * Only (3) is forbidden, and only (3) can begin a statement — as a command
 * TRUNCATE is always the first token. Classifying by statement position is
 * therefore stricter than a substring ban, not looser: it still rejects every
 * executable TRUNCATE while allowing the two declarative uses.
 */
function expectNoTruncateCommand(code: string) {
  const offenders = code
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^TRUNCATE\b/i.test(s))
  expect(offenders, `TRUNCATE used as a command: ${offenders.join(' | ')}`).toEqual([])
}

/**
 * DDL hidden inside a dynamic `EXECUTE` is invisible to assertions based on
 * `code` (string literals are blanked) and to any literal extractor
 * (`EXECUTE format(...)`, `EXECUTE $q$...$q$`, `EXECUTE v_sql`).
 * The stella_* scripts must contain no dynamic EXECUTE at all — the only
 * legitimate occurrence is the `EXECUTE FUNCTION` of a CREATE TRIGGER.
 */
function expectNoExecutedDdl(sql: string) {
  // Strip comments first: prose like "EXECUTE is granted by 0039_..." is not
  // a dynamic EXECUTE. `EXECUTE FUNCTION|PROCEDURE` is CREATE TRIGGER syntax,
  // not dynamic SQL. The whitespace must live INSIDE the lookahead — with
  // `EXECUTE\s*(?!FUNCTION)` the engine backtracks \s* to empty and the
  // lookahead sees " FUNCTION", so every legitimate trigger clause matches.
  //
  // One further form is admitted: `EXECUTE '<fixed literal>'`. After
  // stripCommentsAndStrings a genuine single-quoted literal collapses to `''`,
  // so this lookahead passes ONLY when the argument was a self-contained
  // literal in the source. `EXECUTE v_sql` and `EXECUTE format(...)` fail here.
  //
  // `EXECUTE 'x' || ident` does NOT: after blanking it reads `EXECUTE '' || …`,
  // which this lookahead admits by construction. An earlier comment claimed
  // otherwise — measured against the real helper, it does not flag. This
  // function's job is "nothing DYNAMIC is EXECUTEd"; proving the literal is not
  // then CONCATENATED is expectExecutedLiteralsTerminated(), below, which every
  // caller of this helper must also invoke.
  //
  // The admitted form exists because stella_0002b needs to defer PARSING (not
  // composition) of `REVOKE MAINTAIN`, a syntax error before PostgreSQL 17; the
  // literal it executes is pinned by its own test.
  //
  // `EXECUTE ON` is also admitted, and it is not a loophole: that is the
  // PRIVILEGE NAME in `GRANT EXECUTE ON FUNCTION …`, `REVOKE EXECUTE ON
  // FUNCTION …` and `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS
  // …`. The token can never begin a dynamic statement — `EXECUTE ON` is not
  // valid PL/pgSQL — so admitting it removes a false positive without widening
  // what this helper proves. Added when stella_0004 landed, which is the first
  // prepared script to grant or revoke the EXECUTE privilege.
  expect(
    stripCommentsAndStrings(sql).match(/\bEXECUTE\b(?!\s*(?:FUNCTION\b|PROCEDURE\b|ON\b|''))/gi),
  ).toBeNull()
}

/**
 * Every executed literal must be followed IMMEDIATELY by `;`, `INTO` or
 * `USING`, so nothing can be appended to it — on that line or a later one.
 *
 * expectNoExecutedDdl() admits `EXECUTE '<literal>'` and therefore also admits
 * `EXECUTE '<literal>' || ident`. This closes that, and it is deliberately a
 * SHARED helper: an earlier revision made the check inline in the
 * stella_0003_rollback block and its own docstring then claimed the guarantee
 * held "per file" — while stella_0002b, which uses the same construct, had no
 * such check at all. A verification declared and not performed, in the file
 * that polices exactly that.
 */
function expectExecutedLiteralsTerminated(sql: string) {
  const code = stripCommentsAndStrings(sql)
  const executes = code.match(/\bEXECUTE\s+''/g) ?? []
  // `USING` is admitted alongside `;` and `INTO`: it passes PARAMETERS to a
  // fixed literal ($1, $2 …), which is the safe form — it cannot alter the
  // statement text. No prepared script uses it today; excluding it would make
  // this helper reject a legitimate construct the moment one did.
  const terminated = code.match(/\bEXECUTE\s+''\s*(?:;|INTO\b|USING\b)/g) ?? []
  expect(terminated, 'an executed literal is concatenated or continued').toHaveLength(
    executes.length,
  )
  return executes.length
}

/**
 * The SQL text of every `EXECUTE '<fixed literal>'` in the script, read from
 * the RAW source — `stripCommentsAndStrings` blanks literals by design, so it
 * cannot answer "what does this EXECUTE actually run?".
 *
 * Comments are dropped first — including TRAILING ones. An earlier revision
 * stripped only whole-line comments and argued that a trailing comment could
 * not produce a false positive "because a match requires EXECUTE followed by a
 * complete literal". That reasoning is wrong: `END IF;  -- unlike EXECUTE
 * 'DROP TABLE public.foo'` has exactly that shape and would be reported as an
 * executed statement. So scan each line for the first `--` that is OUTSIDE a
 * single-quoted string and cut there.
 *
 * Pair with expectNoExecutedDdl(), which is what proves nothing else is
 * EXECUTEd: together they say "only these literals run, and nothing dynamic".
 */
function stripAllComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      let inString = false
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") {
          // '' inside a string is an escaped quote, not a close-then-open.
          if (inString && line[i + 1] === "'") i++
          else inString = !inString
        } else if (!inString && line[i] === '-' && line[i + 1] === '-') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

function executedStatements(sql: string): string[] {
  return [...stripAllComments(sql).matchAll(/\bEXECUTE\s+'((?:[^']|'')*)'/gi)].map((m) =>
    m[1].replace(/''/g, "'"),
  )
}

describe('every prepared stella_* script — cross-cutting EXECUTE invariants', () => {
  // The SQL header used to claim expectExecutedLiteralsTerminated() was
  // "applied to EVERY prepared script". Measured, it was called from four
  // describes and NOT from the stella_0002 / stella_0002b rollbacks. That is
  // the same overclaim the helper's own docstring criticises, one scope up.
  // Sweep the directory instead of trusting per-describe discipline.
  const stellaScripts = readdirSync(PREPARED)
    .filter((f) => /^stella_.*\.sql$/.test(f))
    .sort()

  // The inventory below is a TRIPWIRE, not the driver. The `it.each` that
  // follows iterates `stellaScripts` — the directory listing — so a new
  // stella_0004_*.sql is swept the moment it lands. An earlier revision drove
  // the `it.each` from a hardcoded copy of this list: adding a script would
  // have failed ONLY this toEqual, the natural repair is to extend the array it
  // names, and the new script would have shipped unswept while the SQL header
  // still claimed coverage — the very overclaim this block was written to
  // close, reinstated in latent form inside its own fix.
  it('the inventory matches the directory (tripwire for a new stella_* script)', () => {
    expect(stellaScripts).toEqual([
      'stella_0002_interactions_hardening.sql',
      'stella_0002_rollback.sql',
      'stella_0002b_append_only_truncate_hardening.sql',
      'stella_0002b_rollback.sql',
      'stella_0003_rollback.sql',
      'stella_0003_suggestion_decisions.sql',
      'stella_0004_role_separation.sql',
      'stella_0004_rollback.sql',
      // The runtime cutover ships as two halves for a privilege reason, not a
      // stylistic one: `uellix_owner` has no CREATEROLE and does not own the
      // `drizzle` schema, so ALTER ROLE ... SET, ALTER SCHEMA ... OWNER and
      // ALTER DEFAULT PRIVILEGES FOR ROLE postgres cannot run on the
      // owner-scoped path. `0005b` is the separate, explicitly administrative
      // script that carries exactly those three.
      'stella_0005_rollback.sql',
      'stella_0005_runtime_cutover.sql',
      'stella_0005b_admin_bootstrap.sql',
      'stella_0005b_rollback.sql',
      // 0005c rescopes the three stella_0005 INSERT policies to `uellix_app`
      // and revokes the pre-cutover INSERT grants of authenticated /
      // service_role on the two append-only tables (reaudit finding M1).
      'stella_0005c_rollback.sql',
      'stella_0005c_runtime_policy_scope.sql',
      // 0005d repairs the storage SECURITY DEFINER path stella_0004 broke:
      // uellix_owner owns can_*_evidence_object but had no USAGE on schema
      // storage, so every evidence object operation was silently refused.
      'stella_0005d_rollback.sql',
      'stella_0005d_storage_definer_repair.sql',
      // 0006..0010 are the public-capability campaign: five INDEPENDENT
      // packages, one per surface that has been failing closed since the
      // cutover. They deliberately share no role, no function, no policy and
      // no grant — see docs/ops/DATABASE_CAPABILITY_MODEL.md. All five are
      // DESIGN ONLY and none has been applied to any stack.
      'stella_0006_invitation_capability.sql',
      'stella_0006_rollback.sql',
      'stella_0007_public_verification_capability.sql',
      'stella_0007_rollback.sql',
      'stella_0008_rollback.sql',
      'stella_0008_stripe_webhook_identity.sql',
      'stella_0009_public_lead_capability.sql',
      'stella_0009_rollback.sql',
      'stella_0010_organization_bootstrap_capability.sql',
      'stella_0010_rollback.sql',
    ])
  })

  it.each(stellaScripts)(
    '%s: nothing dynamic is EXECUTEd, and no executed literal is concatenated',
    (file) => {
      const sql = read(file)
      expectNoExecutedDdl(sql)
      expectExecutedLiteralsTerminated(sql)
    },
  )
})

/** No table in this package may be reachable by anon or PUBLIC. */
function expectNoAnonOrPublicGrants(code: string) {
  expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\banon\b/i)
  expect(code).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\bPUBLIC\b/i)
}

describe('db/prepared/stella_0002_interactions_hardening.sql', () => {
  const raw = read('stella_0002_interactions_hardening.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses outside comments and strings', () => {
    expectBalancedParens(code)
  })

  it('terminates every statement with a semicolon', () => {
    expect(code.trim().endsWith(';')).toBe(true)
    expect(statements(raw).length).toBeGreaterThan(3)
  })

  it('every statement starts with a known keyword', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP TRIGGER|DO|REVOKE|COMMENT|END|BEGIN|RAISE|IF|SELECT)\b/i)
    }
  })

  // --- hardening: search_path + qualification -----------------------------

  it('pins search_path to public as its first statement', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
  })

  it('schema-qualifies every object it touches', () => {
    expect(code).toMatch(/ON public\.stella_interactions/i)
    expect(code).toMatch(/ALTER TABLE public\.stella_interactions/i)
    expect(code).toMatch(/EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i)
    // no unqualified references to the target table remain in live statements
    expect(code).not.toMatch(/ON stella_interactions\b/i)
  })

  // --- hardening: guards ---------------------------------------------------

  it('guards on uellix_forbid_mutation existing before attaching anything', () => {
    expect(code).toMatch(/uellix_forbid_mutation/)
    expect(raw).toMatch(/0030_immutability/)
    // guard block appears before the CREATE TRIGGER statement
    expect(code.indexOf('RAISE EXCEPTION')).toBeGreaterThan(-1)
    expect(code.indexOf('RAISE EXCEPTION')).toBeLessThan(code.indexOf('CREATE TRIGGER'))
  })

  it('also guards that the target table exists, with an actionable message', () => {
    expect(raw).toMatch(/to_regclass\('public\.stella_interactions'\) IS NULL/)
    expect(raw).toMatch(/stella_0002 aborted:/)
    expect(raw).toMatch(/migraciones base al día/)
  })

  it('is compatible with single-transaction execution (no CONCURRENTLY)', () => {
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('points at the source-of-truth ADR', () => {
    expect(raw).toMatch(/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR\.md/)
  })

  // --- unchanged semantics -------------------------------------------------

  it('attaches the append-only trigger for UPDATE and DELETE, 0030 style', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON public\.stella_interactions/i)
    expect(code).toMatch(/CREATE TRIGGER trg_stella_interactions_append_only\s+BEFORE UPDATE OR DELETE ON public\.stella_interactions\s+FOR EACH ROW EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i)
  })

  it('revokes UPDATE and DELETE from authenticated (fixes 0033:50)', () => {
    expect(code).toMatch(/REVOKE UPDATE, DELETE ON public\.stella_interactions FROM authenticated/i)
    // it must NOT touch SELECT/INSERT — the append-only grants stay
    expect(code).not.toMatch(/REVOKE[^;]*\bSELECT\b/i)
    expect(code).not.toMatch(/REVOKE[^;]*\bINSERT\b/i)
  })

  it('reconciles the stella_role CHECK to the 6-role set from db/schema.ts, idempotently', () => {
    expect(raw).toMatch(/stella_interactions_stella_role_check/)
    for (const role of ['advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant']) {
      expect(raw).toContain(`'${role}'`)
    }
    // idempotence: guarded by inspecting the current constraint definition
    expect(raw).toMatch(/pg_get_constraintdef/)
    expect(raw).toMatch(/IF current_def IS NULL/)
  })

  it('matches CHECK roles as QUOTED literals, not bare substrings (audit FIX 4)', () => {
    // pg_get_constraintdef renders literals quoted ('advisor'::character
    // varying ...); a bare LIKE '%advisor%' would be satisfied by a
    // superstring role like 'super_advisor'. The DO block must compare
    // against the quoted form — inside the $$ body that is ''advisor''.
    for (const role of ['advisor', 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer', 'audit_assistant']) {
      expect(raw).toContain(`NOT LIKE '%''${role}''%'`)
    }
    // and no remaining bare-substring comparisons on current_def
    expect(raw).not.toMatch(/current_def NOT LIKE '%[a-z_]+%'/)
  })

  it('creates no tables and contains no destructive statements against pre-existing tables', () => {
    expect(code).not.toMatch(/CREATE TABLE/i)
    expect(code).not.toMatch(/DROP TABLE/i)
    expectNoDestructiveStatements(code)
    expectNoExecutedDdl(raw)
    expectExecutedLiteralsTerminated(raw)
  })

  it('flags itself as prepared-only and gate G2 in comments', () => {
    expect(raw).toMatch(/NOT A MIGRATION/)
    expect(raw).toMatch(/G2/)
  })
})

describe('db/prepared/stella_0002_rollback.sql', () => {
  const raw = read('stella_0002_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('is consistent with the forward script: search_path and public-qualified', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(code).toMatch(/ON public\.stella_interactions/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('detaches the trigger without dropping the shared function', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON public\.stella_interactions/i)
    expect(code).not.toMatch(/DROP FUNCTION/i)
  })

  it('restores the 0033 grants and documents that this is BUG-compatible', () => {
    expect(code).toMatch(/GRANT UPDATE, DELETE ON public\.stella_interactions TO authenticated/i)
    expect(raw).toMatch(/BUG-COMPATIBLE/i)
  })

  it('does not revert the stella_role CHECK (documented decision)', () => {
    expect(code).not.toMatch(/stella_role/i) // no live statement touches it
    expect(raw).toMatch(/stella_role CHECK reconciliation is intentionally NOT reverted/)
  })

  it('contains no destructive statements', () => {
    expect(code).not.toMatch(/\b(DROP TABLE|DROP SCHEMA|TRUNCATE|DELETE FROM|DROP EXTENSION)\b/i)
  })
})

describe('db/prepared/stella_0003_suggestion_decisions.sql', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses outside comments and strings', () => {
    expectBalancedParens(code)
  })

  it('terminates every statement with a semicolon', () => {
    expect(code.trim().endsWith(';')).toBe(true)
    expect(statements(raw).length).toBeGreaterThan(4)
  })

  it('every statement starts with a known DDL keyword (incl. DROP TRIGGER)', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP POLICY|DROP TRIGGER|GRANT|REVOKE|DO|COMMENT)\b/i)
    }
  })

  // --- hardening: search_path + qualification -----------------------------

  it('pins search_path to public as its first statement', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
  })

  it('schema-qualifies every object it creates or references', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.stella_suggestion_decisions/i)
    expect(code).toMatch(/REFERENCES public\.organizations\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.projects\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.stella_interactions\(id\)/i)
    expect(code).toMatch(/REFERENCES public\.users\(id\)/i)
    expect(code).toMatch(/ALTER TABLE public\.stella_suggestion_decisions ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/public\.current_user_org_ids\(\)/)
    expect(code).toMatch(/public\.current_user_is_super_admin\(\)/)
  })

  // --- hardening: guards ---------------------------------------------------

  it('guards FK targets and RLS helpers before any DDL', () => {
    const firstGuard = code.indexOf('RAISE EXCEPTION')
    expect(firstGuard).toBeGreaterThan(-1)
    expect(firstGuard).toBeLessThan(code.indexOf('CREATE TABLE'))
    expect(raw).toMatch(/to_regclass\('public\.organizations'\)/)
    expect(raw).toMatch(/to_regclass\('public\.stella_interactions'\)/)
    expect(raw).toMatch(/to_regprocedure\('public\.current_user_org_ids\(\)'\)/)
  })

  it('aborts instead of no-op when the table pre-exists with an incompatible shape', () => {
    expect(raw).toMatch(/INCOMPATIBLE shape/)
    expect(raw).toMatch(/information_schema\.columns/)
    expect(raw).toMatch(/stella_0003 aborted:/)
    // the guard lists every contract column
    for (const col of [
      'organization_id', 'project_id', 'interaction_id', 'suggestion_key',
      'decision', 'previous_value_hash', 'applied_text', 'rejection_reason',
      'decided_by', 'decided_at',
    ]) {
      expect(raw).toContain(`('${col}'`)
    }
  })

  it('never ALTERs columns of a pre-existing table', () => {
    expect(code).not.toMatch(/ALTER TABLE[^;]*\b(DROP COLUMN|ALTER COLUMN)\b/i)
  })

  it('reports only column names and types in guard errors, never row data', () => {
    expect(raw).toMatch(/Missing or mismatched columns/)
    expect(raw).not.toMatch(/SELECT \* FROM public\.stella_suggestion_decisions/i)
  })

  // --- hardening: convergence + transaction --------------------------------

  it('reconciles CHECK constraints convergently, not only via CREATE TABLE IF NOT EXISTS', () => {
    for (const name of [
      'stella_suggestion_decisions_decision_check',
      'stella_suggestion_decisions_prev_hash_check',
    ]) {
      expect(raw).toMatch(new RegExp(`ADD CONSTRAINT ${name}`))
    }
    expect(raw).toMatch(/pg_constraint/)
  })

  it('is compatible with single-transaction execution (no CONCURRENTLY)', () => {
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('points at the source-of-truth ADR instead of db/schema.ts', () => {
    expect(raw).toMatch(/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR\.md/)
    expect(raw).toMatch(/deliberately absent from db\/schema\.ts/)
  })

  // --- unchanged semantics -------------------------------------------------

  it('creates the stella_suggestion_decisions table with the agreed shape', () => {
    expect(code).toMatch(/id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/i)
    expect(code).toMatch(/decided_at timestamptz DEFAULT now\(\) NOT NULL/i)
    for (const column of ['suggestion_key', 'previous_value_hash', 'applied_text', 'rejection_reason']) {
      expect(code).toContain(column)
    }
  })

  it('constrains decision to the 4 allowed values', () => {
    expect(code).toMatch(/CHECK \(decision IN \('', '', '', ''\)\)/) // strings are blanked by the lint stripper
    for (const value of ['accepted', 'accepted_edited', 'rejected', 'undone']) {
      expect(raw).toContain(`'${value}'`)
    }
  })

  it('enforces hash-not-content: previous_value_hash constrained to sha256 hex', () => {
    expect(raw).toMatch(/previous_value_hash IS NULL OR previous_value_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
    expect(raw).toMatch(/raw previous text is never persisted/i)
  })

  it('enables RLS with a SELECT-only org policy mirroring 002_stella_interactions_rls', () => {
    expect(code).toMatch(/DROP POLICY IF EXISTS "stella_suggestion_decisions_select"/i)
    expect(code).toMatch(/CREATE POLICY "stella_suggestion_decisions_select"/i)
    expect(code).toMatch(/organization_id = ANY\(public\.current_user_org_ids\(\)\)/)
    // no client-side INSERT/UPDATE/DELETE policies at all
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/i)
  })

  it('revokes ALL from every role before granting anything back', () => {
    // Hardened 2026-08-01. Enumerating privileges to revoke is a losing game:
    // it cannot anticipate what a future PostgreSQL or Supabase bootstrap adds
    // to ALTER DEFAULT PRIVILEGES. Inheriting `Dxtm` that way is exactly what
    // left the four pre-existing audit tables TRUNCATE-able. REVOKE ALL is the
    // only formulation that cannot inherit a surplus it was not written for.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(code, `missing REVOKE ALL for ${role}`).toMatch(
        new RegExp(`REVOKE ALL ON public\\.stella_suggestion_decisions FROM ${role}`, 'i'),
      )
    }
  })

  it('grants authenticated SELECT only, and service_role nothing', () => {
    expect(code).toMatch(/GRANT SELECT ON public\.stella_suggestion_decisions TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL)\b[^;]*TO authenticated/i)
    // service_role gets no grant at all: the only writer is the Drizzle client,
    // which connects as the table OWNER, whose access comes from ownership.
    expect(code).not.toMatch(/GRANT[^;]*TO service_role/i)
  })

  it('adds both append-only triggers so the table never has the 0002b gap', () => {
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_append_only\s+BEFORE UPDATE OR DELETE ON public\.stella_suggestion_decisions\s+FOR EACH ROW EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate\s+BEFORE TRUNCATE ON public\.stella_suggestion_decisions\s+FOR EACH STATEMENT EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    // Idempotent: each CREATE is preceded by its own DROP ... IF EXISTS.
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_append_only/i)
    expect(code).toMatch(/DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_no_truncate/i)
    // And it must guard the function it depends on.
    expect(raw).toMatch(/uellix_forbid_mutation\(\) not found/)
  })

  it('never grants to anon or PUBLIC, and revokes anon defensively', () => {
    expectNoAnonOrPublicGrants(code)
    expect(code).toMatch(/REVOKE ALL ON public\.stella_suggestion_decisions FROM anon/i)
  })

  it('reconciles CHECK definitions, not just constraint names (audit M1)', () => {
    // A constraint carrying the right NAME with a stale DEFINITION (e.g. a
    // decision_check missing 'undone') must be rebuilt, not skipped.
    expect(raw).toMatch(/pg_get_constraintdef/)
    for (const value of ['accepted', 'accepted_edited', 'rejected', 'undone']) {
      // position(), not LIKE: `_` is a LIKE wildcard, so the old form also
      // accepted a stale 'acceptedXedited'. See MIN-A.
      expect(raw).toContain(`position('''${value}''' in def)`)
    }
    expect(raw).toMatch(/DROP CONSTRAINT stella_suggestion_decisions_decision_check/)
    expect(raw).toMatch(/DROP CONSTRAINT stella_suggestion_decisions_prev_hash_check/)
  })

  it('pins the ANCHORED hash regex, not just the character class (audit N3)', () => {
    // Matching the bare class would accept a stale UNANCHORED constraint
    // ('[0-9a-f]{64}' without ^$), which admits "<raw text><64 hex><more>" —
    // exactly the leak the hash-not-content invariant exists to prevent.
    expect(raw).toContain("position('''^[0-9a-f]{64}$''' in def)")
  })

  it('guards PK, id default and unexpected NOT NULL columns (audit M2)', () => {
    expect(raw).toMatch(/without a PRIMARY KEY/)
    expect(raw).toMatch(/has no DEFAULT/)
    expect(raw).toMatch(/unexpected NOT NULL columns without a default/)
  })

  it('creates the org+decided_at and interaction_id indexes', () => {
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_org_decided_at\s+ON public\.stella_suggestion_decisions \(organization_id, decided_at\)/i)
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_interaction_id\s+ON public\.stella_suggestion_decisions \(interaction_id\)/i)
  })

  it('contains no destructive statements', () => {
    // DROP TABLE is checked here rather than in the shared helper: the 0003
    // ROLLBACK legitimately drops the table this script creates.
    expect(code).not.toMatch(/\bDROP TABLE\b/i)
    expectNoDestructiveStatements(code)
    expectNoExecutedDdl(raw)
    expectExecutedLiteralsTerminated(raw)
  })
})

describe('db/prepared/stella_0003_rollback.sql', () => {
  const raw = read('stella_0003_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('is consistent with the forward script: search_path and public-qualified', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('drops exactly the one NEW table this package creates, nothing pre-existing', () => {
    // The DROP is no longer a top-level statement: it lives inside the guard's
    // DO block, as the fixed literal of an EXECUTE (see the structural-safety
    // block below). `code` blanks string literals, so the target is read from
    // executedStatements(raw) instead of from a DROP TABLE match.
    expect(executedStatements(raw).filter((s) => /^DROP\b/i.test(s))).toEqual([
      'DROP TABLE public.stella_suggestion_decisions',
    ])
    expect(code).not.toMatch(/\b(DROP SCHEMA|DELETE FROM|DROP EXTENSION|DROP FUNCTION)\b/i)
    // TRUNCATE is named in the operator-facing NOTICEs ("the append-only
    // triggers forbid UPDATE/DELETE/TRUNCATE"), so classify by position rather
    // than banning the word: only a TRUNCATE *command* is forbidden.
    expectNoTruncateCommand(code)
  })

  it('documents the flag precondition and export-first warning', () => {
    expect(raw).toMatch(/STELLA_DECISIONS_PERSISTENCE_ENABLED/)
    expect(raw).toMatch(/[Ee]xport/)
  })
})

// ---------------------------------------------------------------------------
// stella_0002b — append-only TRUNCATE hardening (added 2026-08-01)
// ---------------------------------------------------------------------------
// Repairs the privilege surplus that Supabase's ALTER DEFAULT PRIVILEGES leaves
// on every table created in `public` (`authenticated=Dxtm`), which made the four
// append-only tables TRUNCATE-able. Demonstrated on a real PostgreSQL 17 before
// this script was written.

/** The four tables whose append-only guarantee is documented and load-bearing. */
const APPEND_ONLY_TABLES = [
  'stella_interactions',
  'audit_logs',
  'sroi_calculation_runs',
  'sroi_calculation_line_items',
] as const

/** Row-level UPDATE/DELETE guards that must survive 0002b untouched. */
const ROW_TRIGGERS = [
  'trg_stella_interactions_append_only',
  'trg_audit_logs_append_only',
  'trg_sroi_runs_append_only',
  'trg_sroi_line_items_append_only',
] as const

/** Statement-level TRUNCATE guards that 0002b introduces. */
const TRUNCATE_TRIGGERS = [
  ['stella_interactions', 'trg_stella_interactions_no_truncate'],
  ['audit_logs', 'trg_audit_logs_no_truncate'],
  ['sroi_calculation_runs', 'trg_sroi_calculation_runs_no_truncate'],
  ['sroi_calculation_line_items', 'trg_sroi_calculation_line_items_no_truncate'],
] as const

describe('db/prepared/stella_0002b_append_only_truncate_hardening.sql', () => {
  const raw = read('stella_0002b_append_only_truncate_hardening.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminates every statement', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('declares an explicit search_path and documents single-transaction use', () => {
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('every statement starts with a known keyword', () => {
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|CREATE|DROP TRIGGER|DO|REVOKE|COMMENT)\b/i)
    }
  })

  it('covers exactly the four append-only tables', () => {
    for (const table of APPEND_ONLY_TABLES) {
      expect(code, `missing ${table}`).toMatch(new RegExp(`public\\.${table}\\b`))
    }
    // Never reaches into the objects later gates create.
    expect(code).not.toMatch(/stella_suggestion_decisions/i)
    expect(code).not.toMatch(/evidence_chunks/i)
  })

  it('revokes TRUNCATE, REFERENCES and TRIGGER from authenticated', () => {
    const stmt = statements(raw).find(
      (s) => /^REVOKE\b/i.test(s) && /FROM authenticated$/i.test(s),
    )
    expect(stmt, 'no REVOKE ... FROM authenticated statement').toBeDefined()
    for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(stmt, `authenticated keeps ${priv}`).toMatch(new RegExp(`\\b${priv}\\b`, 'i'))
    }
    for (const table of APPEND_ONLY_TABLES) {
      expect(stmt).toMatch(new RegExp(`public\\.${table}\\b`))
    }
    // SELECT and INSERT are the documented append-only posture — never revoked.
    expect(stmt).not.toMatch(/\bSELECT\b/i)
    expect(stmt).not.toMatch(/\bINSERT\b/i)
  })

  it('revokes UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER from service_role', () => {
    const stmt = statements(raw).find(
      (s) => /^REVOKE\b/i.test(s) && /FROM service_role$/i.test(s),
    )
    expect(stmt, 'no REVOKE ... FROM service_role statement').toBeDefined()
    for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(stmt, `service_role keeps ${priv}`).toMatch(new RegExp(`\\b${priv}\\b`, 'i'))
    }
    expect(stmt).not.toMatch(/\bSELECT\b/i)
    expect(stmt).not.toMatch(/\bINSERT\b/i)
  })

  it('handles MAINTAIN version-aware, via a fixed literal and never below PG17', () => {
    expect(raw).toMatch(/server_version_num/)
    expect(raw).toMatch(/>=\s*170000/)
    // The REVOKE MAINTAIN text must exist ONLY inside a quoted literal, so a
    // pre-17 server never parses it. After stripping strings it is gone.
    expect(raw).toMatch(/REVOKE MAINTAIN ON /)
    expect(code).not.toMatch(/REVOKE MAINTAIN/i)
    // Both roles lose it.
    expect(raw).toMatch(/FROM authenticated, service_role/)
  })

  it('creates one BEFORE TRUNCATE FOR EACH STATEMENT trigger per table', () => {
    for (const [table, trigger] of TRUNCATE_TRIGGERS) {
      expect(code, `missing CREATE for ${trigger}`).toMatch(
        new RegExp(
          `CREATE TRIGGER ${trigger}\\s+BEFORE TRUNCATE ON public\\.${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION public\\.uellix_forbid_mutation\\(\\)`,
          'i',
        ),
      )
      // Idempotency: every CREATE is preceded by its own DROP ... IF EXISTS.
      expect(code, `missing DROP for ${trigger}`).toMatch(
        new RegExp(`DROP TRIGGER IF EXISTS ${trigger} ON public\\.${table}`, 'i'),
      )
    }
    // FOR EACH ROW on TRUNCATE is rejected by PostgreSQL outright.
    expect(code).not.toMatch(/BEFORE TRUNCATE[^;]*FOR EACH ROW/i)
  })

  it('creates exactly four triggers and drops exactly those four', () => {
    expect([...code.matchAll(/CREATE TRIGGER/gi)]).toHaveLength(4)
    const dropped = [...code.matchAll(/DROP TRIGGER IF EXISTS (\w+)/gi)].map((m) => m[1]).sort()
    expect(dropped).toEqual(TRUNCATE_TRIGGERS.map(([, t]) => t).slice().sort())
  })

  it('guards its preconditions instead of failing obscurely', () => {
    expect(raw).toMatch(/uellix_forbid_mutation\(\) not found/)
    expect(raw).toMatch(/missing target table/)
    // Requires the row-level protection to already exist, so it can never
    // produce a table that rejects TRUNCATE but still accepts UPDATE.
    expect(raw).toMatch(/missing UPDATE\/DELETE append-only trigger/)
    for (const trigger of ROW_TRIGGERS) {
      expect(raw, `precondition does not check ${trigger}`).toContain(trigger)
    }
  })

  it('never drops the pre-existing row-level triggers', () => {
    for (const trigger of ROW_TRIGGERS) {
      expect(code).not.toMatch(new RegExp(`DROP TRIGGER IF EXISTS ${trigger}\\b`, 'i'))
    }
  })

  it('touches no data, no RLS and no constraints', () => {
    expect(code).not.toMatch(/\b(INSERT INTO|DELETE FROM|MERGE)\b/i)
    expect(code).not.toMatch(/ROW LEVEL SECURITY/i)
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY/i)
    expect(code).not.toMatch(/ADD CONSTRAINT|DROP CONSTRAINT/i)
  })

  it('is transaction-compatible and contains no destructive statements', () => {
    // Check STATEMENTS, not raw lines: statements() collapses `DO $$ ... $$`
    // bodies, so the PL/pgSQL `BEGIN` of a guard block is not mistaken for
    // transaction control. Only a top-level COMMIT/ROLLBACK/BEGIN would break
    // `psql -1`.
    for (const stmt of statements(raw)) {
      expect(stmt, `transaction control statement: ${stmt}`).not.toMatch(
        /^(COMMIT|ROLLBACK|BEGIN)\b/i,
      )
    }
    expect(code).not.toMatch(/CONCURRENTLY/i)
    expectNoDestructiveStatements(code)
    expectNoExecutedDdl(raw)
    expectExecutedLiteralsTerminated(raw)
    expectNoAnonOrPublicGrants(code)
  })

  it('grants nothing to anyone — it only removes privileges', () => {
    expect(code).not.toMatch(/\bGRANT\b/i)
  })
})

describe('db/prepared/stella_0002b_rollback.sql', () => {
  const raw = read('stella_0002b_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has balanced parentheses and terminated statements', () => {
    expectBalancedParens(code)
    expect(code.trim().endsWith(';')).toBe(true)
  })

  it('declares the SAFE_NON_REVERSING_ROLLBACK policy', () => {
    expect(raw).toMatch(/SAFE_NON_REVERSING_ROLLBACK/)
    expect(statements(raw)[0]).toMatch(/^SET search_path = public$/i)
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
  })

  it('never re-grants any of the dangerous privileges', () => {
    // The whole point: a rollback must not be a one-command way to reopen an
    // audit-trail hole. No executable GRANT may survive comment stripping.
    expect(code).not.toMatch(/\bGRANT\b/i)
    for (const priv of ['TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN', 'UPDATE', 'DELETE']) {
      expect(code, `rollback re-grants ${priv}`).not.toMatch(
        new RegExp(`GRANT[^;]*\\b${priv}\\b`, 'i'),
      )
    }
  })

  it('never drops the TRUNCATE or row-level protections', () => {
    expect(code).not.toMatch(/DROP TRIGGER/i)
    for (const [, trigger] of TRUNCATE_TRIGGERS) {
      expect(code).not.toMatch(new RegExp(`DROP[^;]*${trigger}`, 'i'))
    }
  })

  it('changes nothing at all: no DDL, no DML, no grants', () => {
    for (const stmt of statements(raw)) {
      expect(stmt, `unexpected mutating statement: ${stmt.slice(0, 60)}`).toMatch(/^(SET|DO)\b/i)
    }
    expect(code).not.toMatch(/\b(INSERT INTO|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE)\b/i)
    expectNoDestructiveStatements(code)
  })

  it('verifies all three protections and reports gaps', () => {
    for (const [, trigger] of TRUNCATE_TRIGGERS) {
      expect(raw).toContain(trigger)
    }
    for (const trigger of ROW_TRIGGERS) {
      expect(raw).toContain(trigger)
    }
    expect(raw).toMatch(/RAISE WARNING/)
    expect(raw).toMatch(/RAISE NOTICE/)
  })

  it('explains why reversing would contradict the audit-ready guarantee', () => {
    expect(raw).toMatch(/audit-ready|audit trail/i)
    // Must distinguish itself from the bug-compatible stella_0002 rollback.
    expect(raw).toMatch(/BUG-COMPATIBLE/i)
    expect(raw).toMatch(/DBA/)
  })
})

// ---------------------------------------------------------------------------
// Correcciones de la auditoría independiente (2026-08-01)
// ---------------------------------------------------------------------------
// Pin the fixes for MAJ-01, MAJ-02 and the correctness MINORs so they cannot be
// silently undone. Each test names the finding it closes.

describe('audit fixes — MAJ-01: bounded lock acquisition', () => {
  it('stella_0002b sets a lock_timeout before taking ACCESS EXCLUSIVE', () => {
    const raw = read('stella_0002b_append_only_truncate_hardening.sql')
    // Every DROP/CREATE TRIGGER takes ACCESS EXCLUSIVE and holds it to COMMIT.
    // audit_logs is written on essentially every request, so an unbounded wait
    // behind a long reader would stall all traffic to it.
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
    const stmts = statements(raw)
    const lockIdx = stmts.findIndex((s) => /^SET lock_timeout/i.test(s))
    const firstDdlIdx = stmts.findIndex((s) => /^(DROP TRIGGER|CREATE TRIGGER|REVOKE)\b/i.test(s))
    expect(lockIdx, 'lock_timeout missing').toBeGreaterThan(-1)
    expect(lockIdx, 'lock_timeout must precede any lock-taking statement').toBeLessThan(firstDdlIdx)
  })

  it('stella_0003 sets a lock_timeout too (its section 6 also takes the lock)', () => {
    const raw = read('stella_0003_suggestion_decisions.sql')
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
  })
})

describe('audit fixes — MAJ-02: stella_0003 asserts its own write path', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('aborts if the declared writer role has no working INSERT path', () => {
    // Superseded 2026-08-01 (MAJ-A). The original assertion pinned
    // has_table_privilege(current_user, ...), which returns true for ANY
    // superuser and proved the installer's access rather than the
    // application's. The replacement resolves a DECLARED writer role.
    expect(raw).toMatch(/has no working INSERT path/)
    expect(raw).toMatch(/stella\.writer_role/)
  })

  it('verifies the RLS helpers are EXECUTABLE, not merely present (MIN-08)', () => {
    // 0033:18 revokes EXECUTE from authenticated and 0039 grants it back. An
    // environment with the first and not the second passes an existence check
    // but denies every read through the SELECT policy.
    expect(raw).toMatch(/has_function_privilege\('authenticated', 'public\.current_user_org_ids\(\)', 'EXECUTE'\)/)
    expect(raw).toMatch(/has_function_privilege\('authenticated', 'public\.current_user_is_super_admin\(\)', 'EXECUTE'\)/)
  })

  it('no longer claims service_role bypasses RLS on this table (MIN-07)', () => {
    // After section 4, service_role holds NO privilege here. Reads/writes work
    // because the OWNER bypasses RLS (no FORCE ROW LEVEL SECURITY).
    expect(raw).toMatch(/it is OWNERSHIP that bypasses RLS/i)
    expect(raw).not.toMatch(/via the service-role\s*\n?--\s*client \(recordStellaDecision\), which bypasses RLS/i)
  })
})

describe('audit fixes — stella_0002b hardening details', () => {
  const raw = read('stella_0002b_append_only_truncate_hardening.sql')
  const code = stripCommentsAndStrings(raw)

  it('guards that the grantee roles exist (MIN-02)', () => {
    expect(raw).toMatch(/FROM pg_roles WHERE rolname = r\.name/)
    expect(raw).toMatch(/missing role\(s\)/)
  })

  it('writes the MAINTAIN literal on one line, with no implicit concatenation (MIN-01)', () => {
    // Adjacent string constants concatenate ONLY when separated by a newline.
    // Splitting the literal would make any reformatting that joined the lines a
    // silent syntax error, so it must be a single self-contained literal.
    const m = /EXECUTE '(REVOKE MAINTAIN[^']*)'/.exec(raw)
    expect(m, 'MAINTAIN literal not found as a single quoted string').not.toBeNull()
    expect(m![1]).toContain('FROM authenticated, service_role')
    for (const t of ['stella_interactions', 'audit_logs', 'sroi_calculation_runs', 'sroi_calculation_line_items']) {
      expect(m![1]).toContain(`public.${t}`)
    }
    // No adjacent-literal concatenation anywhere in the file.
    expect(raw).not.toMatch(/'\s*\n\s*'/)
  })

  it('verifies its own end state inside the same transaction (MIN-10)', () => {
    // A REVOKE only removes grants from the current grantor and merely WARNs
    // when there is nothing to revoke — so "I ran REVOKE" is not evidence.
    expect(raw).toMatch(/FAILED verification: privileges still present after REVOKE/)
    expect(raw).toMatch(/FAILED verification: TRUNCATE trigger\(s\) not attached/)
    // Over-revoking must fail too: the posture is SELECT+INSERT, not read-only.
    expect(raw).toMatch(/FAILED verification: authenticated LOST expected privilege/)
    // Verification must come after the changes it checks. Compare positions in
    // `raw`: the messages live inside string literals, which `code` blanks.
    expect(raw.lastIndexOf('CREATE TRIGGER')).toBeLessThan(raw.indexOf('FAILED verification'))
  })

  it('uses to_regclass rather than a ::regclass cast (MIN-03)', () => {
    // `('public.'||t)::regclass` throws when the table is absent, and PostgreSQL
    // does not guarantee WHERE-qual evaluation order, so a sibling
    // `IS NOT NULL` guard cannot be relied on to run first. to_regclass()
    // already returns regclass and yields NULL instead of raising.
    expect(code).not.toMatch(/\)::regclass/)
    // Positive check must read `raw`: stripCommentsAndStrings blanks the
    // 'public.' literal, so this pattern can never match in `code`.
    expect(raw).toMatch(/to_regclass\('public\.' \|\| t\.tbl\)/)
  })
})

describe('audit fixes — stella_0002b rollback', () => {
  const raw = read('stella_0002b_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('uses to_regclass rather than a ::regclass cast (MIN-03)', () => {
    expect(code).not.toMatch(/\)::regclass/)
    // Positive check must read `raw`: stripCommentsAndStrings blanks the
    // 'public.' literal, so this pattern can never match in `code`.
    expect(raw).toMatch(/to_regclass\('public\.' \|\| t\.tbl\)/)
  })

  it('exits non-zero when it detects a gap (MIN-04)', () => {
    // It changes nothing, so raising is free — and a gate that trusts the exit
    // code must not see green while the script just reported the protection is
    // gone.
    expect(raw).toMatch(/RAISE EXCEPTION 'stella_0002b_rollback: append-only hardening is NOT intact/)
  })
})

describe('audit fixes — MIN-09: order hazard is documented', () => {
  it('stella_0002_rollback warns that it leaves an asymmetric state after 0002b', () => {
    const raw = read('stella_0002_rollback.sql')
    expect(raw).toMatch(/ORDER HAZARD vs stella_0002b/)
    expect(raw).toMatch(/asymmetric/i)
  })
})

// ---------------------------------------------------------------------------
// stella_0003 pre-apply hardening (2026-08-01) — MAJ-A / MAJ-B / MAJ-C
// ---------------------------------------------------------------------------
// Pins the fixes made before this script's FIRST application anywhere. Each
// test names the finding it closes.

describe('stella_0003 MAJ-A — the write-path guard is not vacuous', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  // Absence assertions must read the EXECUTABLE sql: the comments legitimately
  // quote the old, rejected patterns while explaining why they were replaced.
  const code = stripCommentsAndStrings(raw)

  it('never uses has_table_privilege(current_user, ...)', () => {
    // The old guard did exactly this. has_table_privilege() returns true
    // unconditionally for any role with rolsuper, so it was blind precisely in
    // the case its own comment named: the script being applied by tooling
    // running as supabase_admin.
    // Read `code`, not `raw`: the replacement's own comment quotes the old
    // pattern verbatim while explaining why it was removed.
    expect(code).not.toMatch(/has_table_privilege\(\s*current_user/i)
  })

  it('declares an explicit writer role instead of assuming the installer', () => {
    expect(raw).toMatch(/current_setting\('stella\.writer_role', true\)/)
    // And documents how it is set, how it fails when absent, how it is verified.
    expect(raw).toMatch(/SET stella\.writer_role/)
    expect(raw).toMatch(/WHEN UNSET/)
    expect(raw).toMatch(/ASSUMPTION, not a verification/)
  })

  it('resolves privileges through aclexplode, so inheritance cannot satisfy it', () => {
    // aclexplode() over relacl reads the ACL literally: privileges reached via
    // role membership do not appear, and there is no superuser short-circuit.
    expect(raw).toMatch(/aclexplode\(COALESCE\(c\.relacl, acldefault\('r', c\.relowner\)\)\)/)
    // Superseded by m3: the grantee OID is resolved by exact rolname rather
    // than through ::regrole, which lowercases and dot-splits its input.
    expect(raw).toMatch(/a\.grantee = writer_oid/)
  })

  it('requires ownership OR (direct INSERT+SELECT AND rolbypassrls)', () => {
    // RLS is enabled with no INSERT policy, so a bare INSERT grant is not a
    // working write path. INSERT ... RETURNING id also needs SELECT.
    expect(raw).toMatch(/owner_is_writer/)
    expect(raw).toMatch(/rolbypassrls/)
    expect(raw).toMatch(/direct_insert/)
    expect(raw).toMatch(/direct_select/)
    expect(raw).toMatch(/RETURNING id/)
  })

  it('refuses a PostgREST role as table owner', () => {
    expect(raw).toMatch(/a PostgREST role/)
  })

  it('tells the operator NOT to grant INSERT just to satisfy the guard', () => {
    expect(raw).toMatch(/Do NOT grant INSERT to authenticated or service_role/)
  })

  it('separates what SQL proves from what it cannot', () => {
    // Structural guard / offline code test / human gate precondition.
    expect(raw).toMatch(/STRUCTURAL GUARD/)
    expect(raw).toMatch(/OFFLINE CODE TEST/)
    expect(raw).toMatch(/HUMAN GATE PRECONDITION/)
  })
})

describe('stella_0003 MAJ-C — roles guard runs before anything is created', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('checks anon, authenticated and service_role exist', () => {
    expect(raw).toMatch(/FROM \(VALUES \('anon'\), \('authenticated'\), \('service_role'\)\) AS r\(name\)/)
    expect(raw).toMatch(/missing role\(s\)/)
  })

  it('places that guard before the CREATE TABLE', () => {
    // Anchor on the guard's VALUES list and on the fully-qualified CREATE
    // TABLE: the bare phrase 'CREATE TABLE IF NOT EXISTS' also appears in a
    // header comment far above the real statement, and the guard's message
    // lives inside a string literal (blanked by stripCommentsAndStrings), so
    // neither raw-substring nor code-substring alone is reliable here.
    const guardAt = raw.indexOf("('anon'), ('authenticated'), ('service_role')")
    const createAt = raw.indexOf('CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions')
    expect(guardAt, 'roles guard not found').toBeGreaterThan(-1)
    expect(createAt, 'CREATE TABLE statement not found').toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(createAt)
  })

  it('does not fold the writer role into the fixed-role guard', () => {
    // The installer is explicitly NOT assumed to be the writer.
    expect(raw).toMatch(/installer is NOT assumed to be it/)
  })
})

describe('stella_0003 MAJ-B — final self-verification', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('exists and runs after the objects it checks', () => {
    expect(raw).toMatch(/Self-verification/)
    expect(raw.lastIndexOf('CREATE TRIGGER')).toBeLessThan(raw.indexOf('FAILED verification'))
  })

  it('explains why running REVOKE is not evidence', () => {
    expect(raw).toMatch(/only removes grants made by the CURRENT grantor/)
    expect(raw).toMatch(/WARNING — never an error/)
  })

  it.each([
    ['table exists', /does not exist after the script ran/],
    ['owner is not a PostgREST role', /FAILED verification: table owner is/],
    ['column contract', /column contract broken/],
    ['primary key', /PRIMARY KEY on \(id\) missing/],
    ['foreign keys', /missing FOREIGN KEY\(s\)/],
    ['no unexpected UNIQUE', /unexpected UNIQUE constraint/],
    ['decision CHECK', /decision CHECK missing or incomplete/],
    ['hash CHECK anchored', /CHECK missing or not anchored/],
    ['RLS enabled', /ROW LEVEL SECURITY is not enabled/],
    ['exactly one policy', /expected exactly 1 RLS policy/],
    ['row trigger', /expected exactly 1 BEFORE UPDATE OR DELETE FOR EACH ROW trigger/],
    ['truncate trigger', /expected exactly 1 BEFORE TRUNCATE FOR EACH STATEMENT trigger/],
    ['both bound to the shared function', /triggers bound to public\.uellix_forbid_mutation/],
    ['no extra triggers', /unexpected extra trigger/],
    ['no residual privileges', /unexpected DIRECT privilege\(s\) present/],
    ['not over-revoked', /authenticated LOST its direct SELECT grant/],
    // NOTE: the former checks (19) evidence_chunks-absent and (20)
    // default-privileges-untouched were REMOVED in review round 2 — see the
    // 'review round 2' describe below. (19) broke convergence once
    // grounding_0001 is applied under its own gate; (20) was unfalsifiable.
    ['no unexpected columns', /expected exactly 11 columns/],
    ['FORCE RLS off', /FORCE ROW LEVEL SECURITY is ON/],
  ])('asserts: %s', (_label, pattern) => {
    expect(raw).toMatch(pattern)
  })

  it('reads pg_catalog, not information_schema, for privileges', () => {
    // Strip comments: the block's own prose explains WHY
    // information_schema.role_table_grants is unusable here.
    const verify = stripCommentsAndStrings(raw.slice(raw.indexOf('Self-verification')))
    expect(verify).toMatch(/aclexplode/)
    expect(verify).not.toMatch(/information_schema/)
  })

  it('uses pg_policy/pg_trigger/pg_constraint rather than views', () => {
    // Strip comments: this block's own prose explains WHY
    // information_schema.role_table_grants is unusable here.
    const verify = stripCommentsAndStrings(raw.slice(raw.indexOf('Self-verification')))
    for (const cat of ['pg_policy', 'pg_trigger', 'pg_constraint', 'pg_attribute', 'pg_class']) {
      expect(verify, `self-verification does not read ${cat}`).toMatch(new RegExp(`\\b${cat}\\b`))
    }
  })
})

describe('stella_0003 MIN-A — accepted_edited is matched literally', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')

  it('uses position(), never LIKE, for the decision literals', () => {
    // `_` is a LIKE wildcard: LIKE '%''accepted_edited''%' would also accept a
    // stale constraint spelling 'acceptedXedited' and leave it in place.
    // Absence is asserted on the executable sql: the explanatory comments
    // quote the rejected LIKE form on purpose.
    const codeOnly = stripCommentsAndStrings(raw)
    expect(codeOnly).not.toMatch(/\bLIKE\b/i)
    expect(raw).toMatch(/position\('''accepted_edited''' in def\)/)
  })

  it('matches the anchored hash pattern literally too', () => {
    expect(raw).toMatch(/position\('''\^\[0-9a-f\]\{64\}\$''' in def\)/)
  })
})

describe('stella_0003 — append-only triggers and grant targets', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('creates exactly the two append-only triggers, idempotently', () => {
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_append_only\s+BEFORE UPDATE OR DELETE ON public\.stella_suggestion_decisions\s+FOR EACH ROW EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    expect(code).toMatch(
      /CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate\s+BEFORE TRUNCATE ON public\.stella_suggestion_decisions\s+FOR EACH STATEMENT EXECUTE FUNCTION public\.uellix_forbid_mutation\(\)/i,
    )
    expect([...code.matchAll(/CREATE TRIGGER/gi)]).toHaveLength(2)
    expect([...code.matchAll(/DROP TRIGGER IF EXISTS/gi)]).toHaveLength(2)
  })

  it('leaves no Dxtm residue: REVOKE ALL for all three roles, then SELECT only', () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON public\\.stella_suggestion_decisions FROM ${role}`, 'i'))
    }
    expect(code).toMatch(/GRANT SELECT ON public\.stella_suggestion_decisions TO authenticated/i)
    expect(code).not.toMatch(/GRANT[^;]*TO service_role/i)
    expect(code).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL)\b[^;]*TO/i)
  })

  it('sets a lock_timeout', () => {
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
  })
})

describe('stella_0003 rollback — destructive, and protected accordingly', () => {
  const raw = read('stella_0003_rollback.sql')

  it('sets a lock_timeout before taking ACCESS EXCLUSIVE', () => {
    expect(raw).toMatch(/SET lock_timeout = '\d+s'/)
  })

  it('is a no-op when the table does not exist', () => {
    expect(raw).toMatch(/does not exist — nothing to do \(idempotent no-op\)/)
  })

  it('counts rows and reports the count before dropping', () => {
    expect(raw).toMatch(/SELECT count\(\*\) FROM public\.stella_suggestion_decisions/)
    expect(raw).toMatch(/RAISE NOTICE 'Rows currently stored: %'/)
  })

  it('aborts when rows exist and destruction was not authorised', () => {
    expect(raw).toMatch(/stella\.confirm_destroy_decisions/)
    expect(raw).toMatch(/destruction was NOT authorised/)
    expect(raw).toMatch(/RAISE EXCEPTION 'stella_0003_rollback aborted/)
  })

  it('warns that DROP TABLE erases the audit trail and triggers cannot stop it', () => {
    expect(raw).toMatch(/erases this human-decision audit trail/)
    expect(raw).toMatch(/cannot stop DROP TABLE/)
  })

  it('names the four meanings of rollback and the human responsibility', () => {
    for (const m of [
      /TECHNICAL ROLLBACK, BEFORE USE/,
      /DESTRUCTION WITH DATA/,
      /EMERGENCY OPERATION/,
      /HUMAN RESPONSIBILITY/,
    ]) {
      expect(raw).toMatch(m)
    }
  })

  it('never restores unsafe grants and never touches 0002/0002b', () => {
    const code = stripCommentsAndStrings(raw)
    expect(code).not.toMatch(/\bGRANT\b/i)
    expect(code).not.toMatch(/stella_interactions|audit_logs|sroi_calculation/i)
    expect(code).not.toMatch(/DROP FUNCTION/i)
  })

  it('drops exactly the one table this package creates', () => {
    expect(executedStatements(raw).filter((s) => /^DROP\b/i.test(s))).toEqual([
      'DROP TABLE public.stella_suggestion_decisions',
    ])
  })
})

// ---------------------------------------------------------------------------
// Review round 4 (2026-08-01) — the guard and the DROP must be ONE statement
// ---------------------------------------------------------------------------
// PREVIOUS DEFECT: the authorisation guard was a `DO $$ ... $$;` block and the
// destructive act was a SEPARATE top-level `DROP TABLE IF EXISTS ...;`. Between
// them stood nothing but two psql command-line flags:
//
//   * without `-v ON_ERROR_STOP=1`, psql reports the failed guard and SENDS THE
//     NEXT STATEMENT — the DROP;
//   * without `-1`, there is no enclosing transaction to roll anything back.
//
// Those flags are an invocation convention, not a property of the file, and
// every other consumer of a .sql file (Supabase SQL Editor, `supabase db
// execute`, a GUI client, a paste into an open session) either cannot accept
// them or does not default to them. The header MANDATED them; nothing ENFORCED
// them.
//
// The fix moves the DROP inside the same DO block. `RAISE EXCEPTION` ends a
// PL/pgSQL block immediately, so no later statement OF THAT BLOCK runs — that
// is server semantics inside one statement, not client semantics between two.
// These tests pin the new shape and reject a regression to the old one.

describe('review round 4 — stella_0003 rollback: guard and DROP are one unit', () => {
  const raw = read('stella_0003_rollback.sql')
  const code = stripCommentsAndStrings(raw)

  it('has NO top-level DROP TABLE statement', () => {
    // The regression this closes, spelled out: a `DO $$ ... $$;` followed by a
    // free-standing `DROP TABLE ...;`. `statements()` collapses $$ bodies, so
    // anything it reports is genuinely top-level.
    const topLevel = statements(raw)
    expect(topLevel.filter((s) => /^DROP\b/i.test(s))).toEqual([])
    // Nothing anywhere outside a string literal may say DROP TABLE either:
    // stripCommentsAndStrings blanks the EXECUTE literal, so a surviving match
    // could only come from executable, unquoted SQL.
    expect(code).not.toMatch(/\bDROP\s+TABLE\b/i)
  })

  it('executes the DROP from inside the same DO block that holds the guard', () => {
    // Read executable text only: the header documents the OLD split shape
    // (`DO $$ ... $$;` then a bare DROP) as prose, and that prose must not be
    // mistaken for a second block.
    const executable = stripAllComments(raw)
    const body = /DO \$\$([\s\S]*?)\$\$;/.exec(executable)
    expect(body, 'no DO $$ ... $$ block found').not.toBeNull()
    const inner = body![1]

    // One block — matched loosely on the dollar TAG, so a regression using
    // `DO $x$ … $x$` is counted rather than silently skipped.
    expect(executable.match(/\bDO\s+\$[A-Za-z_]*\$/g)).toHaveLength(1)

    // ...and it contains every precondition AND the destructive act.
    expect(inner).toMatch(/to_regclass\('public\.stella_suggestion_decisions'\) IS NULL/)
    expect(inner).toMatch(/SELECT count\(\*\) FROM public\.stella_suggestion_decisions/)
    expect(inner).toMatch(/stella\.confirm_destroy_decisions/)
    expect(inner).toMatch(/RAISE EXCEPTION 'stella_0003_rollback aborted/)
    expect(inner).toMatch(/EXECUTE 'DROP TABLE public\.stella_suggestion_decisions'/)

    // ...and the abort comes BEFORE the DROP, so raising skips it.
    expect(inner.indexOf('RAISE EXCEPTION')).toBeLessThan(
      inner.indexOf("EXECUTE 'DROP TABLE"),
    )
  })

  // Every guard in this block is a (condition, RAISE EXCEPTION) PAIR. Asserting
  // that a catalog name appears somewhere, that a message string exists, and
  // that "RAISE EXCEPTION" precedes the DROP does NOT test that any particular
  // guard is armed — an earlier revision of these tests stayed fully green
  // under all four of these mutations:
  //
  //   * FORCE guard's RAISE EXCEPTION downgraded to RAISE NOTICE
  //   * persisted-authorisation RAISE EXCEPTION downgraded to RAISE WARNING
  //   * FORCE condition inverted to `IF NOT (SELECT …)`
  //   * the authorisation guard neutered to `IF NOT authorised AND false THEN`
  //
  // The last is the sharpest: the whole authorisation barrier is disabled, yet
  // `indexOf('RAISE EXCEPTION') < indexOf("EXECUTE 'DROP TABLE")` still holds,
  // satisfied by a DIFFERENT guard's exception. Pin each pair as one span, and
  // count them, so a downgrade or a widened condition breaks the exact test
  // that names it.
  const GUARDS: ReadonlyArray<readonly [string, RegExp]> = [
    [
      'isolation precondition',
      // Enforced, not assumed. Under REPEATABLE READ or SERIALIZABLE the
      // transaction's snapshot is fixed before the ACCESS EXCLUSIVE lock, so
      // the count can miss rows committed in that window: n_rows = 0, the ELSE
      // arm runs, all three authorisation guards are skipped, and a populated
      // audit trail is dropped under a log saying nothing was lost. Unlike the
      // four persistence channels that genuinely cannot be observed from SQL,
      // this one CAN be — current_setting('transaction_isolation') needs no
      // privilege — so leaving it as a comment was a missing guard, not an
      // honest limit.
      // Pinned THROUGH the format argument: `current_setting` appears three
      // times in the file, and swapping this one for
      // `current_setting('default_transaction_isolation')` left every other
      // assertion green while making the refusal self-contradictory — "…is read
      // committed" printed by a transaction that is SERIALIZABLE, at exactly the
      // moment the operator is reading the log.
      /IF current_setting\('transaction_isolation'\) NOT IN \('read committed', 'read uncommitted'\) THEN\s+RAISE EXCEPTION 'stella_0003_rollback aborted: transaction_isolation is %[\s\S]*?', current_setting\('transaction_isolation'\);/,
    ],
    [
      'ownership precondition',
      // COALESCE(..., false) is load-bearing, so it is pinned: a concurrent
      // DROP between the existence check and this subquery makes pg_has_role
      // return NULL, and a bare `IF NOT NULL THEN` is FALSE — the guard would
      // be SKIPPED and the LOCK would fail with an unprefixed 42P01.
      /IF NOT COALESCE\(pg_has_role\(current_user,\s+\(SELECT relowner FROM pg_class\s+WHERE oid = to_regclass\('public\.stella_suggestion_decisions'\)\),\s+'USAGE'\), false\) THEN\s+RAISE EXCEPTION 'stella_0003_rollback aborted: role % cannot drop/,
    ],
    [
      'FORCE ROW LEVEL SECURITY',
      /IF \(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class\s+WHERE oid = to_regclass\('public\.stella_suggestion_decisions'\)\) THEN\s+RAISE EXCEPTION 'stella_0003_rollback aborted: FORCE ROW LEVEL SECURITY is ON/,
    ],
    [
      'destruction not authorised',
      /IF NOT authorised THEN\s+RAISE EXCEPTION 'stella_0003_rollback aborted: the table holds % row\(s\) and destruction was NOT authorised/,
    ],
    [
      'provenance catalog unreadable',
      /IF NOT has_table_privilege\('pg_catalog\.pg_db_role_setting', 'SELECT'\) THEN\s+RAISE EXCEPTION 'stella_0003_rollback aborted: cannot verify that the authorisation belongs to THIS run/,
    ],
    [
      'authorisation persisted',
      /IF persisted_at IS NOT NULL THEN\s+RAISE EXCEPTION 'stella_0003_rollback aborted: stella\.confirm_destroy_decisions is PERSISTED/,
    ],
  ] as const

  it.each(GUARDS)('the %s guard is ARMED: its condition raises, verbatim', (_name, pattern) => {
    expect(/DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]).toMatch(pattern)
  })

  it('pins the DECISION REGION verbatim, not just the guard conditions', () => {
    // The GUARDS spans above pin each condition. They do NOT pin the DATAFLOW
    // that produces the values those conditions test, and a second round of
    // mutation testing found four behaviour-changing mutants that survived:
    //
    //   * `IF n_rows > 0 THEN`  ->  `IF n_rows > 1000000 THEN`
    //       a populated, UNAUTHORISED table takes the ELSE branch, logs
    //       "table is empty — no audit data lost", and is dropped.
    //   * an inserted `authorised = true;`  (PL/pgSQL accepts `=` as assignment,
    //       and the byte-exact `authorised :=` pin below still sees one line)
    //   * an inserted `n_rows := 0;` after the count
    //   * `SELECT true INTO authorised;` / `SELECT NULL::text INTO persisted_at`
    //
    // Fragment-wise assertions cannot close this class. Pin the count, the
    // authorisation assignment and the branch as ONE adjacent span, then pin
    // that each variable is written exactly once and only where expected.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]

    expect(inner).toMatch(
      /EXECUTE 'SELECT count\(\*\) FROM public\.stella_suggestion_decisions' INTO n_rows;\s+authorised := COALESCE\(current_setting\('stella\.confirm_destroy_decisions', true\), ''\) = 'true';\s+IF n_rows > 0 THEN/,
    )

    // Exactly one write to each decision variable, and none of them via a
    // second `INTO` or a bare `=` assignment.
    expect(inner.match(/\bauthorised\s*:?=/g)).toHaveLength(1)
    expect(inner.match(/\bn_rows\s*:=/g)).toBeNull()
    expect(inner.match(/\bINTO\s+n_rows\b/gi)).toHaveLength(1)
    expect(inner.match(/\bINTO\s+authorised\b/gi)).toBeNull()
    expect(inner.match(/\bINTO\s+persisted_at\b/gi)).toHaveLength(1)

    // ...and persisted_at is computed from the real aggregate, not stubbed to
    // NULL (which would silently disable the persistence guard).
    expect(inner).toMatch(
      /SELECT string_agg\([\s\S]{0,400}?\)\s+INTO persisted_at\s+FROM pg_db_role_setting s/,
    )
  })

  // -------------------------------------------------------------------------
  // THE STRUCTURAL BACKSTOP — pin the whole executable body, not fragments
  // -------------------------------------------------------------------------
  // Five successive review rounds added more FRAGMENT assertions, and each round
  // a new behaviour-changing mutant slipped through the previous set:
  //
  //   r2  `IF NOT authorised AND false THEN`        (condition widened)
  //   r3  `IF n_rows > 1000000 THEN`                (dataflow, not condition)
  //   r4  THEN/ELSE arm bodies exchanged            (branch membership)
  //   r4  appended top-level `SET stella.… = 'true'`(outside the DO block)
  //   r5  `IF false THEN` WRAPPED one line further out around a pinned span
  //   r5  `persisted_at := NULL;` inserted before its own guard
  //   r5  `PERFORM set_config('stella.confirm_destroy_decisions','true',true)`
  //       INSIDE the block, where the top-level statement list cannot see it
  //
  // Every one of those keeps all the fragment spans intact. The class does not
  // close by adding more fragments — each new assertion pins one more shape and
  // leaves the complement open. The only assertion shape that is COMPLETE is to
  // pin the entire executable body: every statement, in order, with its nesting.
  //
  // What is pinned is the comment-stripped, STRING-BLANKED, whitespace-collapsed
  // DO body. Blanking the literals keeps this readable (the RAISE messages are
  // most of the file's bytes) and keeps the two concerns separate: this test owns
  // STRUCTURE, and the per-message tests below own the TEXT. Any inserted,
  // removed, reordered or re-nested statement fails here.
  //
  // Editing the SQL therefore requires updating this constant. That is the point:
  // for a script that erases an audit trail, no change to executable logic should
  // be able to land without appearing in a diff someone has to approve.
  const EXECUTABLE_SKELETON = [
      "DECLARE n_rows bigint; authorised boolean; persisted_at text; BEGIN IF current_setting('…')",
      "NOT IN ('…', '…') THEN RAISE EXCEPTION '…', current_setting('…'); END IF; IF",
      "to_regclass('…') IS NULL THEN RAISE NOTICE '…'; RETURN; END IF; IF NOT",
      "COALESCE(pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid =",
      "to_regclass('…')), '…'), false) THEN RAISE EXCEPTION '…', current_user; END IF; LOCK TABLE",
      "public.stella_suggestion_decisions IN ACCESS EXCLUSIVE MODE; IF (SELECT relrowsecurity AND",
      "relforcerowsecurity FROM pg_class WHERE oid = to_regclass('…')) THEN RAISE EXCEPTION '…';",
      "END IF; EXECUTE '…' INTO n_rows; authorised := COALESCE(current_setting('…', true), '…') =",
      "'…'; IF n_rows > 0 THEN IF NOT authorised THEN RAISE EXCEPTION '…', n_rows; END IF; IF NOT",
      "has_table_privilege('…', '…') THEN RAISE EXCEPTION '…', current_user, current_user; END IF;",
      "SELECT string_agg( COALESCE((SELECT d.datname FROM pg_database d WHERE d.oid =",
      "s.setdatabase), '…') || '…' || COALESCE((SELECT r.rolname FROM pg_roles r WHERE r.oid =",
      "s.setrole), '…'), '…') INTO persisted_at FROM pg_db_role_setting s WHERE (s.setdatabase = 0",
      "OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())) AND",
      "(s.setrole = 0 OR s.setrole = (SELECT oid FROM pg_roles WHERE rolname = session_user)) AND",
      "EXISTS ( SELECT 1 FROM unnest(s.setconfig) c WHERE split_part(c, '…', 1) = '…' AND",
      "split_part(c, '…', 2) = '…' ); IF persisted_at IS NOT NULL THEN RAISE EXCEPTION '…',",
      "persisted_at; END IF; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…', n_rows; RAISE",
      "NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE",
      "NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE NOTICE '…'; RAISE",
      "WARNING '…', n_rows; ELSE RAISE NOTICE '…'; END IF; EXECUTE '…'; RAISE NOTICE '…', n_rows;",
      "END"
  ].join(' ')

  it('pins the ENTIRE executable body of the DO block, statement by statement', () => {
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    const skeleton = inner
      .replace(/'(?:[^']|'')*'/g, "'…'") // literals blanked; text pinned elsewhere
      .replace(/\s+/g, ' ')
      .trim()
    expect(skeleton).toBe(EXECUTABLE_SKELETON)
  })

  it('pins WHICH BRANCH holds which behaviour, not just the condition', () => {
    // Pinning `IF n_rows > 0 THEN` fixes the CONDITION and stops there. Nothing
    // stopped the two arms from being EXCHANGED verbatim:
    //
    //   IF n_rows > 0 THEN
    //     RAISE NOTICE '... table is empty — ... no audit data lost.';
    //   ELSE
    //     IF NOT authorised THEN RAISE EXCEPTION ...; END IF;
    //     ... provenance guards ... banner ... WARNING ...
    //   END IF;
    //   EXECUTE 'DROP TABLE ...';
    //
    // A populated audit trail is then announced as empty, every guard in the
    // THEN arm is skipped, and the table is dropped — the same outcome as the
    // `IF n_rows > 1000000` mutant, reached by a mutation the span did not see.
    // Every offset is required present before comparison (indexOf returns -1).
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    const at = (needle: string) => {
      const i = inner.indexOf(needle)
      expect(i, `missing from the DO block: ${needle}`).toBeGreaterThan(-1)
      return i
    }
    const then_ = at('IF n_rows > 0 THEN')
    const notAuthorised = at('IF NOT authorised THEN')
    const catalogGuard = at('IF NOT has_table_privilege')
    const persistedGuard = at('IF persisted_at IS NOT NULL THEN')
    const banner = at('about to DROP public.stella_suggestion_decisions')
    const warning = at('RAISE WARNING')
    const else_ = at('\n  ELSE')
    const emptyNotice = at('table is empty — technical rollback before use')
    const drop = at("EXECUTE 'DROP TABLE")

    // The NON-EMPTY arm owns the three authorisation guards, the banner and
    // the WARNING (the isolation, existence, ownership and FORCE guards run
    // before the branch, and are ordered by the test above)...
    for (const [label, offset] of [
      ['not-authorised guard', notAuthorised],
      ['catalog-readable guard', catalogGuard],
      ['persisted-authorisation guard', persistedGuard],
      ['destruction banner', banner],
      ['destruction WARNING', warning],
    ] as const) {
      expect(offset, `${label} must sit in the n_rows > 0 arm`).toBeGreaterThan(then_)
      expect(offset, `${label} must sit in the n_rows > 0 arm`).toBeLessThan(else_)
    }

    // ...and the EMPTY arm owns exactly the technical-rollback NOTICE.
    expect(emptyNotice).toBeGreaterThan(else_)
    expect(emptyNotice).toBeLessThan(drop)

    // Exactly one ELSE, so "the empty arm" is unambiguous.
    expect(inner.match(/\n\s+ELSE\b/g)).toHaveLength(1)
  })

  it('has exactly those six guards and no seventh unaccounted RAISE EXCEPTION', () => {
    // Counting pins the downgrade mutations from the other direction: turning
    // any guard into a NOTICE/WARNING drops the count below GUARDS.length.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    expect(inner.match(/RAISE EXCEPTION/g)).toHaveLength(GUARDS.length)
    // ...and every one of them carries the prefix the header and the G2 abort
    // criteria tell the operator to look for.
    expect(inner.match(/RAISE EXCEPTION 'stella_0003_rollback aborted: /g)).toHaveLength(
      GUARDS.length,
    )
  })

  it('has no EXCEPTION handler that could swallow the guard and reach the DROP', () => {
    // THE sharpest regression this file admits, and every other assertion in
    // this describe stays green with it present:
    //
    //   BEGIN
    //     IF n_rows > 0 AND NOT authorised THEN RAISE EXCEPTION '…'; END IF;
    //   EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'guard failed: %', SQLERRM;
    //   END;
    //   EXECUTE 'DROP TABLE public.stella_suggestion_decisions';
    //
    // The whole argument of this script is "RAISE EXCEPTION terminates the
    // block immediately". An EXCEPTION handler — in the outer block or in any
    // nested sub-block — is exactly what makes that false. It is also a
    // TEMPTING edit, because a dependent-object failure currently surfaces
    // PostgreSQL's generic message instead of the 'stella_0003_rollback'
    // prefix. Forbid the shortcut.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    expect(inner).not.toMatch(/\bEXCEPTION\s+WHEN\b/i)
    // No nested sub-block can carry a handler, and nothing can RETURN early
    // past the DROP other than the documented absent-table path.
    //
    // Counted over the CODE, with string literals blanked: an operator NOTICE
    // that happened to contain the word "BEGIN" or "RETURN" would otherwise
    // break this test with a failure message pointing at the wrong thing.
    const innerCode = stripCommentsAndStrings(inner)
    expect(innerCode.match(/\bBEGIN\b/gi)).toHaveLength(1)
    expect(innerCode.match(/\bRETURN\b/gi)).toHaveLength(1)
  })

  it('orders the block so every fact it acts on is read under the lock', () => {
    // LOCK first, then the FORCE flag, then the count. Ordering assertions of
    // the form indexOf(x) < indexOf(y) pass VACUOUSLY when x is absent (-1 < n),
    // so every offset is required to be present before it is compared.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    const at = (needle: string) => {
      const i = inner.indexOf(needle)
      expect(i, `missing from the DO block: ${needle}`).toBeGreaterThan(-1)
      return i
    }
    const isolation = at("current_setting('transaction_isolation')")
    const exists = at("to_regclass('public.stella_suggestion_decisions') IS NULL")
    const owns = at('pg_has_role(current_user,')
    const lock = at('LOCK TABLE public.stella_suggestion_decisions IN ACCESS EXCLUSIVE MODE')
    const force = at('relforcerowsecurity')
    const count = at("EXECUTE 'SELECT count(*)")
    const drop = at("EXECUTE 'DROP TABLE")

    // Isolation is checked FIRST, before anything else reads a catalog: under a
    // fixed snapshot EVERY fact below is potentially stale relative to the lock,
    // not just the row count.
    expect(isolation).toBeLessThan(exists)
    expect(exists).toBeLessThan(owns)

    // Ownership is checked before the lock: reading pg_class needs no privilege
    // on the table, so a caller who cannot lock still gets the prefixed refusal
    // instead of a bare `permission denied for table ...`.
    expect(owns).toBeLessThan(lock)

    // The lock comes FIRST: the same race that lets a row slip in before the
    // DROP also lets another session commit ALTER TABLE … FORCE ROW LEVEL
    // SECURITY between a pre-lock pg_class read and the lock, after which the
    // count would run under FORCE with the guard already satisfied.
    expect(lock).toBeLessThan(force)
    expect(force).toBeLessThan(count)
    expect(count).toBeLessThan(drop)
  })

  it('checks BOTH rowsecurity flags, so FORCE-without-ENABLE is not a false refusal', () => {
    // relforcerowsecurity can be true while relrowsecurity is false; in that
    // state RLS is not applied at all, the count is trustworthy, and aborting
    // would strand a table this script could safely handle.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    expect(inner).toMatch(/SELECT relrowsecurity AND relforcerowsecurity FROM pg_class/)
  })

  it('runs the DROP as a fixed literal — no concatenation, no interpolation', () => {
    // Exactly one executable EXECUTE line per literal, and both literals are
    // constants embedded in the file.
    expect(executedStatements(raw)).toEqual([
      'SELECT count(*) FROM public.stella_suggestion_decisions',
      'DROP TABLE public.stella_suggestion_decisions',
    ])
    // No identifier is ever composed: `||`, format(), quote_ident() and
    // EXECUTE-of-a-variable are all absent. expectNoExecutedDdl admits only
    // `EXECUTE '<self-contained literal>'`, so `EXECUTE v_sql` fails there.
    expectNoExecutedDdl(raw)
    expect(code).not.toMatch(/\b(format|quote_ident|quote_literal)\s*\(/i)

    // ...and the literal is not then CONCATENATED. A line-bounded probe
    // (/EXECUTE[^\n;]*\|\|/) misses the wrap:
    //
    //   EXECUTE 'DROP TABLE public.stella_suggestion_decisions'
    //       || v_suffix;
    //
    // which passes the exact-equality check above too, because
    // executedStatements() reads only the literal.
    expect(expectExecutedLiteralsTerminated(raw)).toBe(2)
  })

  it('drops without IF EXISTS, because existence was proven in the same block', () => {
    const drop = executedStatements(raw).find((s) => /^DROP\b/i.test(s))
    expect(drop).toBe('DROP TABLE public.stella_suggestion_decisions')
    expect(drop).not.toMatch(/IF EXISTS/i)
  })

  it('documents why the psql flags are no longer the only barrier', () => {
    // The flags stay RECOMMENDED (defence in depth) but must no longer be the
    // only barrier — the file has to state both halves of that, or the next
    // reader will re-introduce the split.
    expect(raw).toMatch(/-1 -v ON_ERROR_STOP=1/)
    expect(raw).toMatch(/no longer the ONLY barrier|not the only barrier/i)
    expect(raw).toMatch(/SERVER semantics/)
    expect(raw).toMatch(/PREVIOUS DEFECT/)
  })

  it('pins client_min_messages, so the destructive path cannot run in silence', () => {
    // The operator record this script rests on IS its NOTICE/WARNING output.
    // A session at `client_min_messages = warning` would destroy an audit
    // trail with nothing visible — the same class of defect as depending on
    // psql flags: the invocation deciding whether the safeguard is observable.
    expect(raw).toMatch(/SET client_min_messages = notice;/)
    expect(statements(raw).some((s) => /^SET client_min_messages/i.test(s))).toBe(true)
  })

  it('contains no transaction control of its own', () => {
    // A COMMIT or ROLLBACK inside the file would fight `-1` and could commit
    // the DROP even when the caller meant to wrap it.
    for (const stmt of statements(raw)) {
      expect(stmt).toMatch(/^(SET|DO)\b/i)
    }
    expect(code).not.toMatch(/\b(COMMIT|ROLLBACK|START TRANSACTION|SAVEPOINT)\b/i)
    expect(code).not.toMatch(/^\s*BEGIN\s*;/im)
  })

  it('has EXACTLY these four top-level statements, and no fifth', () => {
    // Bounding the LIST, not just checking that each entry looks like a SET.
    // Nothing previously limited how MANY top-level statements the file has,
    // and a single appended line before the DO block defeats a guard from
    // OUTSIDE it — the one place the structural argument does not reach:
    //
    //   SET stella.confirm_destroy_decisions = 'true';  -- every run self-authorises
    //   SET lock_timeout = 0;                           -- unbounded ACCESS EXCLUSIVE
    //   SET client_min_messages = warning;              -- destruction runs silent
    //
    // The first is the worst: `authorised` becomes true, `persisted_at` stays
    // NULL (a session SET is not in pg_db_role_setting), and the entire
    // authorisation barrier is vacuous. The existing
    // `toMatch(/SET stella\.confirm_destroy_decisions = 'true'/)` cannot catch
    // it — that is a POSITIVE assertion already satisfied by the header prose.
    expect(statements(raw).map((s) => s.replace(/\s+/g, ' '))).toEqual([
      'SET search_path = public',
      "SET lock_timeout = ''", // '5s' blanked by stripCommentsAndStrings
      'SET client_min_messages = notice',
      'DO $body$',
    ])
    // The literals the blanking hides, read from the raw source.
    expect(raw).toMatch(/^SET lock_timeout = '5s';$/m)
    expect(raw).toMatch(/^SET client_min_messages = notice;$/m)
    // ...and no executable SET of the authorisation GUC anywhere in the file:
    // declaring it is the OPERATOR's per-run act, never the script's.
    // Strings blanked too — the abort MESSAGE legitimately tells the operator
    // to run `SET stella.confirm_destroy_decisions = 'true'`.
    expect(stripCommentsAndStrings(raw)).not.toMatch(/\bSET\s+stella\./i)
  })

  it('distinguishes all three outcomes with its own message', () => {
    // absent / empty / non-empty must not be reported by the same NOTICE, or
    // the operator cannot tell a no-op from a destruction from the log alone.
    expect(raw).toMatch(/does not exist — nothing to do \(idempotent no-op\)/)
    expect(raw).toMatch(/table is empty — technical rollback before use/)
    expect(raw).toMatch(/destroying % decision row\(s\) under explicit per-run authorisation/)
    expect(raw).toMatch(/dropped \(% row\(s\) destroyed\)/)
  })

  it('pins the operator-facing messages END TO END, not just their opening phrase', () => {
    // The structure is pinned completely; the RECORD was not. Only each
    // message's distinguishing HEAD was asserted, so this mutant survived
    // everything — every guard still armed, every span still matching:
    //
    //   RAISE WARNING '…destroying % decision row(s) under explicit per-run
    //     authorisation (…). Nothing of value is being erased; this run is
    //     fully reversible at any time.'
    //
    // On a script whose stated safeguard IS its log, inverting what the log
    // says about a destruction is a behaviour change. Pin the whole text of the
    // four operator-actionable messages, byte for byte.
    // Comment-stripped: several of these phrases are also QUOTED in the
    // surrounding rationale comments, which is legitimate and must not make the
    // lookup ambiguous.
    const executable = stripAllComments(raw)
    const line = (needle: string) => {
      const hit = executable.split('\n').filter((l) => l.includes(needle))
      expect(hit, `expected exactly one executable line containing: ${needle}`).toHaveLength(1)
      return hit[0].trim().replace(/\r$/, '')
    }

    expect(line('destroying % decision row(s)')).toBe(
      "RAISE WARNING 'stella_0003_rollback: destroying % decision row(s) under explicit per-run authorisation (stella.confirm_destroy_decisions=true). An audit trail is being erased; after COMMIT this is recoverable ONLY from a verified backup.', n_rows;",
    )
    expect(line('table is empty — technical rollback')).toBe(
      "RAISE NOTICE 'stella_0003_rollback: table is empty — technical rollback before use, no audit data lost.';",
    )
    expect(line('does not exist — nothing to do')).toBe(
      "RAISE NOTICE 'stella_0003_rollback: public.stella_suggestion_decisions does not exist — nothing to do (idempotent no-op).';",
    )
    expect(line('row(s) destroyed')).toBe(
      "RAISE NOTICE 'stella_0003_rollback: public.stella_suggestion_decisions dropped (% row(s) destroyed). Re-running this file is now a no-op.', n_rows;",
    )
  })

  it('pins the DESTRUCTION BANNER verbatim — every line of it', () => {
    // The banner was the last operator-facing text on the destructive path held
    // only by loose substring probes. The skeleton pins the NUMBER of RAISE
    // NOTICE statements, so a line cannot be deleted — but its TEXT could be
    // replaced, and these two mutants survived everything:
    //
    //   'rows back: only a verified restore can, so one must exist'
    //     -> '…so one must exist' becomes '…though one is rarely needed'
    //   'design; on any real environment it is not.'
    //     -> '…and on any real environment too — this step is routine.'
    //
    // That is the precondition of the whole operation ("a verified backup must
    // exist") inverted, on the emergency path, in the text the operator is
    // reading at the moment they decide. Pin the block.
    const executable = stripAllComments(raw)
    const banner = [
      "RAISE NOTICE '==============================================================';",
      "RAISE NOTICE 'stella_0003_rollback: about to DROP public.stella_suggestion_decisions';",
      "RAISE NOTICE 'Rows currently stored: %', n_rows;",
      "RAISE NOTICE 'DROP TABLE erases this human-decision audit trail. The two';",
      "RAISE NOTICE 'append-only triggers forbid UPDATE/DELETE/TRUNCATE, but they';",
      "RAISE NOTICE 'cannot stop DROP TABLE — it removes the triggers along with the';",
      "RAISE NOTICE 'table. PostgreSQL DDL is transactional, so under the prescribed';",
      "RAISE NOTICE 'psql -1 a ROLLBACK still undoes this — but only until this';",
      "RAISE NOTICE 'transaction COMMITS. After that, no SQL can bring append-only';",
      "RAISE NOTICE 'rows back: only a verified restore can, so one must exist';",
      "RAISE NOTICE 'before you proceed. On a disposable rehearsal stack that is by';",
      "RAISE NOTICE 'design; on any real environment it is not.';",
      "RAISE NOTICE '==============================================================';",
    ].join('\n')
    const normalised = executable
      .split('\n')
      .map((l) => l.trim().replace(/\r$/, ''))
      .join('\n')
    expect(normalised).toContain(banner)
  })

  it('pins the REMEDY clause of every abort, not just its opening phrase', () => {
    // Head-only pinning leaves each abort's tail free — and the tail is the
    // part that tells the operator what to DO. The FORCE message's
    // "This refusal is UNCONDITIONAL … re-running as a BYPASSRLS role will not
    // clear it" could be inverted into advice that sends them in a loop.
    for (const tail of [
      // isolation
      'Re-run with SET TRANSACTION ISOLATION LEVEL READ COMMITTED, or clear default_transaction_isolation for this role/database',
      // ownership
      'Re-run as the role that owns the table (the same role DATABASE_URL connects as, see stella_0003 §4b); if it is already gone, re-running is a clean no-op',
      // FORCE
      'This refusal is UNCONDITIONAL: it does not depend on who you are, so re-running as a BYPASSRLS role will not clear it. Turn FORCE off — the state stella_0003 verifies and the only route past this guard',
      // not authorised
      "Export them first, then re-run with: SET stella.confirm_destroy_decisions = ''true''; Record who authorised it and why in the gate log",
      // provenance catalog unreadable
      'Re-run as a role that can read it, or GRANT SELECT ON pg_catalog.pg_db_role_setting TO %, or confirm manually that no standing authorisation exists and record that confirmation in the gate log',
      // persisted authorisation
      'Remove it (ALTER DATABASE/ROLE … RESET stella.confirm_destroy_decisions), then authorise with a session SET in the session that performs the rollback',
    ]) {
      expect(raw, `abort remedy drifted: ${tail.slice(0, 50)}…`).toContain(tail)
    }
  })

  it('pins the ownership abort message, including the NOINHERIT remedy', () => {
    // Round 7 reworded this from "is not a member of the owning role" (which
    // the file's own comment contradicts) to "does not inherit … (a NOINHERIT
    // member must SET ROLE <owner> first)". Measured: reverting that reword
    // left the whole suite green, so the fix was not regression-pinned.
    expect(raw).toContain(
      "does not inherit the owning role''s privileges (a NOINHERIT member must SET ROLE <owner> first)",
    )
    expect(raw).not.toMatch(/is not a member of the owning role/)
  })

  it('warns that the erased audit trail is unrecoverable after COMMIT', () => {
    // Accuracy matters at exactly the moment this is read. PostgreSQL DDL is
    // transactional: under the prescribed `psql -1`, ROLLBACK still restores
    // the table AND its rows until the transaction commits. Telling the
    // operator "irreversible, restore from backup" while ROLLBACK is still
    // available would send them to a backup they do not need yet.
    expect(raw).toMatch(/ROLLBACK still undoes this/)
    expect(raw).toMatch(/until this[\s\S]{0,40}transaction COMMITS/i)
    expect(raw).toMatch(/no SQL can bring append-only/i)
    expect(raw).toMatch(/verified restore/i)
    expect(raw).toMatch(/disposable rehearsal stack/i)
  })

  it('requires the authorisation to belong to THIS run, not to the environment', () => {
    // current_setting() cannot report provenance, so a persisted
    // `ALTER DATABASE/ROLE … SET` would pre-authorise every future session —
    // the same defect this file closes, relocated from psql flags to the GUC
    // layer. pg_db_role_setting is where those two forms are recorded (custom
    // placeholder GUCs never appear in pg_settings). Verified on PG 17.6.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    expect(inner).toMatch(/pg_db_role_setting/)
    expect(raw).toMatch(/is PERSISTED \(%\), not set for this run/)
    // split_part(), not LIKE: `_` is a LIKE wildcard (the MIN-A trap).
    expect(inner).toMatch(/split_part\(c, '=', 1\) = 'stella\.confirm_destroy_decisions'/)
    expect(inner).not.toMatch(/setconfig[\s\S]{0,80}LIKE/i)
    // Scoped to what could actually apply to this session, and to the value
    // that would actually authorise — an unrelated `ALTER ROLE other SET … =
    // 'false'`, or a setting on a different database of the same cluster,
    // authorises nothing and must not strand the emergency path.
    // Pinned as one span, not as three independent substrings: `WHERE (true OR
    // s.setdatabase = 0 …` widens the scope to every row in the catalog while
    // still containing each fragment, and a fragment-wise assertion would stay
    // green on it. Same lesson as the guard pairs above.
    //
    // session_user, NOT current_user, and an exact OID match rather than
    // membership: PostgreSQL applies pg_db_role_setting at session start via
    // process_settings(databaseid, GetSessionUserId()) — it keys on the LOGIN
    // role and never consults membership. A current_user-keyed filter FAILS
    // OPEN exactly where it matters: the ownership guard tells the operator to
    // re-run as the owning role, which they may do with SET ROLE, leaving
    // session_user as their login role — and a standing
    // `ALTER ROLE <login> SET … = 'true'` that DID authorise that session would
    // be filtered out. Pinned through the EXISTS body so `AND false` inside it
    // cannot silently disable the guard either.
    expect(inner).toMatch(
      /WHERE \(s\.setdatabase = 0\s+OR s\.setdatabase = \(SELECT oid FROM pg_database WHERE datname = current_database\(\)\)\)\s+AND \(s\.setrole = 0\s+OR s\.setrole = \(SELECT oid FROM pg_roles WHERE rolname = session_user\)\)\s+AND EXISTS \(\s+SELECT 1 FROM unnest\(s\.setconfig\) c\s+WHERE split_part\(c, '=', 1\) = 'stella\.confirm_destroy_decisions'\s+AND split_part\(c, '=', 2\) = 'true'\s+\);/,
    )
    expect(inner).not.toMatch(/pg_has_role\(current_user, s\.setrole/)

    // ...and the honest remainder is stated, not claimed away — including the
    // channels this catalog does NOT cover, or the paragraph would itself be a
    // verification declared and not performed.
    expect(raw).toMatch(/REMAINING HONEST LIMIT/)
    expect(raw).toMatch(/cannot distinguish an operator typing the SET from a wrapper script/)
    for (const channel of [
      /postgresql\.conf/,
      /ALTER SYSTEM SET/,
      /PGOPTIONS/,
      /connection-string `options=-c/,
    ]) {
      expect(raw, `unlisted persistence channel: ${channel}`).toMatch(channel)
    }
  })

  it('does not assume the provenance catalog is readable', () => {
    // pg_db_role_setting is a shared catalog whose SELECT privilege is
    // environment-dependent. Measured on the Supabase PG 17.6 image: it carries
    // an explicit grant to PUBLIC (`=r/supabase_admin`). A cluster that leaves
    // it restricted would make the provenance query die with a bare
    // `permission denied` — no 'stella_0003_rollback aborted:' prefix, on the
    // emergency path, after the operator was told destruction was authorised.
    // Fail-closed and prefixed instead: an unverifiable guard is a failed one.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    const at = (needle: string) => {
      const i = inner.indexOf(needle)
      expect(i, `missing from the DO block: ${needle}`).toBeGreaterThan(-1)
      return i
    }
    expect(at('has_table_privilege')).toBeLessThan(at('FROM pg_db_role_setting'))
    expect(raw).toMatch(/cannot verify that the authorisation belongs to THIS run/)
  })

  it('deliberately has NO dependent-object pre-check, and records why', () => {
    // A pg_depend pre-check was written and REMOVED. Two successive defects
    // proved the approach unsound: the first joined pg_class on d.objid and so
    // missed VIEWS entirely (a view depends via its pg_rewrite rule); the
    // second, rewritten over pg_describe_object, fired on the table's OWN RLS
    // policy and CHECK constraint — measured on PG 17.6 against the real
    // stella_0003 object set, it would have ABORTED EVERY RUN, empty table
    // included. Re-deriving findDependentObjects() in SQL is not this script's
    // job: a guard only SOMETIMES right about "would the DROP fail?" is worse
    // than none, because it invites belief.
    //
    // The real reason it was attractive — that the tempting alternative is an
    // EXCEPTION handler — is closed directly, by the test above.
    const inner = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(raw))![1]
    expect(inner).not.toMatch(/pg_depend/)
    expect(raw).toMatch(/NO DEPENDENT-OBJECT PRE-CHECK/)
    expect(raw).toMatch(/would have ABORTED EVERY RUN/)
    // Never CASCADE: this script does not reach into objects it does not own.
    expect(stripCommentsAndStrings(inner)).not.toMatch(/\bCASCADE\b/i)
  })

  it('still touches nothing beyond the one table it created', () => {
    expect(code).not.toMatch(/\bGRANT\b/i)
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i)
    expect(code).not.toMatch(/stella_interactions|audit_logs|sroi_calculation|evidence_chunks/i)
    expect(code).not.toMatch(/\bDROP (FUNCTION|TRIGGER|POLICY|INDEX|SCHEMA|EXTENSION)\b/i)
    expect(code).not.toMatch(/\bALTER TABLE\b/i)
    expectNoAnonOrPublicGrants(code)
  })
})

// -----------------------------------------------------------------------------
// MIN-1 CLOSURE (reaudit 2026-08-02) — the six abort messages, pinned end to end
// -----------------------------------------------------------------------------
// The GUARDS regexes above (review round 4) pin each guard's CONDITION plus a
// short PREFIX of its message — enough to prove the guard is armed, but not
// enough to prove the message's MIDDLE stayed intact. A mutation that removes
// a middle clause, inverts its meaning, swaps the remedy, or exchanges two
// messages wholesale passes every fragment assertion above unchanged, because
// none of them read past the point each fragment happens to stop.
//
// This block closes that gap by extracting the full literal text of each of
// the six `RAISE EXCEPTION 'stella_0003_rollback aborted: ...'` messages —
// decoding the SQL '' escape the same way stripCommentsAndStrings does — and
// comparing each one, in its fixed position, against a canonical constant
// with a semantic label. Exact equality (not `.includes()` / `.toMatch()`) is
// the point: a partial match would still pass if the middle were deleted or
// reordered, which is exactly the class MIN-1 flags.
describe('MIN-1 closure — the six abort messages, pinned end to end', () => {
  const raw = read('stella_0003_rollback.sql')

  /**
   * Extract every `RAISE EXCEPTION '...'` string literal from inside the DO
   * block, in source order, with the SQL `''` escape decoded to `'`.
   *
   * Comments are stripped FIRST via stripAllComments — the same helper every
   * other test in this describe file uses — so the header's own prose
   * example (`-- DO $$ ... RAISE EXCEPTION ... $$;`, line 84) can never be
   * mistaken for an executable RAISE EXCEPTION: it lives entirely behind a
   * `--` and stripAllComments removes the whole line before the DO $$ ... $$
   * block is even located.
   */
  function extractAbortMessages(sql: string): string[] {
    const doBlock = /DO \$\$([\s\S]*?)\$\$;/.exec(stripAllComments(sql))
    expect(doBlock, 'no DO $$ ... $$ block found').not.toBeNull()
    const body = doBlock![1]
    // Same escape-aware string pattern used elsewhere in this file
    // (stripCommentsAndStrings, the EXECUTABLE_SKELETON literal-blanking):
    // '' inside the literal is a doubled single quote, not a close-then-open.
    const literal = /RAISE EXCEPTION '((?:[^']|'')*)'/g
    const messages: string[] = []
    let m: RegExpExecArray | null
    while ((m = literal.exec(body))) {
      messages.push(m[1].replace(/''/g, "'"))
    }
    return messages
  }

  // One canonical, COMPLETE text per guard — prefix through final punctuation
  // — labelled semantically and kept in the same order the guards appear in
  // the file. A failing label says which guard's wording broke, not just
  // that some string somewhere in the file changed.
  const CANONICAL_MESSAGES: ReadonlyArray<readonly [string, string]> = [
    [
      'isolationPrecondition',
      "stella_0003_rollback aborted: transaction_isolation is %. This script's row count is only trustworthy under READ COMMITTED, where the count taken after the ACCESS EXCLUSIVE lock sees a fresh snapshot; under REPEATABLE READ or SERIALIZABLE it could read a pre-lock snapshot, count 0 on a populated table, and destroy the audit trail while reporting that nothing was lost. Re-run with SET TRANSACTION ISOLATION LEVEL READ COMMITTED, or clear default_transaction_isolation for this role/database",
    ],
    [
      'ownershipPrecondition',
      "stella_0003_rollback aborted: role % cannot drop public.stella_suggestion_decisions — either it does not own the table and does not inherit the owning role's privileges (a NOINHERIT member must SET ROLE <owner> first), or the table was dropped by another session since this script started. Re-run as the role that owns the table (the same role DATABASE_URL connects as, see stella_0003 §4b); if it is already gone, re-running is a clean no-op",
    ],
    [
      'forceRowLevelSecurity',
      "stella_0003_rollback aborted: FORCE ROW LEVEL SECURITY is ON for public.stella_suggestion_decisions. count(*) is subject to RLS, so this script cannot tell an empty table from one whose rows are merely invisible to this role — and would classify a populated audit trail as empty. This refusal is UNCONDITIONAL: it does not depend on who you are, so re-running as a BYPASSRLS role will not clear it. Turn FORCE off — the state stella_0003 verifies and the only route past this guard",
    ],
    [
      'destructionNotAuthorised',
      "stella_0003_rollback aborted: the table holds % row(s) and destruction was NOT authorised. Export them first, then re-run with: SET stella.confirm_destroy_decisions = 'true'; Record who authorised it and why in the gate log",
    ],
    [
      'provenanceCatalogUnreadable',
      "stella_0003_rollback aborted: cannot verify that the authorisation belongs to THIS run — role % has no SELECT on pg_catalog.pg_db_role_setting, the only catalog that records a persisted ALTER DATABASE/ROLE setting. Re-run as a role that can read it, or GRANT SELECT ON pg_catalog.pg_db_role_setting TO %, or confirm manually that no standing authorisation exists and record that confirmation in the gate log",
    ],
    [
      'authorisationPersisted',
      'stella_0003_rollback aborted: stella.confirm_destroy_decisions is PERSISTED (%), not set for this run. A standing authorisation pre-approves every future session and leaves no per-run human act to record. Remove it (ALTER DATABASE/ROLE … RESET stella.confirm_destroy_decisions), then authorise with a session SET in the session that performs the rollback',
    ],
  ] as const

  // Computed once, at describe-collection time — pure string parsing, no I/O
  // beyond the read() above — so every `it` below checks the same extraction.
  const messages = extractAbortMessages(raw)

  it('finds exactly six abort messages inside the DO block', () => {
    // Redundant with 'has exactly those six guards ...' above by design: that
    // test counts `RAISE EXCEPTION` occurrences; this one counts successfully
    // PARSED string literals following them. A RAISE EXCEPTION whose literal
    // could not be parsed (e.g. a stray unescaped quote) would pass the count
    // there and fail here.
    expect(messages).toHaveLength(CANONICAL_MESSAGES.length)
  })

  it.each(CANONICAL_MESSAGES.map((entry, index) => [index, ...entry] as const))(
    'message #%i (%s) is pinned COMPLETELY: prefix, explanation, context, remedy and punctuation',
    (index, label, expectedText) => {
      // Exact equality, not toMatch/toContain: a truncated, reordered or
      // partially-substituted message must fail here even though a shorter
      // substring of it would still be present.
      expect(messages[index], `message at index ${index} (${label})`).toBe(expectedText)
    },
  )

  it('has six DISTINCT messages — no guard silently duplicates another', () => {
    // Catches a mutant that overwrites one guard's message with a copy of a
    // different guard's message (still six RAISE EXCEPTIONs, still six
    // parseable literals, but two identical) — which the per-index equality
    // check above already rejects too, since the copy cannot match BOTH
    // canonical texts at once, but this makes the invariant explicit and
    // independent of the canonical constants.
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('every message keeps the stella_0003_rollback aborted: prefix', () => {
    for (const [index, message] of messages.entries()) {
      expect(message.startsWith('stella_0003_rollback aborted: '), `message ${index}`).toBe(true)
    }
  })
})

describe('review round 4 — destruction authorization is byte-exact', () => {
  const raw = read('stella_0003_rollback.sql')

  it('compares against the literal string true and nothing looser', () => {
    expect(raw).toMatch(
      /COALESCE\(current_setting\('stella\.confirm_destroy_decisions', true\), ''\) = 'true'/,
    )
  })

  it('has exactly ONE authorization expression, byte-for-byte', () => {
    // Enumerating rejected literals only proves the file contains no SECOND
    // comparison against them — it says nothing about what is ACCEPTED, and it
    // misses the widenings most likely to be introduced: `IN ('true','on')`
    // matches no `= 'on'` pattern, and neither do ILIKE, ANY() or SIMILAR TO.
    // Pin the accepting expression itself: unique, and exact to the byte. Any
    // widening at all — an added OR, a cast, a different operator — fails here.
    const authLines = raw.split('\n').filter((l) => /authorised\s*:=/.test(l))
    expect(authLines).toHaveLength(1)
    expect(authLines[0].trim().replace(/\r$/, '')).toBe(
      "authorised := COALESCE(current_setting('stella.confirm_destroy_decisions', true), '') = 'true';",
    )
  })

  it.each([
    ["'yes'", /=\s*'yes'/i],
    ["'y'", /=\s*'y'/i],
    ["'1'", /=\s*'1'/],
    ["'TRUE'", /=\s*'TRUE'/],
    ["'True'", /=\s*'True'/],
    ["'on'", /=\s*'on'/i],
  ])('carries no second comparison against %s', (_label, pattern) => {
    // Weaker than the exclusivity test above, and kept only as documentation
    // of the enumerated rejects verified in the dry-run. Named for what it
    // actually checks, so it is not mistaken for a behavioural guarantee.
    expect(raw).not.toMatch(pattern)
  })

  it('never coerces the setting instead of comparing it', () => {
    // ::boolean would turn 'yes', 'on', '1', 't' and 'TRUE' into true — the
    // exact widening this guard refuses.
    const code = stripCommentsAndStrings(raw)
    expect(code).not.toMatch(/confirm_destroy_decisions[^\n]*::\s*bool/i)
    expect(code).not.toMatch(/\blower\s*\(|\bupper\s*\(|\bbtrim\s*\(|\btrim\s*\(/i)
  })

  it('states the honest limit: an UNQUOTED SET x = TRUE cannot be distinguished', () => {
    // Measured on PostgreSQL 17.6: `SET x = TRUE` (bare keyword) is normalised
    // by the SET grammar and STORED as the string 'true', byte-identical to
    // `SET x = 'true'`. No SQL guard can tell them apart afterwards. The file
    // must say so rather than claim a strictness it does not have — the same
    // "declared but not performed" trap MAJ-B and MIN-2 closed elsewhere.
    expect(raw).toMatch(/HONEST LIMIT/)
    expect(raw).toMatch(/UNQUOTED/)
    expect(raw).toMatch(/STORES the string 'true'/)
    expect(raw).toMatch(/quoted\s*\n?--\s*literal 'TRUE'|refused is the quoted/i)
  })

  it('reads the setting with missing_ok = true so an unset GUC is not an error', () => {
    // current_setting(name) without the second argument RAISES when the GUC was
    // never set — which on an unauthorised run would abort with the wrong
    // message ("unrecognized configuration parameter") instead of the guard's.
    expect(raw).toMatch(/current_setting\('stella\.confirm_destroy_decisions', true\)/)
    expect(raw).not.toMatch(/current_setting\('stella\.confirm_destroy_decisions'\)/)
  })
})

describe('G2 verification must not use the ambiguous grants view', () => {
  const g2 = readFileSync(
    path.resolve(process.cwd(), 'docs', 'ops', 'gates', 'G2_PACKAGE.md'),
    'utf8',
  )

  it('checks stella_suggestion_decisions grants via aclexplode, not role_table_grants', () => {
    // information_schema.role_table_grants expands privileges reached through
    // role MEMBERSHIP, and postgres is a member of authenticated/service_role
    // in Supabase — so it returns owner and inherited rows and reads as a false
    // red. Measured on this stack: 11 rows vs 4 real direct grants.
    const section = g2.slice(g2.indexOf('-- 6.'), g2.indexOf('-- 7.'))
    expect(section).not.toMatch(/role_table_grants\s*\n?\s*WHERE/i)
    expect(section).toMatch(/aclexplode\(COALESCE\(c\.relacl, acldefault\('r', c\.relowner\)\)\)/)
    expect(section).toMatch(/a\.grantee = 0/) // PUBLIC check
  })

  it('explains why the view is wrong, so it does not come back', () => {
    expect(g2).toMatch(/NO uses information_schema\.role_table_grants/)
    expect(g2).toMatch(/MEMBRESÍA|membres/i)
    expect(g2).toMatch(/falso rojo/i)
  })
})

describe('retention policy states the real FK semantics', () => {
  const pol = readFileSync(
    path.resolve(process.cwd(), 'docs', 'ops', 'STELLA_RETENTION_POLICY.md'),
    'utf8',
  )

  it('no longer claims an organizational delete cascade', () => {
    expect(pol).toMatch(/NO existe ninguna cascada/i)
    expect(pol).toMatch(/NO ACTION/)
  })

  it('says the rows BLOCK the parent delete and what to do first', () => {
    expect(pol).toMatch(/bloquean/i)
    expect(pol).toMatch(/violates foreign key constraint/)
    expect(pol).toMatch(/Exportar/i)
  })

  it('records that nothing is automated and that 4.2 is now trigger-blocked', () => {
    expect(pol).toMatch(/NO está automatizado/i)
    expect(pol).toMatch(/bloqueada por el trigger append-only/i)
  })
})

describe('the hardening did not touch the drizzle chain', () => {
  it('db/schema.ts does not mention the gate-managed tables', () => {
    const schema = readFileSync(path.resolve(process.cwd(), 'db', 'schema.ts'), 'utf8')
    expect(schema).not.toMatch(/stella_suggestion_decisions|suggestionDecisions/)
    expect(schema).not.toMatch(/evidence_chunks|evidenceChunks/)
  })

  it('no migration references the prepared scripts', () => {
    const journal = readFileSync(
      path.resolve(process.cwd(), 'db', 'migrations', 'meta', '_journal.json'),
      'utf8',
    )
    expect(journal).not.toContain('stella_0003')
    expect(journal).not.toContain('stella_0002b')
  })
})

// ---------------------------------------------------------------------------
// Independent review round 2 (2026-08-01) — M1 + m1..m7
// ---------------------------------------------------------------------------
// Regression tests for the findings of the second independent review of the
// stella_0003 pre-apply hardening. Each names the finding it closes.

describe('review round 2 — stella_0003 forward', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('M1: never aborts because evidence_chunks exists', () => {
    // grounding_0001 legitimately creates public.evidence_chunks on the SAME
    // database under its own gate (G5 P3). Raising here would make every
    // re-run of this script abort once that gate is applied, breaking the
    // convergence the header promises. The real invariant — that THIS file
    // never creates it — is static and covered offline.
    expect(code).not.toMatch(/evidence_chunks/i)
    expect(raw).toMatch(/NOT CHECKED AT RUNTIME, deliberately/)
    expect(raw).toMatch(/grounding_0001_evidence_chunks\.sql legitimately creates/)
  })

  it('m1: drops the pg_default_acl check that could never fire', () => {
    // defaclacl is aclitem[] — 'grantee=privs/grantor' — and never contains a
    // table name, so position('stella_suggestion_decisions' in ...) was always
    // 0: a check that reported itself verified while being unfalsifiable.
    expect(code).not.toMatch(/pg_default_acl/)
    expect(raw).toMatch(/unfalsifiable/)
  })

  it('m2: requires FORCE ROW LEVEL SECURITY to be OFF, in both places', () => {
    // The whole write path rests on the owner bypassing RLS. With FORCE ON the
    // owner stops bypassing and, with no INSERT policy, every write fails —
    // while the script would still report VERIFIED.
    expect(code).toMatch(/relforcerowsecurity/)
    expect([...code.matchAll(/relforcerowsecurity/g)].length).toBeGreaterThanOrEqual(2)
    expect(raw).toMatch(/FORCE ROW LEVEL SECURITY is ON/)
  })

  it('m3: resolves the writer OID by rolname, never through ::regrole', () => {
    // regrolein parses its argument as an SQL identifier: it lowercases
    // unquoted input and splits on dots, so a role named "AppWriter" or
    // "app.writer" would pass the existence check and then fail resolving.
    expect(code).not.toMatch(/::regrole/)
    expect(code).toMatch(/SELECT oid INTO writer_oid FROM pg_roles WHERE rolname = writer/)
    expect(code).toMatch(/a\.grantee = writer_oid/)
  })

  it('m4: the decision CHECK must contain the four states AND no others', () => {
    // position() proves presence, not exclusivity: a stale CHECK also allowing
    // 'deleted' would satisfy four probes and pass.
    expect(code).toMatch(/regexp_matches\(def/)
    expect(raw).toMatch(/Presence is not exclusivity/)
    expect(raw).toMatch(/allows unexpected state\(s\)/)
  })

  it('m5: a grantable SELECT is not treated as the allowed plain SELECT', () => {
    // authenticated=r*/postgres would let authenticated re-grant SELECT to anon.
    expect(code).toMatch(/NOT a\.is_grantable/)
  })

  it('m6: rejects extra columns, extra FKs, and non-NO-ACTION delete rules', () => {
    expect(raw).toMatch(/expected exactly 11 columns/)
    expect(raw).toMatch(/expected exactly 4 foreign keys/)
    // confdeltype 'a' = NO ACTION — a deliberate invariant per RK-04f.
    // Read `raw`: stripCommentsAndStrings blanks the 'a' literal.
    expect(raw).toMatch(/c\.confdeltype = 'a'/)
    expect(raw).toMatch(/not ON DELETE NO ACTION/)
  })

  it('m7: refuses a PostgREST role as the declared writer', () => {
    expect(raw).toMatch(/declared writer role % is a PostgREST role/)
  })
})

describe('review round 2 — stella_0003 rollback authorization', () => {
  const raw = read('stella_0003_rollback.sql')

  it("accepts only the exact string 'true' as destruction authorization", () => {
    // No ambiguous values: 'yes', 'y', '1' and anything else must NOT authorise
    // erasing an audit trail.
    expect(raw).toMatch(/current_setting\('stella\.confirm_destroy_decisions', true\), ''\) = 'true'/)
    expect(raw).not.toMatch(/= 'yes'/)
    // The file must show an invocation that ACTUALLY WORKS. It previously only
    // said "SET …; then run this file", which is false for a separate
    // `psql -c` run (different session) and the obvious workaround
    // (`ALTER DATABASE/ROLE … SET`) is refused by the persistence guard. So
    // require the single-session form, and require the file to say why a
    // separate invocation does not work.
    expect(raw).toMatch(/-c "SET stella\.confirm_destroy_decisions='true'"/)
    expect(raw).toMatch(/A SEPARATE `psql -c "SET …"` invocation does NOT work/)
    expect(raw).toMatch(/it is a different\n--   session/)
  })
})

// ---------------------------------------------------------------------------
// Review round 3 (2026-08-01) — MAJOR-1: the OFFLINE CODE TEST §4b cites
// ---------------------------------------------------------------------------
// stella_0003 §4b splits its assurance into three parts and names this file as
// part 2: "the application's only write path is db/client.ts (postgres-js over
// DATABASE_URL), not a service_role/PostgREST client".
//
// That claim was TRUE but UNENFORCED — nothing tested it. Which is exactly the
// defect M1 and m1 closed elsewhere in this package: a verification declared
// and not performed. It is load-bearing here, because it is the stated reason
// the SQL guard is allowed to stop where it does.

const REPO = process.cwd()
const readRepo = (...p: string[]) => readFileSync(path.join(REPO, ...p), 'utf8')

describe('MAJOR-1 — the write path stella_0003 §4b relies on is pinned here', () => {
  const client = readRepo('db', 'client.ts')
  const decisions = readRepo('app', 'actions', 'stella', 'decisions.ts')

  it('db/client.ts is a direct postgres-js connection, not a supabase-js client', () => {
    // If this ever became a supabase-js client, the writer would stop being the
    // role the connection authenticates as and the SQL guard's owner check
    // would be verifying the wrong thing.
    expect(client).toMatch(/from 'postgres'/)
    expect(client).toMatch(/drizzle\(sql, \{ schema \}\)/)
    expect(client).not.toMatch(/createClient|@supabase\/supabase-js/)
    expect(client).not.toMatch(/SERVICE_ROLE/)
  })

  // CORRECTED BY THE RUNTIME CUTOVER (stella_0005).
  //
  // This used to assert `connectionString: process.env.DATABASE_URL`, and it
  // passed for as long as that was true — which is the problem. §4b's reasoning
  // rested on "the writer is the DATABASE_URL role", and nobody checked WHICH
  // role that was. It was `postgres`: the table owner, exempt from RLS, holding
  // BYPASSRLS and CREATEROLE.
  //
  // The property worth pinning was never "the runtime reads DATABASE_URL". It
  // is "the runtime reads a variable that can only ever name the
  // least-privilege role", which is what the assertions below check.
  it('the default client resolves the RUNTIME variable, never the shared one', () => {
    expect(client).toMatch(/resolveRuntimeDatabaseUrl\(\)/)
    expect(client).toMatch(/capability: defaultRestriction\?\.capability \?\? 'app_runtime'/)
    // No fallback, anywhere in the file. A `?? process.env.DATABASE_URL` would
    // restore the administrative connection the first time the new variable was
    // missing — silently, and only in the environment where it was forgotten.
    expect(client).not.toMatch(/process\.env\.DATABASE_URL/)
  })

  it('the runtime resolver pins the expected role and refuses administrative ones', () => {
    const resolver = readRepo('db', 'safety', 'resolve-capability-database-url.ts')
    expect(resolver).toMatch(/RUNTIME_DATABASE_ROLE/)
    expect(resolver).toMatch(/FORBIDDEN_RUNTIME_DATABASE_ROLES/)
    // The expected role must not be reachable from configuration: a check a
    // caller can retarget is not a check.
    expect(resolver).not.toMatch(/expectedRole\s*=\s*env\[/)
  })

  it('recordStellaDecision writes through that client, not through supabase-js', () => {
    expect(decisions).toMatch(/import \{ db \} from '@\/db\/client'/)
    expect(decisions).toMatch(/db\.execute\(/)
    // No PostgREST/service-role path to this table.
    expect(decisions).not.toMatch(/@supabase\/supabase-js/)
    expect(decisions).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(decisions).not.toMatch(/createClient\(/)
  })

  it('no other module reaches stella_suggestion_decisions at all', () => {
    // The SQL grants authenticated SELECT and service_role nothing. If some
    // other module started reading or writing this table through PostgREST,
    // that posture would need revisiting — so fail loudly if one appears.
    const roots = ['app', 'lib', 'components']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue
          walk(full)
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const src = readFileSync(full, 'utf8')
          // Ignore comments: several files legitimately DESCRIBE the table.
          const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
          if (code.includes('stella_suggestion_decisions')) {
            offenders.push(path.relative(REPO, full).replace(/\\/g, '/'))
          }
        }
      }
    }
    for (const r of roots) {
      const dir = path.join(REPO, r)
      if (existsSync(dir)) walk(dir)
    }
    // decisions.ts is the one legitimate consumer (its INSERT).
    expect(offenders.sort()).toEqual(['app/actions/stella/decisions.ts'])
  })

  it('stella_0003 §4b describes this split honestly and points at a real test', () => {
    const sql = read('stella_0003_suggestion_decisions.sql')
    expect(sql).toMatch(/OFFLINE CODE TEST/)
    // The cited file must be this one, and it must actually read db/client.ts.
    expect(sql).toMatch(/tests\/prepared-stella-sql\.test\.ts/)
  })
})

describe('review round 3 — MINOR-2..7', () => {
  const raw = read('stella_0003_suggestion_decisions.sql')
  const code = stripCommentsAndStrings(raw)

  it('MINOR-2: the (19) comment attributes enforcement to the right test', () => {
    // It previously credited prepared-sql-source-of-truth.test.ts, which only
    // isolates the drizzle chain, and claimed the script "does not mention
    // evidence_chunks anywhere" — literally false, it appears in comments.
    expect(raw).toMatch(/EXECUTABLE sql never mentions evidence_chunks/)
    expect(raw).toMatch(/tests\/prepared-stella-sql\.test\.ts pins/)
    expect(raw).not.toMatch(/tests\/prepared-sql-source-of-truth\.test\.ts enforces the separation/)
  })

  it('MINOR-3: literal extraction is not limited to [a-z_]', () => {
    // `'([a-z_]+)'` produced NO match for 'accepted2', 'Deleted' or 'v2', so a
    // stale CHECK admitting them passed the exclusivity test silently.
    // Read `raw`: stripCommentsAndStrings blanks the SQL pattern literal.
    // Both call sites (section 2 reconciliation and section 7 verification)
    // must use the wide class.
    const calls = [...raw.matchAll(/regexp_matches\(def, '''([^\n]*?)''', 'g'\)/g)].map((m) => m[1])
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c).toBe("([^'']+)")
  })

  it('MINOR-4: section 2 reconciles on the same test section 7 enforces', () => {
    // Otherwise a pre-existing SUPERSET CHECK survived reconciliation and then
    // made the final verification abort the whole transaction — the header
    // promises convergence, not a noisy failure.
    const sec2 = raw.slice(raw.indexOf('-- 2. CHECK reconciliation'), raw.indexOf('-- 3. Indexes'))
    expect(sec2).toMatch(/regexp_matches/)
    expect(sec2).toMatch(/lit NOT IN \('accepted', 'accepted_edited', 'rejected', 'undone'\)/)
  })

  it('MINOR-5: PUBLIC is revoked and then verified', () => {
    // PUBLIC is grantee OID 0 and has no pg_roles row, so a JOIN to pg_roles
    // cannot see it. Revoke by construction, and check it explicitly.
    expect(code).toMatch(/REVOKE ALL ON public\.stella_suggestion_decisions FROM PUBLIC/i)
    expect(code).toMatch(/a\.grantee = 0/)
    expect(raw).toMatch(/PUBLIC holds privilege\(s\)/)
  })

  it('MINOR-A: the "no ALTER DEFAULT PRIVILEGES" claim is actually enforced', () => {
    // The (20) comment says this is "a static property enforced offline".
    // Nothing enforced it — the same declared-but-unverified defect MINOR-2
    // closed two lines above. Global default privileges are RK-04c's territory
    // and belong to a cross-cutting gate, never to a single-table script.
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i)
    const rollback = read('stella_0003_rollback.sql')
    expect(stripCommentsAndStrings(rollback)).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i)
  })

  it('MINOR-C: narrowing the CHECK reports offending states, not a bare PG error', () => {
    // Rebuilding a CHECK that existing rows violate fails with PostgreSQL's
    // generic 'check constraint "..." is violated by some row' — without the
    // 'stella_0003 aborted:' prefix the header and the G2 abort criteria tell
    // the operator to look for. Report the distinct STATES (never row data).
    expect(raw).toMatch(/existing rows hold decision state\(s\) outside the contract/)
    expect(code).toMatch(/string_agg\(DISTINCT d\.decision/)
    expect(raw).toMatch(/No row data is shown, only the distinct states/)
  })

  it('MINOR-6: a standalone UNIQUE index is caught, not just a constraint', () => {
    // CREATE UNIQUE INDEX enforces uniqueness without creating a constraint.
    expect(code).toMatch(/FROM pg_index i/)
    expect(code).toMatch(/i\.indisunique AND NOT i\.indisprimary/)
    expect(raw).toMatch(/unexpected UNIQUE index\(es\)/)
  })
})

describe('review round 3 — documentation is in sync with the SQL', () => {
  const readme = readFileSync(path.join(PREPARED, 'README.md'), 'utf8')
  const g2 = readFileSync(
    path.resolve(process.cwd(), 'docs', 'ops', 'gates', 'G2_PACKAGE.md'),
    'utf8',
  )

  it('MINOR-1: the registry no longer claims the two removed checks', () => {
    expect(readme).not.toMatch(/20 comprobaciones/)
    expect(readme).toMatch(/18 comprobaciones/)
    // ...and says explicitly which two went, so they are not reintroduced.
    expect(readme).toMatch(/Dos comprobaciones fueron retiradas/)
    expect(readme).toMatch(/infalsificable/)
  })

  it('MINOR-7: every documented apply path says how to declare the writer', () => {
    // `supabase db execute --file` and the SQL Editor cannot emit a prior SET,
    // so without ALTER DATABASE ... SET they always land in ASSUMPTION mode.
    expect(g2).toMatch(/ALTER DATABASE .* SET stella\.writer_role/)
    expect(g2).toMatch(/supabase db execute --file/)
    expect(g2).toMatch(/rama ASSUMPTION/)
  })
})
