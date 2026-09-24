// tests/custody/d1-oep1-probe-contract.test.ts
//
// OEP-1 (manifest FIBDB-053-D1-MINT-OPERATOR-CHANNEL-SUCCESSOR-R1: P-5, P-6,
// N-PROBE-MUTATES, N-OEP1-VERDICT). The probe itself is PHASE 2; here its
// CONTRACT is measured on a fake-only fixture, and the verdict that decides
// whether OEP-1 closes is measured on canned postures. No database, no
// credential, no real target.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANNED_SAFE_ROWS, PROBE_HARNESS_TARGET_HOST, runOep1ProbeHarness, type ProbeScenario } from '@/scripts/custody/d1-oep1-probe-harness'
import { OEP1_EXTENSION_NAMES, OEP1_PROBE_STATEMENTS, OEP1_SETTINGS, evaluateOep1, preloadedLibraries } from '@/db/custody/mint-operator-channel'
import { renderFakeOnlyProbeTool, type ProbeVariant } from './support/fake-only-oep1-probe-tool'

const REPO = process.cwd()

function harness(variant: ProbeVariant, scenario: ProbeScenario = 'SUCCESS') {
  const dir = mkdtempSync(join(tmpdir(), 'd1-oep1-probe-harness-'))
  const tool = join(dir, 'probe.cjs')
  writeFileSync(tool, renderFakeOnlyProbeTool(variant))
  return runOep1ProbeHarness({ repoRoot: REPO, toolPath: tool, workRoot: join(dir, 'work'), scenario })
}

describe('the probe contract, on a conforming fake-only fixture', () => {
  it.each(['SUCCESS', 'QUERY_FAILS', 'UNPINNED_TARGET', 'WRONG_DRIVER_VERSION'] as ProbeScenario[])('%s -> CONFORMS', (scenario) => {
    const r = harness('CONFORMING', scenario)
    expect(r.overall).toBe('CONFORMS')
    expect(Object.keys(r.checks).length).toBeGreaterThan(2)
  })
  it('SUCCESS measures every PC clause (no vacuous pass)', () => {
    expect(Object.keys(harness('CONFORMING').checks).sort()).toEqual(
      ['CLOSED_LISTS_BOUND', 'EXIT', 'FILES_CLEAN', 'NO_UNSAFE', 'OUTPUT_CLEAN', 'OUTPUT_IS_THE_OBSERVATION', 'OUTSIDE_REPOSITORY', 'READ_ONLY_ONLY', 'SEQUENCE', 'SOURCE_INERT', 'TLS_REQUIRED'].sort()
    )
  })
  it('the fixture refuses a REAL driver (it can reach no hosted target)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-oep1-probe-real-'))
    const tool = join(dir, 'probe.cjs')
    writeFileSync(tool, renderFakeOnlyProbeTool('CONFORMING'))
    let status = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [tool, `--driver-root=${REPO}`, `--target-host=${PROBE_HARNESS_TARGET_HOST}`], {
        env: { ...process.env, UELLIX_D1_MINT_OPERATOR_DATABASE_URL: ['postgresql:', '//postgres:', 'x', '@', PROBE_HARNESS_TARGET_HOST, ':5432/postgres'].join('') },
        encoding: 'utf8',
      })
    } catch (e) {
      status = (e as { status: number }).status
      out = String((e as { stdout: string }).stdout)
    }
    expect(status).toBe(97)
    expect(out).toContain('FAKE_ONLY_FIXTURE')
  })
})

describe('the harness FAILS each non-conforming probe on the clause it breaks (N-PROBE-MUTATES)', () => {
  const cases: Array<[ProbeVariant, ProbeScenario, string]> = [
    ['READ_WRITE', 'SUCCESS', 'READ_ONLY_ONLY'],
    ['EXTRA_STATEMENT', 'SUCCESS', 'SEQUENCE'],
    ['MUTATES_THROUGH_UNSAFE', 'SUCCESS', 'NO_UNSAFE'],
    ['MUTATES_THROUGH_UNSAFE', 'SUCCESS', 'SOURCE_INERT'],
    ['SPAWNS_CHILD', 'SUCCESS', 'SOURCE_INERT'],
    ['PRINTS_URL', 'SUCCESS', 'OUTPUT_CLEAN'],
    ['NO_TARGET_PIN', 'UNPINNED_TARGET', 'REFUSES_UNPINNED_TARGET'],
    ['NO_DRIVER_VERSION_CHECK', 'WRONG_DRIVER_VERSION', 'REFUSES_WRONG_DRIVER_VERSION'],
    ['WRONG_SETTINGS_LIST', 'SUCCESS', 'CLOSED_LISTS_BOUND'],
  ]
  it.each(cases)('%s under %s -> %s FAILED', (variant, scenario, check) => {
    const r = harness(variant, scenario)
    expect(r.checks[check]).toBe('FAILED')
    expect(r.overall).toBe('DOES_NOT_CONFORM')
  })
})

