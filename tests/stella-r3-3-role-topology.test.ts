// R3.4 regression: derive the runtime topology from the canonical 0001
// authority, then require the independently-applied 0003 package and every
// later verifier to preserve it. This is deliberately source-level because
// prepared packages are not authorised for local execution in this worktree.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const prepared = (name: string) =>
  readFileSync(resolve(REPO_ROOT, 'db', 'prepared', name), 'utf8')

const decision = prepared('stella_0003_suggestion_decisions.sql')
const authority = prepared('stella_0001_role_topology_bootstrap.sql')
const laterVerifiers = [
  'stella_0005_runtime_cutover.sql',
  'stella_0005_rollback.sql',
  'stella_0005c_runtime_policy_scope.sql',
  'stella_0005c_rollback.sql',
].map(prepared)
const preparedReadme = readFileSync(resolve(REPO_ROOT, 'db', 'prepared', 'README.md'), 'utf8')

function compact(sql: string): string {
  return sql.replace(/\s+/g, '')
}

/**
 * Strips `--` line comments before a structural match. Without this, prose
 * that NAMES the retired doctrine (e.g. this file's own MSC-07B.8-R9T
 * comments, which say "pg_get_expr(..., true)" to explain what was removed)
 * would false-positive a raw-text `not.toMatch()` against live code.
 */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

function insertPolicyBody(sql: string): string {
  const policy = sql.match(
    /CREATE POLICY stella_suggestion_decisions_insert_member_or_admin[\s\S]*?WITH CHECK\s*\(([^;]+)\);/,
  )
  expect(policy, 'canonical decision INSERT policy').not.toBeNull()
  return policy![1]
}

describe('R3.4 Stella role-topology remediation', () => {
  it('accepts the canonical 0001 NOINHERIT runtime topology and rejects every owner SET path', () => {
    // 0001, not 0003 or 0004, is the independently established role authority.
    expect(authority).toMatch(
      /ALTER ROLE uellix_app\s+LOGIN\s+NOINHERIT\s+NOBYPASSRLS[\s\S]*?NOSUPERUSER;/,
    )
    expect(authority).toMatch(
      /GRANT uellix_writer TO uellix_app\s+WITH INHERIT TRUE,\s+SET FALSE,\s+ADMIN FALSE;/,
    )
    expect(authority).toMatch(
      /GRANT uellix_owner\s+TO uellix_migrator\s+WITH INHERIT FALSE,\s+SET TRUE,\s+ADMIN FALSE;/,
    )

    // A global role attribute is only the default for future memberships in
    // PostgreSQL 16+; the canonical inherited writer capability is carried by
    // the pg_auth_members row. 0003 must not reject it for global NOINHERIT.
    expect(decision).not.toMatch(/NOT app_inherit/)
    expect(decision).toMatch(
      /m\.member = app_oid[\s\S]*?m\.roleid = writer_oid[\s\S]*?m\.inherit_option[\s\S]*?NOT m\.set_option[\s\S]*?NOT m\.admin_option/,
    )
    expect(decision).toMatch(
      /m\.member = migrator_oid[\s\S]*?m\.roleid = owner_oid[\s\S]*?NOT m\.inherit_option[\s\S]*?m\.set_option[\s\S]*?NOT m\.admin_option/,
    )

    // USAGE describes membership use, not SET ROLE. A transitive SET path is
    // observable through pg_has_role(..., 'SET') and must fail preflight and
    // postcondition alike.
    expect(decision).not.toMatch(/pg_has_role\(app_oid,\s*owner_oid,\s*'USAGE'\)/)
    expect(decision.match(/pg_has_role\(app_oid,\s*owner_oid,\s*'SET'\)/g)).toHaveLength(2)

    // Every governed role is explicitly checked as NOSUPERUSER; otherwise a
    // matching name can bypass the authority model.
    for (const role of ['app', 'writer', 'owner', 'migrator']) {
      expect(decision).toMatch(new RegExp(`${role}_super`))
    }
  })

  it('pins the full INSERT predicate and makes every package verify the same exact policy', () => {
    expect(compact(insertPolicyBody(decision))).toBe(
      "organization_id=current_setting('app.organization_id',true)::uuidANDorganization_id=ANY(public.current_user_org_ids())ANDdecided_by=auth.uid()",
    )

    for (const verifier of [decision, ...laterVerifiers]) {
      // MSC-07B.8-R9T: the handwritten predicted-literal comparison
      // (regexp_replace(...pg_get_expr(polwithcheck, polrelid, true)...) =
      // expected_decision_insert_check) was replaced by an observed-vs-
      // observed same-session probe — a disjoint temporary policy carrying
      // the identical WITH CHECK source, compared via the 2-arg
      // pg_get_expr(polwithcheck, polrelid) form used for both sides.
      // Checked on the COMMENT-STRIPPED source: this file's own prose (like
      // the line above) names the retired doctrine to explain what changed,
      // and a raw-text match would false-positive on that explanation.
      const live = stripLineComments(verifier)
      expect(live).toMatch(/stella_decision_canonical_insert_probe/)
      expect(live).toMatch(/decision_insert_check_actual/)
      expect(live).toMatch(/decision_insert_check_probe/)
      expect(live).toMatch(/pg_get_expr\(polwithcheck,\s*polrelid\)/)
      expect(live).toMatch(/polpermissive/)
      expect(live).not.toMatch(/position\('app\.organization_id'/)
      expect(live).not.toMatch(/expected_decision_insert_check/)
      expect(live).not.toMatch(/pg_get_expr\([^)]*,\s*true\)/)
      expect(live).not.toMatch(/regexp_replace\(\s*regexp_replace\(pg_get_expr/)
    }
  })

  it('distinguishes every audited widening of the canonical INSERT predicate', () => {
    const canonical = compact(insertPolicyBody(decision))
    const mutations = [
      "organization_id=current_setting('app.organization_id',true)::uuidANDorganization_id=ANY(public.current_user_org_ids())ANDdecided_by=auth.uid()ORtrue",
      "organization_id=current_setting('app.organization_id',true)::uuidANDdecided_by=auth.uid()",
      "organization_id=current_setting('app.organization_id',true)::uuidANDorganization_id=ANY(public.current_user_org_ids())",
      "organization_id=ANY(public.current_user_org_ids())ANDdecided_by=auth.uid()",
    ]

    for (const mutation of mutations) {
      expect(compact(mutation), `widened or incomplete predicate: ${mutation}`).not.toBe(canonical)
    }

    // 0003 proves exclusivity with exactly two policies plus its exact SELECT
    // and INSERT inventory. Later packages also count INSERT policies while
    // preserving the decision policy without taking ownership of it.
    expect(decision).toMatch(/SELECT count\(\*\) INTO n FROM pg_policy/)
    expect(decision).toMatch(/polcmd IN \('w', 'd'\)/)
    for (const verifier of laterVerifiers) {
      expect(verifier).toMatch(/count\(\*\) FROM pg_policy[\s\S]*?polcmd = 'a'/)
      expect(verifier).toMatch(/polcmd IN \('w', 'd', '\*'\)/)
    }
  })

  it('documents only the governed wrapper as the prepared-package execution path', () => {
    const rules = preparedReadme.slice(
      preparedReadme.indexOf('## Reglas'),
      preparedReadme.indexOf('## Catálogo'),
    )
    expect(rules).toContain('pnpm db:prepared:apply:local')
    expect(rules).not.toMatch(/^\s*psql\b/im)
    expect(rules).not.toMatch(/^\s*supabase db execute\b/im)
  })
})
