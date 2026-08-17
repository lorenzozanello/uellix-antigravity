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
    const sql = forward()
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

  it('refuses to run as the wrong identity', () => {
    expect(forward()).toMatch(/current_user\s*<>\s*'uellix_owner'/)
  })

  it('asserts the end state instead of assuming it', () => {
    const sql = forward()
    expect(sql).toMatch(/pg_policies|pg_policy/i)
    expect(sql).toMatch(/RAISE EXCEPTION/)
  })

  it('the rollback drops exactly that policy and nothing else', () => {
    const sql = statementsOnly(readFileSync(ROLLBACK, 'utf8'))
    expect(sql).toMatch(/DROP POLICY IF EXISTS audit_logs_insert_member_or_admin ON public\.audit_logs/i)
    expect(sql.match(/DROP POLICY/gi) ?? []).toHaveLength(1)
    expect(sql).not.toMatch(/CREATE POLICY/i)
    expect(sql).not.toMatch(/\bGRANT\b/i)
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
