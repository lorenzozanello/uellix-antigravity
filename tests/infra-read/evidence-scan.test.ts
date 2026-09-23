// @vitest-environment node
// tests/infra-read/evidence-scan.test.ts — the SUPPLEMENTAL evidence scanner.
// Credential-shaped inputs are assembled at runtime; none is a committed literal.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DETECTORS, scanFiles, scanText } from '../../scripts/infra-read/evidence-scan'
import { fakeDeployHookUrl, fakeGithubToken } from './fixtures'

const j = (...parts: string[]) => parts.join('')

const positives: [string, string][] = [
  ['GITHUB_TOKEN_FAMILY', `x ${fakeGithubToken()} y`],
  ['GITHUB_TOKEN_FAMILY', j('github', '_pat_', 'A1'.repeat(20))],
  ['VERCEL_DEPLOY_HOOK_URL', fakeDeployHookUrl()],
  ['AUTHORIZATION_HEADER', j('Author', 'ization: ', 'token abcdef123')],
  ['BEARER_OR_BASIC_CREDENTIAL', j('Bea', 'rer ', 'abcDEF1234567890')],
  ['COOKIE_MATERIAL', j('Set-', 'Cookie: sid=1')],
  ['SECRET_KEYED_FIELD', j('{"refresh', 'Token": "', 'abcdefghij"}')],
  ['ENV_VALUE_FIELD', '{"key":"X","value":"plain-value"}'],
  ['URL_USERINFO', j('https://', 'user:pw', '@github.com/x.git')],
  ['OPAQUE_HIGH_ENTROPY', j(' ', 'Ab3'.repeat(15), ' ')],
]

describe('supplemental evidence scan', () => {
  it('has a detector for every class secrets:scan is blind to', () => {
    const ids = DETECTORS.map((d) => d.id)
    for (const id of ['GITHUB_TOKEN_FAMILY', 'VERCEL_DEPLOY_HOOK_URL', 'AUTHORIZATION_HEADER', 'COOKIE_MATERIAL', 'ENV_VALUE_FIELD']) expect(ids).toContain(id)
  })

  for (const [id, text] of positives) {
    it(`fires ${id}`, () => {
      expect(scanText(text).map((f) => f.detector)).toContain(id)
    })
  }

  it('does not flag commit SHAs, Vercel ids, or alias hostnames', () => {
    const benign = JSON.stringify({
      sha: 'a'.repeat(40), sha256: 'b'.repeat(64), prj: 'prj_ANTIGRAV0001', dpl: 'dpl_8ppi9zB44ptTurz4Jdjnvhw4SWRG',
      alias: 'uellix-antigravity-git-int-bb9db7-lorenzozanello-5040s-projects.vercel.app',
      check: 'Lint, typecheck, test, build', scopes: 'gist, read:org, repo, workflow', value_key_only: 'value',
      artifact: 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EFFECTIVE_AUTHORITY_IC_v1.0.0.json',
      verdict: 'INFRA_CONTROL_PLANE_READ_EFFECTIVE_AUTHORITY_IC_PASS_WITH_NONBLOCKING_FINDINGS',
    })
    expect(scanText(benign)).toEqual([])
  })

  it('reports detector and offset only — never the matched secret', () => {
    const tok = fakeGithubToken()
    const findings = scanText(`prefix ${tok}`)
    expect(findings.length).toBeGreaterThan(0)
    expect(JSON.stringify(findings)).not.toContain(tok)
  })

  const dir = mkdtempSync(path.join(tmpdir(), 'evscan-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('an EMPTY file set is a failure, not a vacuous pass', () => {
    expect(() => scanFiles([])).toThrow(/STOP_EVIDENCE_SCAN_EMPTY_SET/)
  })

  it('scans a file set and reports per-file findings', () => {
    const clean = path.join(dir, 'clean.json')
    const dirty = path.join(dir, 'dirty.json')
    writeFileSync(clean, JSON.stringify({ name: 'main', protected: false }))
    writeFileSync(dirty, JSON.stringify({ hook: fakeDeployHookUrl() }))
    const r = scanFiles([clean, dirty])
    expect(r.filesScanned).toBe(2)
    expect(r.findings.map((f) => [path.basename(f.file), f.detector])).toEqual([['dirty.json', 'VERCEL_DEPLOY_HOOK_URL']])
  })
})
