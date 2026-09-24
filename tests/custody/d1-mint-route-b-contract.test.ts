// @vitest-environment node
// tests/custody/d1-mint-route-b-contract.test.ts
//
// ROUTE B: the pinned statements, their provenance, the harness that measures
// a candidate tool outside the repository, the commit-outcome classification
// (B-1), and the detector that keeps a live mint script out of the tree. No
// database, no real value, no real target.
//
// Mutation controls carried here: literal password in SQL, interpolation
// instead of a bound parameter, secret in argv, secret written to a temp file,
// secret printed, repository-hosted live mint script, COMMIT ambiguity read as
// NOT_COMMITTED, COMMIT ambiguity dropping the candidate, the harness naming
// the real staging host.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import { deriveScramVerifier } from '@/db/custody/scram-verifier'
import {
  COMMIT_UNKNOWN_TOKEN,
  D1_MINT_FORMAT_MARKER,
  FAKE_ONLY_GUARD_MARKER,
  OPERATOR_TOOL_CONTRACT,
  ROUTE_B_DELTAS,
  ROUTE_B_PRECEDENT,
  ROUTE_B_STATEMENTS,
  classifyCommitOutcome,
  classifyToolRun,
  findRepositoryHostedLiveMintScripts,
} from '@/db/custody/mint-route-b-contract'
import { COMMIT_FAILURES, HARNESS_TARGET_HOST, REFUSAL_SCENARIOS, runMintToolContractHarness, type Scenario } from '@/scripts/custody/d1-mint-tool-contract-harness'
import { driverDigest } from '@/db/custody/mint-operator-channel'
import { COMMIT_FAILURE_MATRIX } from '@/scripts/custody/d1-post-mint'
import { deriveEffectiveSchedule } from '@/scripts/custody/d1-effective-schedule'
import { renderFakeOnlyMintTool, type ToolVariant } from './support/fake-only-mint-tool'

// Each harness run spawns the tool, a depositor and holds COMMIT 1.5s. Time only — no assertion changes.
vi.setConfig({ testTimeout: 60_000 })

const REPO = process.cwd()
// The harness VALID UNTIL is the effective schedule's machine-derived N09, never a historical literal.
const N09 = deriveEffectiveSchedule(REPO).N09!

function harness(variant: ToolVariant, scenario: Scenario = 'SUCCESS') {
  const dir = mkdtempSync(join(tmpdir(), 'd1-mint-harness-'))
  const tool = join(dir, 'tool.cjs')
  writeFileSync(tool, renderFakeOnlyMintTool(variant))
  return runMintToolContractHarness({ repoRoot: REPO, toolPath: tool, workRoot: join(dir, 'work'), validUntil: N09, scenario })
}
const allPassed = (r: { checks: Readonly<Record<string, string>> }) => Object.values(r.checks).every((v) => v === 'PASSED')

