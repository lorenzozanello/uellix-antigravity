// tests/stella-audit-log-write-capability.test.ts
//
// G1-B PRECONDITIONS — P0: audit_logs INSERT is SAFE_BUT_FUNCTIONALLY_BLOCKED.
//
// ---------------------------------------------------------------------------
// THE MEASURED FINDING
// ---------------------------------------------------------------------------
// On the hosted staging project, `public.audit_logs` has RLS ENABLED and
// EXACTLY ONE policy. From the most recent catalog observation in this
// repository, `artifacts/hosted-chain-posture-observation-postcred.json`:
//
//     { name: 'audit_logs_select_member_or_admin', command: 'SELECT', ... }
//
// There is no INSERT policy. `uellix_app` is NOBYPASSRLS and does not own the
// table, so `INSERT INTO audit_logs` is refused by row-level security — even
// though `stella_hosted_0007` grants `INSERT` on the table to `uellix_writer`,
// which `uellix_app` inherits. The GRANT is present and the POLICY is not, so
// the posture is safe (nothing unauthorised can write) and functionally dead
// (nothing authorised can either).
//
// The local database does not have this gap: `stella_0005c` creates the policy.
// But stella_0005/0005c are LOCAL-ONLY packages — they are not members of
// HOSTED_CHAIN and appear in no hosted manifest — so the hosted side never
// received them. That asymmetry is the whole defect.
//
// ---------------------------------------------------------------------------
// WHY THIS BLOCKS G1-B
// ---------------------------------------------------------------------------
// The G1-B happy path is required to leave an audit event. It cannot:
// `logStellaAudit` in app/actions/stella/advisor.ts is fire-and-forget by
// design — an audit failure must never change a user-facing Stella result — so
// today the write fails, a `console.error` is emitted, and the operation
// reports success. A certification that asserts "audit event persisted" would
// be asserting something that has never happened on that database.
//
// ---------------------------------------------------------------------------
// THE REMEDIATION, AND ITS TWO HALVES
// ---------------------------------------------------------------------------
//   1. `stella_hosted_0008_audit_log_write_capability.sql` creates the missing
//      INSERT policy — the SAME policy stella_0005c creates locally, character
//      for character in its WITH CHECK, scoped `TO uellix_app`. It opens no
//      client path: `authenticated`, `service_role` and `anon` get no policy
//      and no grant, so for them RLS still denies by default.
//   2. The failure stops being silent. An audit write that fails now reports
//      through `reportStellaFailure(..., 'AUDIT_ERROR', ...)` as well as the
//      console, so the difference between "audit landed" and "audit was
//      swallowed" is observable during G1-B instead of being inferred.
//
// This suite is OFFLINE and asserts the package's TEXT plus the reporting
// behaviour. The live-database proof is tests/database-insert-policy-scope.ts,
// which runs against the local stack.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const PREPARED = path.join(ROOT, 'db', 'prepared')
const FORWARD = path.join(PREPARED, 'stella_hosted_0008_audit_log_write_capability.sql')
const ROLLBACK = path.join(PREPARED, 'stella_hosted_0008_rollback.sql')
const LOCAL_CANON = path.join(PREPARED, 'stella_0005c_runtime_policy_scope.sql')

/**
 * Drop `--` comment lines.
 *
 * These packages carry their whole argument in prose, and the argument
 * necessarily QUOTES the shapes it forbids ("a policy with no TO clause is TO
 * PUBLIC", "the `actor_user_id IS NULL` branch was dropped"). A scanner that
 * cannot tell a comment from a statement would force the fix to ship without
 * its reasoning — so every shape assertion below runs on statements only.
 */
function statementsOnly(sql: string): string {
  return sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
}

/** Collapse whitespace so an assertion is about SQL, not about indentation. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * Comments AND single-quoted literals stripped — EXECUTABLE SQL only.
 *
 * The sibling hosted suites already do this, and G1-B is the revision that made
 * it necessary here: the package's refusal messages deliberately NAME the
 * statements it must not issue ("It issues no ALTER TABLE ... OWNER TO", "the
 * identity that would issue the policy DDL cannot resolve auth.uid()"). A
 * scanner that could not tell an error string from a statement would fail on
 * the sentence that PROVES the property it is checking — and the way to pass it
 * would be to delete the explanation.
 *
 * Shape assertions run on this. Assertions ABOUT the prose run on
 * statementsOnly, where the prose still exists.
 */
