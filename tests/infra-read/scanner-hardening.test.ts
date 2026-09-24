// @vitest-environment node
// tests/infra-read/scanner-hardening.test.ts
//
// v1.0.8 (recert NB-1): the runtime evidence scanner carries the repository's
// OWN private-key detector, and a link.repo value is deferred to the same-run
// witness only inside GitHub's documented repository-name grammar. A private
// key (with or without entropy) can never be deferred, adjudicated or
// explained. Every PEM header here is assembled at runtime; the provider is
// the fake world; no network.

import { describe, it, expect } from 'vitest'
import { DETECTORS, scanText } from '../../scripts/infra-read/evidence-scan'
import { PRIVATE_KEY_BLOCK_PATTERN, scanText as repoGateScan } from '../../scripts/scan-secrets'
import { GITHUB_REPOSITORY_NAME_RE, RepositoryInventoryWitness } from '../../scripts/infra-read/repo-witness'
import { SafeReadExecutor, isValidatedEvidence } from '../../scripts/infra-read/executor'
import { SecretDetectedRefusal } from '../../scripts/infra-read/safe-diagnostic'
import { scanEvidenceText } from '../../scripts/infra-read/evidence-adjudication'
import { Refusal } from '../../scripts/infra-read/ops'
import { CTX, TEAM, antigravityProject, fakeRunner, repoShaped, world } from './fixtures'
import type { RunResult } from '../../scripts/infra-read/executor'

const ctx = { ...CTX, xcc1Env: {}, xcc1Cwd: '/tmp/unused' }
const json = (v: unknown): RunResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' })
const pem = (label: string) => ['-----BEGIN ', label, 'PRIVATE KEY', label === 'PGP ' ? ' BLOCK' : '', '-----'].join('')
const RUN = repoShaped(2)
const OWNER = 'lorenzozanello'
const REPO_ID = 8_000_002

