import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  R3_4_LOCAL_PHASES,
  parseR3_4RunnerMode,
} from '@/db/r3-4-governed-runner'

const ROOT = path.resolve(process.cwd())
const PREPARED = path.join(ROOT, 'db', 'prepared')

function read(name: string): string {
  return readFileSync(path.join(PREPARED, name), 'utf8')
}

function executable(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('R3.4 fresh local prepared chain', () => {
  it('has one explicit acyclic sequence with identity boundaries', () => {
    expect(R3_4_LOCAL_PHASES.map((phase) => [phase.id, phase.identity, phase.file])).toEqual([
      ['baseline-admin', 'admin', 'stella_0002_interactions_hardening.sql'],
      ['baseline-admin', 'admin', 'stella_0002b_append_only_truncate_hardening.sql'],
      ['role-topology-admin', 'admin', 'stella_0001_role_topology_bootstrap.sql'],
      ['decision-migrator', 'migrator', 'stella_0003_suggestion_decisions.sql'],
      ['role-separation-admin', 'admin', 'stella_0004_role_separation.sql'],
      ['admin-bootstrap', 'admin', 'stella_0005b_admin_bootstrap.sql'],
      ['runtime-migrator', 'migrator', 'stella_0005_runtime_cutover.sql'],
      ['runtime-migrator', 'migrator', 'stella_0005c_runtime_policy_scope.sql'],
    ])
  })

  it('installs topology before decisions and requires decisions before 0004 reconciliation', () => {
    const bootstrap = read('stella_0001_role_topology_bootstrap.sql')
    const separation = read('stella_0004_role_separation.sql')

    expect(bootstrap).toMatch(/CREATE ROLE uellix_owner/)
    expect(bootstrap).not.toMatch(/stella_suggestion_decisions/)
    expect(separation).toMatch(/stella_suggestion_decisions/)
    expect(separation).toMatch(/allowlisted table\(s\) missing/i)
  })

  it('keeps role and membership mutation authority exclusively in 0001', () => {
    const bootstrap = executable(read('stella_0001_role_topology_bootstrap.sql'))
    const separation = executable(read('stella_0004_role_separation.sql'))

    expect(bootstrap).toMatch(/CREATE ROLE uellix_owner/)
    expect(bootstrap).toMatch(/GRANT uellix_owner TO uellix_migrator/)
    expect(separation).not.toMatch(/CREATE ROLE uellix_(owner|migrator|app|writer|auditor)/)
    expect(separation).not.toMatch(/ALTER ROLE uellix_(owner|migrator|app|writer|auditor)/)
    expect(separation).not.toMatch(/GRANT uellix_(owner|writer) TO (uellix_migrator|uellix_app|postgres)/)
    expect(separation).not.toMatch(/REVOKE uellix_(owner|writer) FROM (uellix_migrator|uellix_app|postgres)/)
    expect(separation).toMatch(/pg_auth_members/)
  })

  it('names the post-0003 decision INSERT policy in the 105-policy inventory', () => {
    const separation = executable(read('stella_0004_role_separation.sql'))

    expect(separation).toMatch(/105 policies/)
    expect(separation).toMatch(/stella_suggestion_decisions_insert_member_or_admin/)
    expect(separation).toMatch(/policy inventory/i)
    expect(separation).toMatch(/polcmd = 'a'/)
  })

  it('gives topology rollback sole authority for membership and role removal and guards dependencies', () => {
    const topologyRollback = executable(read('stella_0001_role_topology_bootstrap_rollback.sql'))
    const separationRollback = executable(read('stella_0004_rollback.sql'))

    expect(topologyRollback).toMatch(/pg_shdepend/)
    expect(topologyRollback).toMatch(/DROP ROLE uellix_owner/)
    expect(topologyRollback).toMatch(/REVOKE uellix_owner FROM uellix_migrator/)
    expect(separationRollback).not.toMatch(/DROP ROLE uellix_(owner|migrator|app|writer|auditor)/)
    expect(separationRollback).not.toMatch(/REVOKE uellix_(owner|writer) FROM (uellix_migrator|uellix_app|postgres)/)
  })

  it('never substitutes the hosted bootstrap into the local fixed chain', () => {
    const files = R3_4_LOCAL_PHASES.map((phase) => phase.file)
    expect(files).not.toContain('stella_hosted_0001_managed_role_bootstrap.sql')
    expect(files.every((file) => existsSync(path.join(PREPARED, file)))).toBe(true)
  })

  it('MSC-07B.8-R9A: 0001 materializes the FK REFERENCES prerequisite before 0003, so 0003 no longer waits for 0004 ownership', () => {
    const bootstrapIndex = R3_4_LOCAL_PHASES.findIndex(
      (phase) => phase.file === 'stella_0001_role_topology_bootstrap.sql',
    )
    const decisionIndex = R3_4_LOCAL_PHASES.findIndex(
      (phase) => phase.file === 'stella_0003_suggestion_decisions.sql',
    )
    const separationIndex = R3_4_LOCAL_PHASES.findIndex(
      (phase) => phase.file === 'stella_0004_role_separation.sql',
    )

    // 0001 before 0003, and 0004 after 0003 — the fixed chain order is
    // unchanged by this remediation.
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0)
    expect(decisionIndex).toBeGreaterThan(bootstrapIndex)
    expect(separationIndex).toBeGreaterThan(decisionIndex)

    const bootstrap = read('stella_0001_role_topology_bootstrap.sql')
    const decisions = read('stella_0003_suggestion_decisions.sql')

    // 0001 materializes REFERENCES on all four FK targets before 0003 runs.
    for (const table of ['organizations', 'projects', 'users', 'stella_interactions']) {
      expect(bootstrap).toMatch(
        new RegExp(`GRANT REFERENCES ON TABLE public\\.${table} TO uellix_owner;`),
      )
    }

    // 0003 (current_user = uellix_owner) creates the dependent table's FKs
    // against exactly those four targets.
    expect(decisions).toMatch(/organization_id uuid NOT NULL REFERENCES public\.organizations\(id\)/)
    expect(decisions).toMatch(/project_id uuid NOT NULL REFERENCES public\.projects\(id\)/)
    expect(decisions).toMatch(/interaction_id uuid REFERENCES public\.stella_interactions\(id\)/)
    expect(decisions).toMatch(/decided_by uuid NOT NULL REFERENCES public\.users\(id\)/)

    // The fresh-chain cycle this remediation closes: 0003 no longer needs
    // 0004's later ownership transfer to reach REFERENCES on these tables —
    // 0003's own preflight never asserts uellix_owner ownership of any of
    // the four FK targets (only of the table it is itself creating/altering).
    const decisionOwnershipChecks = [...decisions.matchAll(/pg_get_userbyid\(relowner\)[\s\S]{0,80}/g)]
    for (const check of decisionOwnershipChecks) {
      expect(check[0]).not.toMatch(/organizations|projects|users|stella_interactions/)
    }
  })

  it('accepts only the fixed runner modes, never an SQL filename or SQL text', () => {
    expect(parseR3_4RunnerMode(['apply'])).toBe('apply')
    expect(parseR3_4RunnerMode(['plan'])).toBe('plan')
    expect(() => parseR3_4RunnerMode(['apply', 'stella_0003_suggestion_decisions.sql'])).toThrow(
      /does not accept SQL filenames/i,
    )
    expect(() => parseR3_4RunnerMode(['SELECT 1'])).toThrow(/only accepts apply or plan/i)
  })
})
