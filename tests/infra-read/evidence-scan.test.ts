// @vitest-environment node
// tests/infra-read/evidence-scan.test.ts — the SUPPLEMENTAL evidence scanner.
// Credential-shaped inputs are assembled at runtime; none is a committed literal.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DETECTORS, classifyFile, classifyWriteSet, scanFiles, scanText } from '../../scripts/infra-read/evidence-scan'
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
  // v1.0.5 free-text detectors. Every one of these sits inside an otherwise
  // allowed textual field (a description, a name, a log line).
  ['VERCEL_VCP_TOKEN', j('deployment note: ', 'vc', 'p_', 'a1B2c3D4e5F6g7H8i9J0')],
  ['URL_USERINFO', j('remote https://', 'x-access-token', '@github.com/o/r.git')],
  ['URL_USERINFO', j('see https://', 'ghx0123456789abcdef', '@github.com/o/r')],
  ['ENV_ASSIGNMENT_SECRET', j('GH_', 'TOKEN=', 'abcdef0123456789')],
  ['ENV_ASSIGNMENT_SECRET', j('export Vercel_', 'Token=', 'abcdef0123456789')],
  ['ENV_ASSIGNMENT_SECRET', j('set gh_', 'token="', 'abcdef0123456789"')],
  ['ENV_ASSIGNMENT_SECRET', j('$env:GH_', 'TOKEN = "', 'abcdef0123456789"')],
  ['ENV_ASSIGNMENT_SECRET', j('NPM_AUTH', '_TOKEN=', 'abcdef0123456789')],
  ['KEYWORD_ADJACENT_OPAQUE', j('tok', 'en: ', 'Qw7'.repeat(8))],
  ['KEYWORD_ADJACENT_OPAQUE', j('?tok', 'en=', 'Qw7'.repeat(8))],
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

  it('v1.0.5 detectors stay silent on references, source code and bare ids', () => {
    const benign = [
      j('GH_', 'TOKEN=$GH_TOKEN_FROM_VAULT'), j('VERCEL_', 'TOKEN=%VERCEL_TOKEN%'),
      j("const GH_TOKEN_ENV = ", "'GH_TOKEN'"), j('CREDENTIAL_NAME_RE = /', 'TOKEN|SECRET/'),
      'https://github.com/lorenzozanello/uellix-antigravity.git', 'git@github.com:o/r.git',
      // A classic 24-char Vercel id with no credential keyword is shape-identical to a
      // classic token: it is deliberately NOT flagged (residual, see v1.0.5).
      JSON.stringify({ uid: 'Zx9'.repeat(8), teamId: 'team_' + 'Zx9'.repeat(8) }),
      'vcp_short', 'the vcp_ prefix',
    ]
    for (const t of benign) expect(scanText(t)).toEqual([])
  })

  it('KNOWN FALSE POSITIVE, retained (entropy NB stays OPEN): a long separator-segmented identifier', () => {
    // Measured in committed authority keys. Exempting >=3 separators would also
    // exempt ~13% of random 40-char base64url tokens, a material weakening.
    expect(scanText(j(' class_for_DN-7_DN-8_DN-9_DN-10_DN-11_DN-12', ' ')).map((f) => f.detector)).toEqual(['OPAQUE_HIGH_ENTROPY'])
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

  describe('write-set classification (SEN-D2)', () => {
    const clean = { designated: undefined }
    it('an undesignated file is CLEAN only with zero findings, otherwise FAIL', () => {
      expect(classifyFile([], clean.designated)).toBe('CLEAN')
      expect(classifyFile([{ detector: 'URL_USERINFO', offset: 1 }], clean.designated)).toBe('FAIL')
    })
    it('a designated fixture is EXPECTED_DETECTIONS only with EXACTLY its declared counts', () => {
      const d = { URL_USERINFO: 2 }
      expect(classifyFile([{ detector: 'URL_USERINFO', offset: 1 }, { detector: 'URL_USERINFO', offset: 9 }], d)).toBe('EXPECTED_DETECTIONS')
      expect(classifyFile([{ detector: 'URL_USERINFO', offset: 1 }], d)).toBe('FAIL') // detector regression
      expect(classifyFile([{ detector: 'URL_USERINFO', offset: 1 }, { detector: 'URL_USERINFO', offset: 9 }, { detector: 'VERCEL_VCP_TOKEN', offset: 20 }], d)).toBe('FAIL') // extra leak
      expect(classifyFile([], {})).toBe('FAIL') // an empty designation is not a suppression
    })
    it('a set: stale designations and empty sets are errors; one FAIL fails the set', () => {
      const texts: Record<string, string> = { 'a.ts': 'plain', 'b.test.ts': j('https://', 'u:p', '@h/x') }
      const read = (p: string) => texts[p]
      expect(classifyWriteSet(['a.ts', 'b.test.ts'], { 'b.test.ts': { URL_USERINFO: 1 } }, read).pass).toBe(true)
      expect(classifyWriteSet(['a.ts', 'b.test.ts'], {}, read).pass).toBe(false)
      expect(() => classifyWriteSet(['a.ts'], { 'gone.ts': { URL_USERINFO: 1 } }, read)).toThrow(/STOP_EXPECTED_DETECTIONS_STALE/)
      expect(() => classifyWriteSet([], {}, read)).toThrow(/STOP_EVIDENCE_SCAN_EMPTY_SET/)
    })
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