function codeOnly(sql: string): string {
  return statementsOnly(sql).replace(/'(?:[^']|'')*'/g, "''")
}

describe('stella_hosted_0008 closes the hosted audit_logs INSERT gap', () => {
  it('the forward package and its rollback both exist', () => {
    expect(existsSync(FORWARD)).toBe(true)
    expect(existsSync(ROLLBACK)).toBe(true)
  })

  const forward = () => statementsOnly(readFileSync(FORWARD, 'utf8'))

  it('creates the INSERT policy scoped TO uellix_app', () => {
    const sql = normalize(forward())
    expect(sql).toMatch(
      /CREATE POLICY audit_logs_insert_member_or_admin ON public\.audit_logs FOR INSERT TO uellix_app WITH CHECK/i
    )
  })

  it('binds the actor to the session and the row to the caller\'s organization', () => {
    const sql = normalize(forward())
    // Actor binding: no NULL actor, no actor chosen by the caller.
    expect(sql).toContain('actor_user_id = auth.uid()')
    expect(sql).not.toMatch(/actor_user_id IS NULL/i)
    // Tenant binding: the row's organization must be one the session belongs to
    // (or the caller is a super admin) — the same predicate the SELECT policy
    // and stella_0005c use.
    expect(sql).toContain('current_user_org_ids()')
    expect(sql).toContain('current_user_is_super_admin()')
    expect(sql).toMatch(/organization_id IS NOT NULL/i)
  })

  it('is the SAME predicate the local canon installs — not a hosted variant', () => {
    // A hosted policy that were merely SIMILAR to the local one would mean two
    // tenancy rules to review instead of one. The WITH CHECK bodies are
    // compared after whitespace normalisation.
    const body = (sql: string): string => {
      const n = normalize(sql)
      const start = n.indexOf('CREATE POLICY audit_logs_insert_member_or_admin')
      expect(start).toBeGreaterThanOrEqual(0)
      const end = n.indexOf(';', start)
      return n.slice(start, end)
    }
    expect(body(forward())).toBe(body(statementsOnly(readFileSync(LOCAL_CANON, 'utf8'))))
  })

  it('opens NO path for a client role', () => {
    const sql = forward()
    // No policy and no grant for the PostgREST-reachable roles. `authenticated`
    // holding INSERT on audit_logs plus a TO PUBLIC policy is exactly the M1
    // finding stella_0005c closed locally; this package must not reintroduce it.
    expect(sql).not.toMatch(/GRANT[\s\S]{0,200}?TO\s+(authenticated|service_role|anon)\b/i)
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,400}?TO\s+(authenticated|service_role|anon|public)\b/i)
  })

  it('touches nothing but that one policy', () => {
    const sql = codeOnly(readFileSync(FORWARD, 'utf8'))
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i)
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b(?![\s\S]{0,80}ENABLE ROW LEVEL SECURITY)/i)
    expect(sql).not.toMatch(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i)
    expect(sql).not.toMatch(/\bCREATE\s+ROLE\b/i)
    expect(sql).not.toMatch(/\bALTER\s+ROLE\b/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    // Exactly one CREATE POLICY.
    expect(sql.match(/CREATE POLICY/gi) ?? []).toHaveLength(1)
  })

  it('asserts the end state instead of assuming it', () => {
    const sql = forward()
    expect(sql).toMatch(/pg_policies|pg_policy/i)
    expect(sql).toMatch(/RAISE EXCEPTION/)
  })

  it('the rollback removes exactly that policy and nothing else', () => {
    const sql = statementsOnly(readFileSync(ROLLBACK, 'utf8'))
    expect(sql).toMatch(/DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public\.audit_logs/i)
    expect(sql.match(/DROP POLICY/gi) ?? []).toHaveLength(1)
    expect(sql).not.toMatch(/CREATE POLICY/i)
    expect(sql).not.toMatch(/\bGRANT\b/i)
  })
})

/**
 * THE IDENTITY CONTRACT, and the finding that produced it.
 *
 * The first revision demanded `current_user = 'uellix_owner'` and called that
 * role the owner of the policies on public.audit_logs. MEASURED, in
 * artifacts/hosted-chain-posture-observation-postcred.json — the file the
 * package itself quotes — the hosted owner is `postgres`:
 * stella_hosted_0001 §399 transfers exactly ONE relation to uellix_owner and
 * stella_hosted_0007 verifies that none moved afterwards.
 *
 * So the package was UNAPPLIABLE from both sides. As uellix_owner the policy DDL
 * raises 42501 `must be owner of relation audit_logs`; as the identity that IS
 * the owner the precondition aborted. Every `it` below is a shape that would let
 * that class of defect back in.
 *
 * The behavioural half is not linted, it is MEASURED:
 * scripts/audit-capability-identity-dry-run.sh drives both branches, the
 * fail-closed third case and both rollbacks on a disposable PostgreSQL 17.6.
 */