describe('the pinned Route B statements and their provenance', () => {
  it('keeps the precedent\'s set_config bound-parameter shape and GUC names', () => {
    const src = readFileSync(join(REPO, ROUTE_B_PRECEDENT.file), 'utf8')
    expect(src).toContain("SELECT set_config('uellix.rotating_role', ${target.role}, true)")
    expect(src).toContain("SELECT set_config('uellix.rotating_password', ${password}, true)")
    expect(src).toContain(`'${ROUTE_B_PRECEDENT.format_string}'`)
    expect(ROUTE_B_STATEMENTS.SET_ROLE).toBe("SELECT set_config('uellix.rotating_role', $1, true)")
    // RB-DELTA-4: the precedent's password GUC now carries the client-derived VERIFIER, never the plaintext.
    expect(ROUTE_B_STATEMENTS.SET_VERIFIER).toBe("SELECT set_config('uellix.rotating_verifier', $1, true)")
    expect(Object.keys(ROUTE_B_STATEMENTS)).not.toContain('SET_PASSWORD')
  })
  it('declares every difference from the precedent, and drops LOGIN (MR-1 is its own act)', () => {
    expect(ROUTE_B_STATEMENTS.DO_BLOCK).toContain(`'${D1_MINT_FORMAT_MARKER}'`)
    expect(ROUTE_B_STATEMENTS.DO_BLOCK).not.toMatch(/LOGIN/)
    expect(ROUTE_B_DELTAS.map((d) => d.id)).toEqual(['RB-DELTA-1', 'RB-DELTA-2', 'RB-DELTA-3', 'RB-DELTA-4'])
  })
  it('carries no literal value: every value is read back with current_setting', () => {
    expect(ROUTE_B_STATEMENTS.DO_BLOCK).not.toMatch(/PASSWORD\s+'/)
    expect(ROUTE_B_STATEMENTS.DO_BLOCK.match(/current_setting\('uellix\.rotating_/g)?.length).toBe(4)
  })
  it('RB-DELTA-4: refuses anything that is not a SCRAM verifier BEFORE the ALTER ROLE', () => {
    const d = ROUTE_B_STATEMENTS.DO_BLOCK
    expect(d.indexOf('D1_VERIFIER_REQUIRED')).toBeGreaterThan(-1)
    expect(d.indexOf('D1_VERIFIER_REQUIRED')).toBeLessThan(d.indexOf('EXECUTE format('))
    expect(d).toContain("current_setting('uellix.rotating_verifier') !~ '^SCRAM-SHA-256\\$")
    expect(d).not.toContain('rotating_password')
  })
  it('RB-DELTA-4 (behavioural): the guard pattern accepts a derived verifier and refuses a plaintext, an md5 hash and a padded verifier', () => {
    // The SQL literal is read with standard_conforming_strings (backslash literal); POSIX ~ and a JS
    // RegExp agree on this pattern (anchors, bracket classes, escaped dollar). The disposable-PostgreSQL
    // proof measures the same guard on the server (GUARD_REFUSES_A_NON_VERIFIER).
    const src = /!~ '([^']+)' THEN/.exec(ROUTE_B_STATEMENTS.DO_BLOCK)?.[1]
    expect(src).toBeDefined()
    const guard = new RegExp(src!)
    const pw = randomBytes(32).toString('base64url')
    const v = deriveScramVerifier(pw)
    expect(guard.test(v)).toBe(true)
    for (const bad of [pw, `md5${'a'.repeat(32)}`, `${v}\n`, ` ${v}`, v.replace('SCRAM-SHA-256$', 'SCRAM-SHA-1$'), v.split('$').slice(0, 2).join('$'), '']) {
      expect(guard.test(bad), JSON.stringify(bad.slice(0, 12))).toBe(false)
    }
  })
  it('names a measurement for every clause it can measure, including the commit classification', () => {
    expect(OPERATOR_TOOL_CONTRACT.filter((c) => c.measuredBy !== null).length).toBeGreaterThanOrEqual(11)
    expect(OPERATOR_TOOL_CONTRACT.map((c) => c.id)).toContain('OT-12')
  })
})

describe('B-1: the commit outcome is classified conservatively', () => {
  it('DEFINITELY_NOT_COMMITTED needs positive evidence that COMMIT was never requested', () => {
    expect(classifyCommitOutcome({ transactionStarted: false, callbackCompleted: false, commitAcknowledged: false })).toBe('DEFINITELY_NOT_COMMITTED')
    expect(classifyCommitOutcome({ transactionStarted: true, callbackCompleted: false, commitAcknowledged: false })).toBe('DEFINITELY_NOT_COMMITTED')
    expect(classifyCommitOutcome({ transactionStarted: true, callbackCompleted: true, commitAcknowledged: false })).toBe('COMMIT_OUTCOME_UNKNOWN')
    expect(classifyCommitOutcome({ transactionStarted: true, callbackCompleted: true, commitAcknowledged: true })).toBe('COMMITTED')
  })
  it('a run that left no terminal line is UNKNOWN, never NOT_COMMITTED', () => {
    expect(classifyToolRun('')).toEqual({ outcome: 'COMMIT_OUTCOME_UNKNOWN', token: COMMIT_UNKNOWN_TOKEN, carrier: 'NO_TERMINAL_LINE' })
    expect(classifyToolRun('{"phase":"COMMIT_REQUESTED"}\n')).toMatchObject({ outcome: 'COMMIT_OUTCOME_UNKNOWN', carrier: 'NO_TERMINAL_LINE' })
    expect(classifyToolRun('{"mint":"DEFINITELY_NOT_COMMITTED"}\n').outcome).toBe('DEFINITELY_NOT_COMMITTED')
    expect(classifyToolRun('{"mint":"SOMETHING_ELSE"}\n').outcome).toBe('COMMIT_OUTCOME_UNKNOWN')
  })
})

describe('the harness measures a conforming candidate at every commit boundary', () => {
  it.each([
    'SUCCESS',
    'FAILS_BEFORE_TRANSACTION',
    'MINT_FAILS',
    'COMMIT_TRANSPORT_LOST',
    'COMMIT_TIMEOUT',
    'COMMIT_GENERIC_TRANSPORT_ERROR',
    'COMMIT_SERVER_ERROR_SQLSTATE',
    'KILLED_DURING_COMMIT',
    'COMMIT_NO_FINAL_OUTPUT',
    ...(Object.keys(REFUSAL_SCENARIOS).filter((s) => s !== 'TOOL_INSIDE_GIT_TREE') as Scenario[]),
  ] as const)('%s: every check passes', (scenario) => {
    const r = harness('CONFORMING', scenario)
    expect(r.checks).toEqual(Object.fromEntries(Object.keys(r.checks).map((k) => [k, 'PASSED'])))
    expect(r.overall).toBe('CONFORMS')
  }, 60_000)
  it('COMMIT_TRANSPORT_LOST: UNKNOWN with the dedicated token, exit 4, and the candidate handed to custody', () => {
    const r = harness('CONFORMING', 'COMMIT_TRANSPORT_LOST')
    expect(r.classification).toEqual({ outcome: 'COMMIT_OUTCOME_UNKNOWN', token: COMMIT_UNKNOWN_TOKEN, carrier: 'TERMINAL_LINE' })
    expect(r.toolExit).toBe(4)
    expect(r.checks.CANDIDATE_RETAINED_IN_CUSTODY).toBe('PASSED')
  })
  it('KILLED_DURING_COMMIT: the governed reading is UNKNOWN with the carrier lost', () => {
    expect(harness('CONFORMING', 'KILLED_DURING_COMMIT').classification).toMatchObject({ outcome: 'COMMIT_OUTCOME_UNKNOWN', carrier: 'NO_TERMINAL_LINE' })
  })
  it('the fixture refuses a REAL driver (it is not a live mint tool)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-mint-real-'))
    const tool = join(dir, 'tool.cjs')
    writeFileSync(tool, renderFakeOnlyMintTool('CONFORMING'))
    let status = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [tool, `--driver-root=${REPO}`, `--driver-digest=${driverDigest(join(REPO, 'node_modules', 'postgres'))}`, `--depositor=${join(dir, 'none.js')}`, `--valid-until=${N09}`, `--target-host=${HARNESS_TARGET_HOST}`, '--target-port=5432', '--target-database=postgres', '--operator-principal=postgres'], {
        env: { ...process.env, UELLIX_D1_MINT_OPERATOR_DATABASE_URL: ['postgresql:', '//postgres:', 'x', '@', HARNESS_TARGET_HOST, ':5432/postgres'].join('') },
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

// NB-1. The throw-on-COMMIT scenarios differ only in the error carried; the
// governed reading must not. Each survivor strategy below passed the matrix
// as it was (one CONNECTION_CLOSED scenario) or would pass part of this one.
const THROWN_ON_COMMIT = (Object.keys(COMMIT_FAILURES) as Scenario[]).filter((s) => COMMIT_FAILURES[s]!.mode === 'throw')

describe('NB-1: the commit classification does not depend on the error a failed COMMIT carries', () => {
  it('the harness drives every client-visible post-request failure row of the commit matrix', () => {
    expect(THROWN_ON_COMMIT).toEqual(['COMMIT_TRANSPORT_LOST', 'COMMIT_TIMEOUT', 'COMMIT_GENERIC_TRANSPORT_ERROR', 'COMMIT_SERVER_ERROR_SQLSTATE'])
    const rows = new Set(Object.values(COMMIT_FAILURES).map((f) => f!.cfRow))
    expect([...rows].sort()).toEqual(['CF-10', 'CF-5', 'CF-7', 'CF-8', 'CF-9'])
    for (const id of rows) expect(COMMIT_FAILURE_MATRIX.find((r) => r.id === id)?.outcome, id).toBe('COMMIT_OUTCOME_UNKNOWN')
    // Codes differ, including one SQLSTATE and one error with no code at all.
    const codes = THROWN_ON_COMMIT.map((s) => (COMMIT_FAILURES[s] as { props: { code?: unknown } }).props.code)
    expect(new Set(codes).size).toBe(4)
    expect(codes).toContain(undefined)
    expect(codes.some((c) => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c))).toBe(true)
  })
  it.each(THROWN_ON_COMMIT)('%s: a conforming tool reports UNKNOWN with the token, exit 4, and retains the candidate', (scenario) => {
    const r = harness('CONFORMING', scenario)
    expect(r.classification).toEqual({ outcome: 'COMMIT_OUTCOME_UNKNOWN', token: COMMIT_UNKNOWN_TOKEN, carrier: 'TERMINAL_LINE' })
    expect(r.toolExit).toBe(4)
    expect(r.checks.CANDIDATE_RETAINED_IN_CUSTODY).toBe('PASSED')
  }, 60_000)
  it('COMMIT_NO_FINAL_OUTPUT: a run ended from outside with no terminal line is UNKNOWN, carrier lost', () => {
    const r = harness('CONFORMING', 'COMMIT_NO_FINAL_OUTPUT')
    expect(r.classification).toMatchObject({ outcome: 'COMMIT_OUTCOME_UNKNOWN', carrier: 'NO_TERMINAL_LINE' })
    expect(r.toolExit).toBeNull()
  }, 60_000)

  const survivors: Array<[ToolVariant, Scenario[], Scenario[]]> = [
    // [variant, scenarios it still passes, scenarios that must catch it]
    ['AMBIGUITY_AS_NOT_COMMITTED', [], ['COMMIT_TRANSPORT_LOST', 'COMMIT_TIMEOUT', 'COMMIT_GENERIC_TRANSPORT_ERROR', 'COMMIT_SERVER_ERROR_SQLSTATE']],
    ['COMMIT_CLASSIFIED_BY_CODE', ['COMMIT_TRANSPORT_LOST'], ['COMMIT_TIMEOUT', 'COMMIT_GENERIC_TRANSPORT_ERROR', 'COMMIT_SERVER_ERROR_SQLSTATE']],
    ['COMMIT_CLASSIFIED_BY_SQLSTATE', ['COMMIT_TRANSPORT_LOST', 'COMMIT_TIMEOUT', 'COMMIT_GENERIC_TRANSPORT_ERROR'], ['COMMIT_SERVER_ERROR_SQLSTATE']],
  ]
  it.each(survivors)('%s is killed by the error-class matrix (and only a matrix with more than one class kills it)', (variant, passes, catches) => {
    for (const s of passes) expect(allPassed(harness(variant, s)), `${variant} under ${s}`).toBe(true)
    for (const s of catches) {
      const r = harness(variant, s)
      expect(r.checks.CLASSIFIED_COMMIT_OUTCOME_UNKNOWN, `${variant} under ${s}`).toBe('FAILED')
      expect(r.classification.outcome).toBe('DEFINITELY_NOT_COMMITTED')
      expect(r.overall).toBe('DOES_NOT_CONFORM')
    }
  }, 120_000)
})

describe('the harness FAILS each non-conforming candidate on the clause it breaks', () => {
  const cases: Array<[ToolVariant, Scenario, string]> = [
    ['LITERAL_IN_SQL', 'SUCCESS', 'BOUND_ONLY'],
    ['INTERPOLATED_NOT_BOUND', 'SUCCESS', 'BOUND_ONLY'],
    ['SECRET_IN_DEPOSITOR_ARGV', 'SUCCESS', 'DEPOSITOR_ARGV_CLEAN'],
    ['SECRET_TO_TEMP_FILE', 'SUCCESS', 'FILES_CLEAN'],
    ['SECRET_PRINTED', 'SUCCESS', 'OUTPUT_CLEAN'],
    ['WRONG_VALID_UNTIL', 'SUCCESS', 'VALID_UNTIL_EQUALS_N09'],
    ['HANDOFF_BEFORE_COMMIT', 'SUCCESS', 'HANDOFF_AFTER_COMMIT'],
    ['ADMIN_ENV_LEAKED_TO_DEPOSITOR', 'SUCCESS', 'DEPOSITOR_ENV_CLEAN'],
    ['NO_TARGET_PIN', 'UNPINNED_TARGET', 'REFUSES_UNPINNED_TARGET'],
    ['AMBIGUITY_AS_NOT_COMMITTED', 'COMMIT_TRANSPORT_LOST', 'CLASSIFIED_COMMIT_OUTCOME_UNKNOWN'],
    ['AMBIGUITY_DROPS_CANDIDATE', 'COMMIT_TRANSPORT_LOST', 'CANDIDATE_RETAINED_IN_CUSTODY'],
    // OT-13 / OT-14 (operator-channel successor): each broken clause fails exactly its check.
    ['NO_DRIVER_VERSION_CHECK', 'WRONG_DRIVER_VERSION', 'REFUSES_WRONG_DRIVER_VERSION'],
    ['NO_PRINCIPAL_CHECK', 'WRONG_OPERATOR_PRINCIPAL', 'REFUSES_WRONG_OPERATOR_PRINCIPAL'],
    // OT-15..OT-17 (plaintext elimination, closed startup, driver by content).
    ['PLAINTEXT_BOUND', 'SUCCESS', 'VERIFIER_ONLY'],
    ['PLAINTEXT_BOUND', 'SUCCESS', 'PLAINTEXT_NEVER_SENT'],
    ['WRONG_KEY_LABEL', 'SUCCESS', 'VERIFIER_ONLY'],
    ['URL_CONSTRUCTED', 'SUCCESS', 'STARTUP_CLOSED'],
    ['HOST_STARTSWITH', 'HOST_LOOKALIKE', 'REFUSES_HOST_LOOKALIKE'],
    ['NO_QUERY_CHECK', 'URL_WITH_QUERY', 'REFUSES_URL_QUERY'],
    ['NO_DATABASE_CHECK', 'WRONG_DATABASE', 'REFUSES_WRONG_DATABASE'],
    ['NO_PORT_CHECK', 'WRONG_PORT', 'REFUSES_WRONG_PORT'],
    ['NO_DRIVER_DIGEST_CHECK', 'DRIVER_DIGEST_MISMATCH', 'REFUSES_DRIVER_DIGEST_MISMATCH'],
  ]
  it.each(cases)('%s under %s -> %s FAILED', (variant, scenario, check) => {
    const r = harness(variant, scenario)
    expect(r.checks[check]).toBe('FAILED')
    expect(r.overall).toBe('DOES_NOT_CONFORM')
  })
  it.each(Object.entries(REFUSAL_SCENARIOS).filter(([s]) => s !== 'TOOL_INSIDE_GIT_TREE') as Array<[Scenario, string]>)('a conforming tool refuses %s before any driver call (%s)', (scenario, check) => {
    const r = harness('CONFORMING', scenario)
    expect(r.checks).toEqual({ OUTSIDE_REPOSITORY: 'PASSED', [check]: 'PASSED' })
    expect(r.overall).toBe('CONFORMS')
  })
  it('SUCCESS measures the plaintext-elimination checks (no vacuous pass)', () => {
    const r = harness('CONFORMING', 'SUCCESS')
    for (const k of ['VERIFIER_FORMAT', 'VERIFIER_ONLY', 'PLAINTEXT_NEVER_SENT', 'STARTUP_CLOSED', 'SECRET_SHAPE']) expect(r.checks[k], k).toBe('PASSED')
  })
  it('the two ambiguity variants still conform when COMMIT is acknowledged (the defect is only on the unknown path)', () => {
    expect(allPassed(harness('AMBIGUITY_AS_NOT_COMMITTED', 'SUCCESS'))).toBe(true)
    expect(allPassed(harness('AMBIGUITY_DROPS_CANDIDATE', 'SUCCESS'))).toBe(true)
  })
})

describe('no real target in the fake contract tests', () => {
  it('CONTROL fake-harness-real-staging-host: neither the harness nor the fixture names the staging project or a supabase host', () => {
    for (const f of ['scripts/custody/d1-mint-tool-contract-harness.ts', 'tests/custody/support/fake-only-mint-tool.ts']) {
      const text = readFileSync(join(REPO, f), 'utf8')
      expect(text, f).not.toContain(KNOWN_STAGING_PROJECT_REF)
      expect(text, f).not.toMatch(/supabase\.co/)
      expect(text, f).not.toMatch(/KNOWN_STAGING_PROJECT_REF|KNOWN_PRODUCTION_IDENTIFIERS/)
    }
    expect(HARNESS_TARGET_HOST.endsWith('.invalid')).toBe(true)
  })
})

describe('no live mint script is hosted in the repository', () => {
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => /\.(ts|js|mjs|cjs)$/.test(p) && !p.startsWith('node_modules/'))
  const files = listed.map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf8') }))

  it('CONTROL repo-hosted-live-mint-script: the scan finds none', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(findRepositoryHostedLiveMintScripts(files)).toEqual([])
  })
  it('the detector flags a file that would be one, and not the fake-only fixture', () => {
    const fixture = renderFakeOnlyMintTool('CONFORMING')
    expect(fixture).toContain(FAKE_ONLY_GUARD_MARKER)
    expect(findRepositoryHostedLiveMintScripts([{ path: 'x.cjs', text: fixture }])).toEqual([])
    expect(findRepositoryHostedLiveMintScripts([{ path: 'x.cjs', text: fixture.replace(FAKE_ONLY_GUARD_MARKER, 'false') }])).toEqual(['x.cjs'])
  })
})
