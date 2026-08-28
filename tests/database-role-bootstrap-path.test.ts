import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  R3_4_LOCAL_PHASES,
  parseR3_4RunnerMode,
} from '@/db/r3-4-governed-runner'

const ROOT = path.resolve(process.cwd())

describe('R3.4 governed local administrative runner', () => {
  it('binds every phase to a literal package and identity instead of caller input', () => {
    expect(R3_4_LOCAL_PHASES).toHaveLength(8)
    expect(R3_4_LOCAL_PHASES.every((phase) => phase.file.endsWith('.sql'))).toBe(true)
    expect(R3_4_LOCAL_PHASES.filter((phase) => phase.identity === 'admin').map((phase) => phase.file)).toEqual([
      'stella_0002_interactions_hardening.sql',
      'stella_0002b_append_only_truncate_hardening.sql',
      'stella_0001_role_topology_bootstrap.sql',
      'stella_0004_role_separation.sql',
      'stella_0005b_admin_bootstrap.sql',
    ])
    expect(R3_4_LOCAL_PHASES.filter((phase) => phase.identity === 'migrator').map((phase) => phase.file)).toEqual([
      'stella_0003_suggestion_decisions.sql',
      'stella_0005_runtime_cutover.sql',
      'stella_0005c_runtime_policy_scope.sql',
    ])
  })

  it('rejects missing, extra, arbitrary-file, and arbitrary-SQL command arguments', () => {
    for (const args of [[], ['apply', '../any.sql'], ['verify', 'DROP TABLE public.users'], ['prepared']]) {
      expect(() => parseR3_4RunnerMode(args)).toThrow()
    }
  })

  it('implements transactions per identity phase without a synthetic global transaction', () => {
    const runner = readFileSync(path.join(ROOT, 'scripts', 'stella-r3-4-local-runner.ts'), 'utf8')

    expect(runner).toMatch(/runAdministrativePhase/)
    expect(runner).toMatch(/runMigratorPhase/)
    expect(runner).toMatch(/\.begin\(/)
    expect(runner).not.toMatch(/resolvePreparedScript/)
    expect(runner).not.toMatch(/basename\(name\)/)
    expect(runner).not.toMatch(/process\.argv\.slice\(2\).*script/i)
  })
})