describe('stella_hosted_0008 measures the owner instead of naming one', () => {
  const forward = () => statementsOnly(readFileSync(FORWARD, 'utf8'))
  const rollback = () => statementsOnly(readFileSync(ROLLBACK, 'utf8'))

  it.each([
    ['forward', () => forward()],
    ['rollback', () => rollback()],
  ])('%s: does not gate on a hardcoded owner name', (_label, read) => {
    const sql = read()
    // The exact predicate that made the package unappliable, and every near
    // neighbour of it. A gate written over a role LITERAL is the defect; a gate
    // written over the measured owner is the fix.
    expect(sql).not.toMatch(/current_user\s*<>\s*'uellix_owner'/)
    expect(sql).not.toMatch(/current_user\s*<>\s*'postgres'/)
    expect(sql).not.toMatch(/session_user\s*<>\s*'uellix_owner'/)
  })

  it.each([
    ['forward', () => forward()],
    ['rollback', () => rollback()],
  ])('%s: reads the owner out of pg_class.relowner', (_label, read) => {
    const sql = read()
    expect(sql).toMatch(/pg_get_userbyid\(c\.relowner\)/)
    expect(sql).toMatch(/'public\.audit_logs'::regclass/)
    // and COMPARES it against the session rather than against a literal
    expect(sql).toMatch(/v_owner\s*=\s*current_user/)
  })

  it('proceeds with NO role switch when the session already owns the table', () => {
    const sql = forward()
    // The hosted posture today. A package that issued `SET ROLE` here would
    // teach the next reader that the window is unconditional, which is the one
    // thing the OWNER_ASSUMABLE branch must not be confused with.
    expect(sql).toMatch(/SESSION_IS_OWNER/)
    expect(sql).toMatch(/set_config\('uellix\.h0008_assume_owner',\s*'no',\s*true\)/)
    expect(sql).toMatch(/IF v_decision = 'yes' THEN\s*\n\s*SET LOCAL ROLE uellix_owner;/)
  })

  it('switches role ONLY to an owner the session can actually assume', () => {
    const sql = forward()
    // The anti-seizure guard. Written over pg_has_role, and admitting EITHER
    // USAGE or SET, because on managed Supabase the membership is granted
    // WITH INHERIT FALSE, SET TRUE — so USAGE alone would refuse the one
    // session for which the operation is genuinely available.
    expect(sql).toMatch(/pg_has_role\(current_user, 'uellix_owner', 'USAGE'\)/)
    expect(sql).toMatch(/pg_has_role\(current_user, 'uellix_owner', 'SET'\)/)
    expect(sql).toMatch(/OWNER_ASSUMABLE/)
  })

  it.each([
    ['forward', () => forward()],
    ['rollback', () => rollback()],
  ])('%s: fails closed when it can neither be nor assume the owner', (_label, read) => {
    const sql = read()
    expect(sql).toMatch(/is neither that role nor able to assume it/)
    // The refusal NAMES the owner it measured, so the operator learns the fact
    // rather than being told to try again.
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,600}?v_owner, current_user/)
  })

  it('refuses in advance when the issuing identity cannot resolve auth.uid()', () => {
    // The second wall, found by the dry-run: CREATE POLICY analyses its WITH
    // CHECK at creation time, and on managed Supabase schema `auth` is owned by
    // supabase_admin and admits postgres but not the uellix_* roles. Without
    // this the OWNER_ASSUMABLE branch dies inside the DDL with `permission
    // denied for schema auth`, hundreds of lines after every identity check
    // passed.
    const sql = forward()
    expect(sql).toMatch(/has_schema_privilege\(v_issuer, 'auth', 'USAGE'\)/)
    expect(sql).toMatch(/has_function_privilege\(v_issuer, 'auth\.uid\(\)', 'EXECUTE'\)/)
    expect(sql).toMatch(/cannot resolve auth\.uid\(\)/)
  })

  it.each([
    ['forward', () => forward()],
    ['rollback', () => rollback()],
  ])('%s: gives the session back, and asserts it did', (_label, read) => {
    const sql = read()
    expect(sql).toMatch(/RESET ROLE;/)
    // Asserted on BOTH branches, not only on the one that could fail: a check
    // that ran only where it can fail is not a guarantee anyone can read.
    expect(sql).toMatch(/IF current_user <> session_user THEN/)
  })

  it.each([
    ['forward', () => forward()],
    ['rollback', () => rollback()],
  ])('%s: never transfers ownership, and proves the owner did not move', (_label, read) => {
    const sql = read()
    const code = codeOnly(read())
    // The fix this package explicitly did NOT take. Moving public.audit_logs to
    // uellix_owner would make the package appliable by changing the hosted
    // ownership topology stella_hosted_0007 was just certified against.
    expect(code).not.toMatch(/OWNER\s+TO/i)
    expect(sql).toMatch(/v_owner_now <> v_owner_pre/)
  })

  it('proves it granted nothing, by comparing the ACL rather than by claiming it', () => {
    const sql = forward()
    expect(sql).toMatch(/set_config\('uellix\.h0008_acl_pre'/)
    expect(sql).toMatch(/v_acl_now IS DISTINCT FROM v_acl_pre/)
    expect(sql).not.toMatch(/^\s*GRANT\b/im)
    expect(sql).not.toMatch(/^\s*REVOKE\b/im)
  })

  it('keeps RLS enabled, and checks that too', () => {
    const sql = forward()
    expect(sql).toMatch(/v_rls_now IS DISTINCT FROM true/)
    expect(sql).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i)
  })

  it('reads an unset identity decision as a refusal, never as "no switch needed"', () => {
    // A ROLLBACK TO SAVEPOINT between the two blocks leaves the setting as the
    // empty string rather than as NULL — which is why NULLIF is not decoration.
    for (const sql of [forward(), rollback()]) {
      expect(sql).toMatch(/NULLIF\(current_setting\('uellix\.h0008r?_assume_owner', true\), ''\)/)
      expect(sql).toMatch(/IF v_decision IS NULL THEN/)
    }
  })

  it('composes no identifier from a variable — the decision is measured, the role is a literal', () => {
    // The reason the fallback role is spelled statically: dynamic DDL is
    // refused across every prepared script, and stella_hosted_0007 §0.5b
    // resolved the same tension the same way.
    for (const file of [FORWARD, ROLLBACK]) {
      const code = codeOnly(readFileSync(file, 'utf8'))
      expect(code).not.toMatch(/\bformat\s*\(/i)
      expect(code).not.toMatch(/\bEXECUTE\b(?!\s*(?:FUNCTION\b|PROCEDURE\b|ON\b|''))/i)
    }
  })
})