describe('the pinned statements and closed lists', () => {
  it('bind every setting through $1 and name no role catalog', () => {
    expect(OEP1_PROBE_STATEMENTS.SETTINGS).toContain('ANY($1::text[])')
    expect(OEP1_PROBE_STATEMENTS.EXTENSIONS).toContain('ANY($1::text[])')
    for (const s of Object.values(OEP1_PROBE_STATEMENTS)) expect(s).not.toMatch(/pg_roles|pg_authid|pg_auth_members|set_config|ALTER|INSERT|UPDATE|DELETE/i)
  })
  it('the lists are sorted, duplicate-free and non-empty', () => {
    for (const l of [OEP1_SETTINGS, OEP1_EXTENSION_NAMES]) {
      expect(l.length).toBeGreaterThan(0)
      expect([...l].sort()).toEqual([...l])
      expect(new Set(l).size).toBe(l.length)
    }
  })
})

describe('the OEP-1 verdict (P-6, N-OEP1-VERDICT)', () => {
  const safe = { rows: CANNED_SAFE_ROWS, extensions: ['pg_stat_statements'] }
  const withSetting = (name: string, setting: string) => ({ ...safe, rows: [...safe.rows.filter((r) => r.name !== name), { name, setting, source: 'test' }] })
  it('the canned safe posture is PASS', () => {
    expect(evaluateOep1(safe)).toEqual({ verdict: 'PASS', failures: [], missing: [] })
  })
  const unsafe: Array<[string, ReturnType<typeof withSetting>]> = [
    ['log_statement = all', withSetting('log_statement', 'all')],
    ['log_statement = mod', withSetting('log_statement', 'mod')],
    ['log_min_duration_statement = 0', withSetting('log_min_duration_statement', '0')],
    ['duration sampling on', { ...withSetting('log_min_duration_sample', '0') }],
    ['transaction sampling on', withSetting('log_transaction_sample_rate', '0.5')],
    ['parameters logged on error', withSetting('log_parameter_max_length_on_error', '-1')],
    ['debug_print_parse on', withSetting('debug_print_parse', 'on')],
    ['pg_stat_statements track all + utility', withSetting('pg_stat_statements.track', 'all')],
  ]
  it.each(unsafe)('%s -> FAIL', (_n, o) => {
    expect(evaluateOep1(o).verdict).toBe('FAIL')
  })
  it('pgaudit preloaded with session logging -> FAIL; with logging off and no object role -> PASS', () => {
    const base = withSetting('shared_preload_libraries', 'pg_stat_statements, pgaudit')
    const rows = (log: string, role: string) => [
      ...base.rows,
      { name: 'pgaudit.log', setting: log, source: 't' },
      { name: 'pgaudit.role', setting: role, source: 't' },
      { name: 'pgaudit.log_parameter', setting: 'off', source: 't' },
      { name: 'pgaudit.log_statement', setting: 'on', source: 't' },
    ]
    expect(evaluateOep1({ ...base, rows: rows('role, ddl', '') }).verdict).toBe('FAIL')
    expect(evaluateOep1({ ...base, rows: rows('none', 'auditor') }).verdict).toBe('FAIL')
    expect(evaluateOep1({ ...base, rows: rows('none', '') }).verdict).toBe('PASS')
    // Preloaded but its settings invisible: cannot be judged.
    expect(evaluateOep1(base).verdict).toBe('INCONCLUSIVE')
  })
  it('auto_explain preloaded with logging -> FAIL', () => {
    const base = withSetting('shared_preload_libraries', 'auto_explain')
    const o = { ...base, rows: [...base.rows, { name: 'auto_explain.log_min_duration', setting: '0', source: 't' }, { name: 'auto_explain.log_nested_statements', setting: 'on', source: 't' }, { name: 'auto_explain.log_parameter_max_length', setting: '-1', source: 't' }] }
    expect(evaluateOep1(o).verdict).toBe('FAIL')
  })
  it('any required setting invisible -> INCONCLUSIVE, never PASS', () => {
    for (const name of ['log_statement', 'log_min_duration_statement', 'log_parameter_max_length_on_error', 'shared_preload_libraries', 'debug_print_plan']) {
      const o = { ...safe, rows: safe.rows.filter((r) => r.name !== name) }
      expect(evaluateOep1(o).verdict).toBe('INCONCLUSIVE')
    }
  })
  it('an unruled statement recorder preloaded -> INCONCLUSIVE', () => {
    expect(evaluateOep1(withSetting('shared_preload_libraries', 'pg_stat_statements,"$libdir/pg_stat_monitor"')).verdict).toBe('INCONCLUSIVE')
  })
  it('a row outside the closed list is a FAIL (the observation is not the one contracted)', () => {
    expect(evaluateOep1({ ...safe, rows: [...safe.rows, { name: 'work_mem', setting: '4MB', source: 't' }] }).verdict).toBe('FAIL')
  })
  it('preloadedLibraries strips quoting and $libdir', () => {
    expect(preloadedLibraries([' pg_stat_statements, "$libdir/pgaudit" ', ''])).toEqual(['pg_stat_statements', 'pgaudit'])
  })
})
