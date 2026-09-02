// tests/ods/ci-authority-integration.test.ts — OI-3 static CI evidence.
//
// Not a workflow-formatting test. Asserts the three semantic properties
// that matter for "fails fast if frozen authority drifts": the step exists,
// nothing swallows its exit code, and it runs before the expensive stages.
// No YAML parser dependency is added — this project has none, and simple
// text checks are sufficient for these properties.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const CI_YAML_PATH = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'ci.yml')

function readCiYaml(): string {
  return readFileSync(CI_YAML_PATH, 'utf8')
}

describe('CI integrates the deterministic authority integrity gate', () => {
  it('runs pnpm authority:seal:verify', () => {
    expect(readCiYaml()).toMatch(/run:\s*pnpm authority:seal:verify\s*$/m)
  })

  it('does not swallow the step\'s exit code', () => {
    const ci = readCiYaml()
    const stepIndex = ci.indexOf('pnpm authority:seal:verify')
    expect(stepIndex).toBeGreaterThan(-1)
    // Look at the step block only (from its own "- name:" line to the next
    // "- name:" line), not the whole file, so an unrelated step elsewhere
    // in ci.yml can't produce a false pass or false fail here.
    const blockStart = ci.lastIndexOf('- name:', stepIndex)
    const blockEnd = ci.indexOf('- name:', stepIndex + 1)
    const block = ci.slice(blockStart, blockEnd === -1 ? undefined : blockEnd)
    expect(block).not.toMatch(/continue-on-error:\s*true/)
  })

  it('runs before the expensive Test and Build stages', () => {
    const ci = readCiYaml()
    const authorityIndex = ci.indexOf('pnpm authority:seal:verify')
    const testIndex = ci.indexOf('run: pnpm test:unit')
    const buildIndex = ci.indexOf('run: pnpm build')
    expect(authorityIndex).toBeGreaterThan(-1)
    expect(testIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(authorityIndex).toBeLessThan(testIndex)
    expect(authorityIndex).toBeLessThan(buildIndex)
  })

  it('runs after dependencies are installed', () => {
    const ci = readCiYaml()
    const installIndex = ci.indexOf('pnpm install --frozen-lockfile')
    const authorityIndex = ci.indexOf('pnpm authority:seal:verify')
    expect(installIndex).toBeGreaterThan(-1)
    expect(authorityIndex).toBeGreaterThan(installIndex)
  })

  // MNB-CI-1 (ODS-05): actions/checkout@v4 defaults to a shallow (depth-1)
  // clone, which cannot resolve the historical blobs authority:seal:verify
  // requires at its frozen anchor commits — the gate would fail closed for
  // an infrastructure reason indistinguishable in the CI log from real
  // authority drift. Tests the semantic requirement (full history is
  // requested on the checkout step that runs before the authority gate),
  // not YAML formatting.
  it('the checkout step preceding the authority gate requests full history (fetch-depth: 0)', () => {
    const ci = readCiYaml()
    const authorityIndex = ci.indexOf('pnpm authority:seal:verify')
    const checkoutIndex = ci.indexOf('uses: actions/checkout@v4')
    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(checkoutIndex).toBeLessThan(authorityIndex)

    // Slice the checkout step's own block only (to its own "- name:" start
    // through the next "- name:"), so a fetch-depth on some unrelated step
    // can't produce a false pass here.
    const blockStart = ci.lastIndexOf('- name:', checkoutIndex)
    const blockEnd = ci.indexOf('- name:', checkoutIndex + 1)
    const block = ci.slice(blockStart, blockEnd === -1 ? undefined : blockEnd)
    expect(block).toMatch(/fetch-depth:\s*0\b/)
  })
})

describe('CI already collects tests/ods/** via the existing Test step (no duplicate invocation needed)', () => {
  it('the Test step runs the project default vitest suite, which is not scoped away from tests/ods', () => {
    const ci = readCiYaml()
    expect(ci).toMatch(/run:\s*pnpm test:unit\s*$/m)
    // vitest.shared.ts BASE_EXCLUDE/INTEGRATION_GLOB/E2E_GLOB do not exclude
    // tests/ods/** — see tests/ods/ods-poststate.test.ts and the sibling ODS
    // suites, which this repo's `pnpm exec vitest list` already surfaces
    // under the default project config with no extra CI step.
    const shared = readFileSync(path.resolve(__dirname, '..', '..', 'vitest.shared.ts'), 'utf8')
    expect(shared).not.toMatch(/tests\/ods/)
  })
})