function token(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

/** V-R2.S2 with a GitHub-linked project whose link.repo is `value`, plus a G-R5 inventory that WOULD match it. */
function runWith(value: string) {
  const flagged = { id: 'prj_FLAGGED00004', name: 'flagged', accountId: TEAM, link: { type: 'github', repo: value, org: OWNER, repoId: REPO_ID } }
  const runner = fakeRunner(world({
    [`/v9/projects?teamId=${TEAM}&limit=100`]: json({ projects: [antigravityProject(), flagged], pagination: { count: 2, next: null } }),
    '/user/repos?per_page=100&page=1': json([{ id: REPO_ID, name: value, full_name: `${OWNER}/${value}`, owner: { login: OWNER } }]),
    '/user/repos?per_page=100&page=2': json([]),
  }))
  const ex = new SafeReadExecutor(runner, ctx)
  ex.run('G-R1'); ex.run('G-R3'); ex.run('V-R2.S1')
  let error: unknown
  let record: ReturnType<typeof ex.run> | undefined
  try { record = ex.run('V-R2.S2', { teamId: TEAM }) } catch (e) { error = e }
  return { ex, runner, error, record }
}

describe('1. detector-catalog consistency: ONE private-key definition, reused at runtime', () => {
  it('the runtime catalog carries PRIVATE_KEY_BLOCK and it IS the repository pattern (not a copy)', () => {
    const d = DETECTORS.find((x) => x.id === 'PRIVATE_KEY_BLOCK')
    expect(d).toBeDefined()
    expect(d!.re).toBe(PRIVATE_KEY_BLOCK_PATTERN)
  })
  for (const label of ['', 'RSA ', 'EC ', 'OPENSSH ', 'PGP ', 'ENCRYPTED ', 'DSA ']) {
    it(`both scanners detect the ${JSON.stringify(label || 'bare')} private-key header`, () => {
      expect(scanText(`x ${pem(label)} y`).map((f) => f.detector)).toContain('PRIVATE_KEY_BLOCK')
      expect(repoGateScan(`x ${pem(label)} y`, 'docs/x.md').map((f) => f.kind)).toContain('PRIVATE_KEY_BLOCK')
    })
  }
  it('the repository pattern is a superset of the previous one (no weakening)', () => {
    const previous = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/
    for (const label of ['', 'RSA ', 'EC ', 'OPENSSH ']) {
      const h = pem(label)
      expect(previous.test(h)).toBe(true)
      expect(PRIVATE_KEY_BLOCK_PATTERN.test(h)).toBe(true)
    }
  })
  it('provider text cannot exempt itself: the repo gate\'s annotation allowance does NOT apply at runtime', () => {
    const annotated = ['secret-scan-', 'ok: fixture ', pem('RSA ')].join('')
    expect(repoGateScan(annotated, 'docs/x.md')).toEqual([]) // the repo gate honours its annotation...
    expect(scanText(annotated).map((f) => f.detector)).toContain('PRIVATE_KEY_BLOCK') // ...the evidence scanner never does
  })
  it('the header survives JSON serialization (the decision scans JSON.stringify(projection))', () => {
    expect(scanText(JSON.stringify({ link: { repo: pem('') } })).map((f) => f.detector)).toContain('PRIVATE_KEY_BLOCK')
  })
})

describe('2. GitHub repository-name grammar (documented), defense in depth', () => {
  it('is exactly the documented grammar: <= 100 chars of ASCII letters, digits, ".", "-", "_"', () => {
    expect(GITHUB_REPOSITORY_NAME_RE.source).toBe('^[A-Za-z0-9._-]{1,100}$')
    for (const ok of ['uellix-antigravity', 'a', 'A.b_c-1', 'x'.repeat(100), RUN]) expect(GITHUB_REPOSITORY_NAME_RE.test(ok)).toBe(true)
    for (const bad of ['', 'x'.repeat(101), 'a b', 'o/r', 'a!b', 'ä', pem('')]) expect(GITHUB_REPOSITORY_NAME_RE.test(bad)).toBe(false)
  })
})

describe('3/4. adversarial link.repo values through the real executor', () => {
  const refused: [string, string, string][] = [
    ['private-key block + opaque entropy', `${pem('')}${RUN}`, 'PRIVATE_KEY_BLOCK'],
    ['private-key block without entropy', pem('RSA '), 'PRIVATE_KEY_BLOCK'],
    ['Bearer-like material + a valid-looking repo token', ['Bearer ', RUN].join(''), 'BEARER_OR_BASIC_CREDENTIAL'],
    ['userinfo credential', ['https://', 'deploy', '@github.com/', RUN].join(''), 'URL_USERINFO'],
    ['known token prefix (grammar-valid!)', ['gh', 'p_', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm'].join(''), 'GITHUB_TOKEN_FAMILY'],
    ['known token prefix vcp_ (grammar-valid!)', ['vc', 'p_', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8'].join(''), 'VERCEL_VCP_TOKEN'],
  ]
  for (const [name, value, detector] of refused) {
    it(`STOP, never deferred, even though the inventory would match: ${name}`, () => {
      const { runner, error } = runWith(value)
      expect(error).toBeInstanceOf(SecretDetectedRefusal)
      expect((error as SecretDetectedRefusal).token).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
      // Authority honesty: the NAMED detector fires at runtime (not merely the entropy or grammar layer).
      expect((error as SecretDetectedRefusal).diagnostics.map((d) => d.detector_id)).toContain(detector)
      expect(runner.calls.some((c) => c.opId === 'G-R5')).toBe(false)
    })
  }
  it('grammar layer alone: an entropy-only value outside the grammar is NOT deferred', () => {
    const value = `${RUN}!`
    expect(scanText(value).map((f) => f.detector)).toEqual(['OPAQUE_HIGH_ENTROPY'])
    const { runner, error } = runWith(value)
    expect(token(() => { if (error) throw error })).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
    expect(runner.calls.some((c) => c.opId === 'G-R5')).toBe(false)
  })
  it('a random opaque, grammar-valid repo-like name IS deferred and adjudicated by the same-run witness', () => {
    const { ex, error, record } = runWith(RUN)
    expect(error).toBeUndefined()
    expect(isValidatedEvidence(record)).toBe(false)
    do ex.run('G-R5', { page: String(ex.witness.expectedPage()) })
    while (!ex.witness.isComplete())
    const { replacements } = ex.finalizeRepositoryWitness()
    const resolved = replacements.get(record!)!
    expect(resolved.scanner_adjudications[0].classification).toBe('EXPECTED_PROVIDER_IDENTIFIER')
  })
  it('an ordinary GitHub repo name trips nothing and is ordinary evidence (no witness)', () => {
    const { runner, error, record } = runWith('uellix-production-web')
    expect(error).toBeUndefined()
    expect(isValidatedEvidence(record)).toBe(true)
    expect(record!.scanner_adjudications).toEqual([])
    expect(runner.calls.some((c) => c.opId === 'G-R5')).toBe(false)
  })
})

describe('3. witness and evidence re-scan never accept what the scan refuses', () => {
  it('the witness refuses a target outside the grammar (its own layer)', () => {
    const w = new RepositoryInventoryWitness()
    expect(token(() => w.addTarget({ projectId: 'p', repoId: 5, linkType: 'github', linkRepo: `${RUN} x`, linkOrg: OWNER }))).toBe('STOP_WITNESS_UNKNOWN')
  })
  const record = (repo: string) => JSON.stringify({
    op_id: 'V-R2.S2', projection: { projects: [{ id: 'prj_FLAGGED00004', link: { type: 'github', repo, org: OWNER, repoId: REPO_ID } }] },
    scanner_adjudications: [{ normalized_schema_path: 'projects[*].link.repo', project_id: 'prj_FLAGGED00004', detector_id: 'OPAQUE_HIGH_ENTROPY', classification: 'EXPECTED_PROVIDER_IDENTIFIER', basis: 'SAME_RUN_AUTHENTICATED_REPOSITORY_INVENTORY_ID_MATCH' }],
  }, null, 1)
  const cases: [string, string, string][] = [
    ['private key + entropy, even with an adjudication marker and a "same-run" value', `${pem('')}${RUN}`, 'PRIVATE_KEY_BLOCK'],
    ['token prefix inside the grammar (scan layer)', ['gh', 'p_', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm'].join(''), 'GITHUB_TOKEN_FAMILY'],
    ['entropy only, outside the grammar (grammar layer)', `${RUN}!`, 'OPAQUE_HIGH_ENTROPY'],
  ]
  it('a value tripping entropy AND another detector is not adjudicated AT ALL: not even its entropy finding is explained', () => {
    const both = ['gh', 'p_', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7', 'Hh8Ii9Jj0Kk1Ll2Mm3Nn4'].join('')
    expect(GITHUB_REPOSITORY_NAME_RE.test(both)).toBe(true)
    expect(scanText(both).map((f) => f.detector).sort()).toEqual(['GITHUB_TOKEN_FAMILY', 'OPAQUE_HIGH_ENTROPY'])
    const r = scanEvidenceText(record(both), 'f', () => true)
    expect(r.adjudicatedExplained).toBe(0)
    const unexplained = r.unexplained.map((f) => f.detector)
    expect(unexplained).toContain('GITHUB_TOKEN_FAMILY')
    expect(unexplained).toContain('OPAQUE_HIGH_ENTROPY')
  })
  for (const [name, repo, detector] of cases) {
    it(`unexplained: ${name}`, () => {
      const r = scanEvidenceText(record(repo), 'f', () => true)
      expect(r.unexplained.length).toBeGreaterThan(0)
      expect(r.unexplained.map((f) => f.detector)).toContain(detector)
    })
  }
})
