// tests/custody/d1-oep1-probe-contract.test.ts
//
// OEP-1 v2 (manifest amendment FIBDB053-D1-OEP1-PLAINTEXT-ELIMINATION-
// REMEDIATION-R2: R2-P-4, N-PROBE-MUTATES carried). The probe is PHASE 2;
// here its CONTRACT is measured on a fake-only fixture, and the two
// sub-verdicts an observation decides by itself (TARGET_SESSION_BOUND,
// STARTUP_PARAMETERS_CLOSED) plus the derived-material classification are
// measured on canned observations. No database, no credential, no real target.
//
// What OEP-1 no longer infers: whether a server would log the PLAINTEXT. The
// plaintext never reaches the server (route-B RB-DELTA-4, OT-15), which the
// disposable proof and the mint harness measure; OEP-1 v2 records it as
// PLAINTEXT_NOT_SERVER_VISIBLE by construction.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANNED_DERIVED_ROWS, PROBE_HARNESS_TARGET_HOST, PROBE_REFUSAL_SCENARIOS, runOep1ProbeHarness, type ProbeScenario } from '@/scripts/custody/d1-oep1-probe-harness'
import { writeHarnessCa } from '@/scripts/custody/d1-mint-tool-contract-harness'
import {
  OEP1_DERIVED_MATERIAL_SETTINGS,
  OEP1_EXPECTED_CLIENT_SETTINGS,
  OEP1_PROBE_STATEMENTS,
  classifyDerivedMaterialExposure,
  driverDigest,
  evaluateOep1Session,
  type Oep1Observation,
} from '@/db/custody/mint-operator-channel'
import { renderFakeOnlyProbeTool, type ProbeVariant } from './support/fake-only-oep1-probe-tool'

const REPO = process.cwd()

function harness(variant: ProbeVariant, scenario: ProbeScenario = 'SUCCESS') {
  const dir = mkdtempSync(join(tmpdir(), 'd1-oep1-probe-harness-'))
  const tool = join(dir, 'probe.cjs')
  writeFileSync(tool, renderFakeOnlyProbeTool(variant))
  return runOep1ProbeHarness({ repoRoot: REPO, toolPath: tool, workRoot: join(dir, 'work'), scenario })
}

describe('the probe contract, on a conforming fake-only fixture', () => {
  const scenarios = ['SUCCESS', 'QUERY_FAILS', ...PROBE_REFUSAL_SCENARIOS.filter((s) => s !== 'TOOL_INSIDE_GIT_TREE')] as ProbeScenario[]
  it.each(scenarios)('%s -> CONFORMS', (scenario) => {
    const r = harness('CONFORMING', scenario)
    expect(r.overall).toBe('CONFORMS')
    expect(Object.keys(r.checks).length).toBeGreaterThan(2)
  })
  it('SUCCESS measures every PC clause (no vacuous pass)', () => {
    expect(Object.keys(harness('CONFORMING').checks).sort()).toEqual(
      ['CLOSED_LISTS_BOUND', 'EXIT', 'FILES_CLEAN', 'NO_UNSAFE', 'OUTPUT_CLEAN', 'OUTPUT_IS_THE_OBSERVATION', 'OUTSIDE_REPOSITORY', 'READ_ONLY_ONLY', 'SEQUENCE', 'SOURCE_INERT', 'STARTUP_CLOSED', 'TLS_VERIFY_FULL_PINNED', 'OUTPUT_CARRIES_THE_OBSERVED_CONNECTION'].sort()
    )
  })
  it('the fixture refuses a REAL driver (it can reach no hosted target)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-oep1-probe-real-'))
    const tool = join(dir, 'probe.cjs')
    writeFileSync(tool, renderFakeOnlyProbeTool('CONFORMING'))
    const trust = writeHarnessCa(join(dir, 'trust'), 'CONFORMING')
    let status = 0
    let out = ''
    try {
      out = execFileSync(
        process.execPath,
        [tool, `--driver-root=${REPO}`, `--driver-digest=${driverDigest(join(REPO, 'node_modules', 'postgres'))}`, `--target-host=${PROBE_HARNESS_TARGET_HOST}`, '--target-port=5432', '--target-database=postgres', `--ca-file=${trust.caFile}`, `--ca-sha256=${trust.caSha256}`],
        { env: { ...Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!])), UELLIX_D1_MINT_OPERATOR_DATABASE_URL: ['postgresql:', '//postgres:', 'x', '@', PROBE_HARNESS_TARGET_HOST, ':5432/postgres'].join('') } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' }
      )
    } catch (e) {
      status = (e as { status: number }).status
      out = String((e as { stdout: string }).stdout)
    }
    expect(status).toBe(97)
    expect(out).toContain('FAKE_ONLY_FIXTURE')
  })
})

