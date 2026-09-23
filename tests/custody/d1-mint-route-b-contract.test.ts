// @vitest-environment node
// tests/custody/d1-mint-route-b-contract.test.ts
//
// ROUTE B: the pinned statements, their provenance, the harness that measures
// a candidate tool outside the repository, and the detector that keeps a live
// mint script out of it. No database, no real value.
//
// Mutation controls carried here: literal password in SQL, string
// interpolation instead of a bound parameter, secret in argv, secret written
// to a temp file, secret printed, repository-hosted live mint script.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  D1_MINT_FORMAT_MARKER,
  FAKE_ONLY_GUARD_MARKER,
  OPERATOR_TOOL_CONTRACT,
  ROUTE_B_DELTAS,
  ROUTE_B_PRECEDENT,
  ROUTE_B_STATEMENTS,
  findRepositoryHostedLiveMintScripts,
} from '@/db/custody/mint-route-b-contract'
import { runMintToolContractHarness, type Scenario } from '@/scripts/custody/d1-mint-tool-contract-harness'
import { renderFakeOnlyMintTool, type ToolVariant } from './support/fake-only-mint-tool'

const REPO = process.cwd()
const N09 = '2026-09-25T14:00:00.000Z'

function harness(variant: ToolVariant, scenario: Scenario = 'SUCCESS') {
  const dir = mkdtempSync(join(tmpdir(), 'd1-mint-harness-'))
  const tool = join(dir, 'tool.cjs')
  writeFileSync(tool, renderFakeOnlyMintTool(variant))
  return runMintToolContractHarness({ repoRoot: REPO, toolPath: tool, workRoot: join(dir, 'work'), validUntil: N09, scenario })
}

describe('the pinned Route B statements and their provenance', () => {
  it('keeps the precedent\'s set_config bound-parameter shape and GUC names', () => {
    const src = readFileSync(join(REPO, ROUTE_B_PRECEDENT.file), 'utf8')
    expect(src).toContain("SELECT set_config('uellix.rotating_role', ${target.role}, true)")
    expect(src).toContain("SELECT set_config('uellix.rotating_password', ${password}, true)")
    expect(src).toContain(`'${ROUTE_B_PRECEDENT.format_string}'`)
    expect(ROUTE_B_STATEMENTS.SET_ROLE).toBe("SELECT set_config('uellix.rotating_role', $1, true)")
    expect(ROUTE_B_STATEMENTS.SET_PASSWORD).toBe("SELECT set_config('uellix.rotating_password', $1, true)")
  })
  it('declares every difference from the precedent, and drops LOGIN (MR-1 is its own act)', () => {
    expect(ROUTE_B_STATEMENTS.DO_BLOCK).toContain(`'${D1_MINT_FORMAT_MARKER}'`)
    expect(ROUTE_B_STATEMENTS.DO_BLOCK).not.toMatch(/LOGIN/)
    expect(ROUTE_B_DELTAS.map((d) => d.id)).toEqual(['RB-DELTA-1', 'RB-DELTA-2', 'RB-DELTA-3'])
  })
  it('carries no literal value: every value is read back with current_setting', () => {
    expect(ROUTE_B_STATEMENTS.DO_BLOCK).not.toMatch(/PASSWORD\s+'/)
    expect(ROUTE_B_STATEMENTS.DO_BLOCK.match(/current_setting\('uellix\.rotating_/g)?.length).toBe(3)
  })
  it('names a measurement for every clause it can measure', () => {
    expect(OPERATOR_TOOL_CONTRACT.filter((c) => c.measuredBy !== null).length).toBeGreaterThanOrEqual(10)
  })
})

describe('the harness measures a conforming candidate', () => {
  it('SUCCESS: every check passes', () => {
    const r = harness('CONFORMING')
    expect(r.checks).toEqual(Object.fromEntries(Object.keys(r.checks).map((k) => [k, 'PASSED'])))
    expect(r.overall).toBe('CONFORMS')
    expect(Object.keys(r.checks)).toEqual(
      expect.arrayContaining(['SEQUENCE', 'BOUND_ONLY', 'SECRET_SHAPE', 'VALID_UNTIL_EQUALS_N09', 'OUTPUT_CLEAN', 'FILES_CLEAN', 'DEPOSITOR_ARGV_CLEAN', 'DEPOSITOR_ENV_CLEAN', 'HANDOFF_AFTER_COMMIT'])
    )
  })
  it('MINT_FAILS: rolls back and hands nothing to N30', () => {
    const r = harness('CONFORMING', 'MINT_FAILS')
    expect(r.overall).toBe('CONFORMS')
    expect(r.checks.NO_HANDOFF_WITHOUT_COMMIT).toBe('PASSED')
  })
  it('UNPINNED_TARGET: refuses before constructing any driver client', () => {
    const r = harness('CONFORMING', 'UNPINNED_TARGET')
    expect(r.checks.REFUSES_UNPINNED_TARGET).toBe('PASSED')
  })
  it('the fixture refuses a REAL driver (it is not a live mint tool)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-mint-real-'))
    const tool = join(dir, 'tool.cjs')
    writeFileSync(tool, renderFakeOnlyMintTool('CONFORMING'))
    let status = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [tool, `--driver-root=${REPO}`, `--depositor=${join(dir, 'none.js')}`, `--valid-until=${N09}`], {
        env: { ...process.env, UELLIX_D1_MINT_OPERATOR_DATABASE_URL: ['postgresql:', '//postgres:', 'x', '@db.bvyzblhqymxruxdguaee.supabase.co:5432/postgres'].join('') },
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

describe('the harness FAILS each non-conforming candidate on the clause it breaks', () => {
  const cases: Array<[ToolVariant, string]> = [
    ['LITERAL_IN_SQL', 'BOUND_ONLY'],
    ['INTERPOLATED_NOT_BOUND', 'BOUND_ONLY'],
    ['SECRET_IN_DEPOSITOR_ARGV', 'DEPOSITOR_ARGV_CLEAN'],
    ['SECRET_TO_TEMP_FILE', 'FILES_CLEAN'],
    ['SECRET_PRINTED', 'OUTPUT_CLEAN'],
    ['WRONG_VALID_UNTIL', 'VALID_UNTIL_EQUALS_N09'],
    ['HANDOFF_BEFORE_COMMIT', 'HANDOFF_AFTER_COMMIT'],
    ['ADMIN_ENV_LEAKED_TO_DEPOSITOR', 'DEPOSITOR_ENV_CLEAN'],
  ]
  it.each(cases)('%s -> %s FAILED', (variant, check) => {
    const r = harness(variant)
    expect(r.checks[check]).toBe('FAILED')
    expect(r.overall).toBe('DOES_NOT_CONFORM')
  })
  it('NO_TARGET_PIN -> REFUSES_UNPINNED_TARGET FAILED', () => {
    expect(harness('NO_TARGET_PIN', 'UNPINNED_TARGET').checks.REFUSES_UNPINNED_TARGET).toBe('FAILED')
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
