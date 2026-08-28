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

  it('accepts only the fixed runner modes, never an SQL filename or SQL text', () => {
    expect(parseR3_4RunnerMode(['apply'])).toBe('apply')
    expect(parseR3_4RunnerMode(['plan'])).toBe('plan')
    expect(() => parseR3_4RunnerMode(['apply', 'stella_0003_suggestion_decisions.sql'])).toThrow(
      /does not accept SQL filenames/i,
    )
    expect(() => parseR3_4RunnerMode(['SELECT 1'])).toThrow(/only accepts apply or plan/i)
  })
})