describe('the measured dry-run that drives both identity branches exists', () => {
  const HARNESS = path.join(ROOT, 'scripts', 'audit-capability-identity-dry-run.sh')

  it('is checked in, and drives both packages', () => {
    expect(existsSync(HARNESS)).toBe(true)
    const sh = readFileSync(HARNESS, 'utf8')
    expect(sh).toContain('stella_hosted_0008_audit_log_write_capability.sql')
    expect(sh).toContain('stella_hosted_0008_rollback.sql')
    expect(sh).toContain('stella_0020_stella_interactions_model_default.sql')
    expect(sh).toContain('stella_0020_rollback.sql')
  })

  it('exercises both branches and the fail-closed third case', () => {
    const sh = readFileSync(HARNESS, 'utf8')
    expect(sh).toContain('SESSION_IS_OWNER')
    expect(sh).toContain('OWNER_ASSUMABLE')
    expect(sh).toContain('FAIL-CLOSED')
  })

  it('touches nothing persistent — no stack, no network, no volume', () => {
    const sh = readFileSync(HARNESS, 'utf8')
    expect(sh).toContain('--network none')
    expect(sh).toMatch(/docker rm -f/)
    expect(sh).not.toMatch(/supabase (start|db)/)
    // No hosted target can be reached from it, by construction.
    expect(sh).not.toContain('supabase.co')
  })
})

describe('db/prepared/README.md registers the package', () => {
  const readme = readFileSync(path.join(PREPARED, 'README.md'), 'utf8')
  it('names the forward script', () => {
    expect(readme).toContain('stella_hosted_0008_audit_log_write_capability.sql')
  })
  it('names the rollback script', () => {
    expect(readme).toContain('stella_hosted_0008_rollback.sql')
  })
})