describe('the harness FAILS each non-conforming probe on the clause it breaks (N-PROBE-MUTATES, R2-N-STARTUP)', () => {
  const cases: Array<[ProbeVariant, ProbeScenario, string]> = [
    ['READ_WRITE', 'SUCCESS', 'READ_ONLY_ONLY'],
    ['EXTRA_STATEMENT', 'SUCCESS', 'SEQUENCE'],
    ['MUTATES_THROUGH_UNSAFE', 'SUCCESS', 'NO_UNSAFE'],
    ['MUTATES_THROUGH_UNSAFE', 'SUCCESS', 'SOURCE_INERT'],
    ['SPAWNS_CHILD', 'SUCCESS', 'SOURCE_INERT'],
    ['PRINTS_URL', 'SUCCESS', 'OUTPUT_CLEAN'],
    ['NO_TARGET_PIN', 'UNPINNED_TARGET', 'REFUSES_UNPINNED_TARGET'],
    ['HOST_STARTSWITH', 'HOST_LOOKALIKE', 'REFUSES_HOST_LOOKALIKE'],
    ['NO_QUERY_CHECK', 'URL_WITH_QUERY', 'REFUSES_URL_WITH_QUERY'],
    ['NO_DATABASE_CHECK', 'WRONG_DATABASE', 'REFUSES_WRONG_DATABASE'],
    ['NO_PORT_CHECK', 'WRONG_PORT', 'REFUSES_WRONG_PORT'],
    ['NO_DRIVER_VERSION_CHECK', 'WRONG_DRIVER_VERSION', 'REFUSES_WRONG_DRIVER_VERSION'],
    ['NO_DRIVER_DIGEST_CHECK', 'DRIVER_DIGEST_MISMATCH', 'REFUSES_DRIVER_DIGEST_MISMATCH'],
    ['URL_CONSTRUCTED', 'SUCCESS', 'STARTUP_CLOSED'],
    ['WRONG_SETTINGS_LIST', 'SUCCESS', 'CLOSED_LISTS_BOUND'],
    // OT-18 / OT-19 as the fake driver can see them (the real TLS behaviour is d1-tls-trust.test.ts).
    ['TLS_REQUIRE', 'SUCCESS', 'TLS_VERIFY_FULL_PINNED'],
    ['TLS_NO_VERIFY', 'SUCCESS', 'TLS_VERIFY_FULL_PINNED'],
    ['TLS_SYSTEM_TRUST', 'SUCCESS', 'TLS_VERIFY_FULL_PINNED'],
    ['NO_CA_PIN_CHECK', 'CA_MODIFIED', 'REFUSES_CA_MODIFIED'],
    ['NO_AMBIENT_ENV_CHECK', 'AMBIENT_PG_ENV', 'REFUSES_AMBIENT_PG_ENV'],
    // F: a probe that echoes the planned connection instead of what it observed.
    ['REPORTS_PLANNED_NOT_OBSERVED', 'SUCCESS', 'OUTPUT_CARRIES_THE_OBSERVED_CONNECTION'],
  ]
  it.each(cases)('%s under %s -> %s FAILED', (variant, scenario, check) => {
    const r = harness(variant, scenario)
    expect(r.checks[check]).toBe('FAILED')
    expect(r.overall).toBe('DOES_NOT_CONFORM')
  })
})

describe('the pinned statements', () => {
  it('bind only the derived-material list, read no role catalog and mutate nothing', () => {
    expect(OEP1_PROBE_STATEMENTS.DERIVED_MATERIAL_SETTINGS).toContain('ANY($1::text[])')
    expect(OEP1_PROBE_STATEMENTS.IDENTITY).not.toContain('$1')
    expect(OEP1_PROBE_STATEMENTS.CLIENT_SETTINGS).not.toContain('$1')
    for (const s of Object.values(OEP1_PROBE_STATEMENTS)) expect(s).not.toMatch(/pg_roles|pg_authid|pg_auth_members|set_config|ALTER|INSERT|UPDATE|DELETE/i)
  })
  it('the expected client settings are exactly the measured postgres.js 3.4.9 set', () => {
    expect(OEP1_EXPECTED_CLIENT_SETTINGS).toEqual([
      ['application_name', 'postgres.js'],
      ['client_encoding', 'UTF8'],
    ])
  })
  it('the derived-material list is sorted, duplicate-free and non-empty', () => {
    expect(OEP1_DERIVED_MATERIAL_SETTINGS.length).toBeGreaterThan(0)
    expect([...OEP1_DERIVED_MATERIAL_SETTINGS].sort()).toEqual([...OEP1_DERIVED_MATERIAL_SETTINGS])
    expect(new Set(OEP1_DERIVED_MATERIAL_SETTINGS).size).toBe(OEP1_DERIVED_MATERIAL_SETTINGS.length)
  })
})

describe('R2-P-4: the session sub-verdicts', () => {
  const good: Oep1Observation = {
    identity: { current_user: 'postgres', session_user: 'postgres', database: 'postgres', server_version_num: '170006' },
    client_settings: OEP1_EXPECTED_CLIENT_SETTINGS,
    derived_settings: CANNED_DERIVED_ROWS,
  }
  const expectSession = { principal: 'postgres', database: 'postgres' }
  it('the planned session is TARGET_SESSION_BOUND and STARTUP_PARAMETERS_CLOSED', () => {
    expect(evaluateOep1Session(good, expectSession)).toEqual({ TARGET_SESSION_BOUND: 'PASS', STARTUP_PARAMETERS_CLOSED: 'PASS', reasons: [] })
  })
  it.each([
    ['another principal', { ...good, identity: { ...good.identity, session_user: 'supabase_admin' } }, 'TARGET_SESSION_BOUND'],
    ['SET ROLE (current != session)', { ...good, identity: { ...good.identity, current_user: 'other' } }, 'TARGET_SESSION_BOUND'],
    ['another database', { ...good, identity: { ...good.identity, database: 'template1' } }, 'TARGET_SESSION_BOUND'],
    ['an injected startup GUC', { ...good, client_settings: [...OEP1_EXPECTED_CLIENT_SETTINGS, ['debug_print_parse', 'on'] as const] }, 'STARTUP_PARAMETERS_CLOSED'],
    ['another application_name', { ...good, client_settings: [['application_name', 'x'], ['client_encoding', 'UTF8']] as Array<readonly [string, string]> }, 'STARTUP_PARAMETERS_CLOSED'],
  ] as Array<[string, Oep1Observation, 'TARGET_SESSION_BOUND' | 'STARTUP_PARAMETERS_CLOSED']>)('%s -> %s FAIL', (_n, o, which) => {
    expect(evaluateOep1Session(o, expectSession)[which]).toBe('FAIL')
  })
})

describe('DERIVED_MATERIAL_EXPOSURE is classified apart and never read as PLAINTEXT_NOT_PRESENT', () => {
  it('the canned posture is NOT_INDICATED (never "absent": the class is open)', () => {
    expect(classifyDerivedMaterialExposure(CANNED_DERIVED_ROWS)).toEqual({ classification: 'NOT_INDICATED', emitters: [] })
  })
  it.each(['log_parser_stats', 'log_lock_waits', 'debug_print_parse', 'pgtle.enable_password_check'])('%s on -> POSSIBLE (the recertifier\'s emitters)', (n) => {
    const rows = [...CANNED_DERIVED_ROWS.filter((r) => r.name !== n), { name: n, setting: 'on', source: 'role' }]
    expect(classifyDerivedMaterialExposure(rows)).toMatchObject({ classification: 'POSSIBLE', emitters: [n] })
  })
  it('an invisible core setting -> UNKNOWN', () => {
    expect(classifyDerivedMaterialExposure(CANNED_DERIVED_ROWS.filter((r) => r.name !== 'log_statement')).classification).toBe('UNKNOWN')
  })
})
