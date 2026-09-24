// @vitest-environment node
// tests/infra-read/repo-witness.test.ts
//
// v1.0.7 same-run repository-identity witness (G-R5, owner decision LRW-2).
// The V-R2.S2 OPAQUE_HIGH_ENTROPY finding at projects[*].link.repo may be
// adjudicated EXPECTED_PROVIDER_IDENTIFIER only through an exact binding to an
// identity GitHub returned, in THIS run, from GET /user/repos. Everything else
// STOPs. All values are synthetic and assembled at runtime; the provider is the
// fake world; no network.

import { describe, it, expect } from 'vitest'
import { SafeReadExecutor, isValidatedEvidence } from '../../scripts/infra-read/executor'
import { Refusal, getOp } from '../../scripts/infra-read/ops'
import { buildInvocation, assertInvocationSafe } from '../../scripts/infra-read/guards'
import { RepositoryInventoryWitness, MAX_INVENTORY_PAGES } from '../../scripts/infra-read/repo-witness'
import { scanEvidenceText } from '../../scripts/infra-read/evidence-adjudication'
import { scanText } from '../../scripts/infra-read/evidence-scan'
import { CTX, TEAM, antigravityProject, fakeRunner, repoShaped, world } from './fixtures'
import type { RunResult } from '../../scripts/infra-read/executor'

const ctx = { ...CTX, xcc1Env: {}, xcc1Cwd: '/tmp/unused' }
const json = (v: unknown): RunResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' })
const httpErr = (code: number): RunResult => ({ status: 1, stdout: '', stderr: `gh: request failed (HTTP ${code})` })

const TARGET_ID = 7_000_001
const OWNER = 'lorenzozanello'
const TARGET = repoShaped(1)

interface Repo { id: number; name: string; full_name: string; owner: { login: string }; private?: boolean; description?: string; html_url?: string }
const repo = (id: number, name: string, owner = OWNER, full = `${owner}/${name}`): Repo =>
  ({ id, name, full_name: full, owner: { login: owner }, private: true, description: `desc ${repoShaped(id % 97)}`, html_url: `https://github.com/${owner}/${name}` })

/** Pages of /user/repos for an inventory; the page after the last is []. */
function inventoryWorld(items: Repo[]): Record<string, RunResult> {
  const out: Record<string, RunResult> = {}
  const pages = Math.ceil(items.length / 100)
  for (let p = 1; p <= pages; p++) out[`/user/repos?per_page=100&page=${p}`] = json(items.slice((p - 1) * 100, p * 100))
  out[`/user/repos?per_page=100&page=${pages + 1}`] = json([])
  return out
}

/** A V-R2.S2 list with the antigravity project plus one project whose link.repo is `value`. */
function vr2s2With(link: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, RunResult> {
  const flagged = { id: 'prj_FLAGGED00003', name: 'flagged-project', accountId: TEAM, createdAt: 1, updatedAt: 2, link: { productionBranch: 'main', ...link }, ...extra }
  return { [`/v9/projects?teamId=${TEAM}&limit=100`]: json({ projects: [antigravityProject(), flagged], pagination: { count: 2, next: null } }) }
}

const goodLink = { type: 'github', repo: TARGET, org: OWNER, repoId: TARGET_ID }
const filler = (n: number, from = 1): Repo[] => Array.from({ length: n }, (_, i) => repo(from + i, `repo-${from + i}`))

function token(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

function primedWith(w: Record<string, RunResult>) {
  const runner = fakeRunner(world(w))
  const ex = new SafeReadExecutor(runner, ctx)
  ex.run('G-R1')
  ex.run('G-R3')
  ex.run('V-R2.S1')
  const s2 = ex.run('V-R2.S2', { teamId: TEAM })
  return { ex, runner, s2 }
}

/** Runs the G-R5 traversal to completion, then the verdict. */
function traverse(ex: InstanceType<typeof SafeReadExecutor>) {
  do ex.run('G-R5', { page: String(ex.witness.expectedPage()) })
  while (!ex.witness.isComplete())
  return ex.finalizeRepositoryWitness()
}

describe('deferral is limited to OPAQUE_HIGH_ENTROPY at exactly V-R2.S2 projects[*].link.repo', () => {
  it('the synthetic value is repo-shaped AND trips OPAQUE_HIGH_ENTROPY only', () => {
    expect(TARGET).toMatch(/^[A-Za-z0-9-]{40}$/)
    expect(scanText(TARGET).map((f) => f.detector)).toEqual(['OPAQUE_HIGH_ENTROPY'])
  })
  it('a github link with numeric repoId is DEFERRED: the record is pending, NOT validated evidence', () => {
    const { ex, s2 } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld([...filler(5), repo(TARGET_ID, TARGET)]) })
    expect(isValidatedEvidence(s2)).toBe(false)
    expect(s2.scanner_adjudications).toEqual([{ normalized_schema_path: 'projects[*].link.repo', project_id: 'prj_FLAGGED00003', detector_id: 'OPAQUE_HIGH_ENTROPY', classification: 'PENDING_SAME_RUN_WITNESS', basis: 'SAME_RUN_AUTHENTICATED_REPOSITORY_INVENTORY_ID_MATCH' }])
    expect(ex.hasPendingAdjudications()).toBe(true)
  })
  const immediate: [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ['link.type is not github (github-limited)', { ...goodLink, type: 'github-limited' }],
    ['link.type is not github (gitlab)', { ...goodLink, type: 'gitlab' }],
    ['repoId not numeric', { ...goodLink, repoId: String(TARGET_ID) }],
    ['repoId zero', { ...goodLink, repoId: 0 }],
    ['org missing', { type: 'github', repo: TARGET, repoId: TARGET_ID }],
    ['a token-prefix detector also fires on link.repo', { ...goodLink, repo: ['vc', 'p_', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8'].join('') }],
    ['a userinfo detector also fires on link.repo', { ...goodLink, repo: ['https://', 'x', '@h/', repoShaped(3)].join('') }],
    ['the same entropy value also at projects[*].name (not the adjudicable path)', goodLink, { name: TARGET }],
  ]
  for (const [name, link, extra] of immediate) {
    it(`STOP at once, with the certified diagnostic: ${name}`, () => {
      const runner = fakeRunner(world({ ...vr2s2With(link, extra), ...inventoryWorld([repo(TARGET_ID, TARGET)]) }))
      const ex = new SafeReadExecutor(runner, ctx)
      ex.run('G-R1'); ex.run('G-R3'); ex.run('V-R2.S1')
      expect(token(() => ex.run('V-R2.S2', { teamId: TEAM }))).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
      expect(runner.calls.some((c) => c.opId === 'G-R5')).toBe(false)
    })
  }
})

describe('witness PASS: exact same-run binding', () => {
  it('id + name + owner + full_name + type match -> the V-R2.S2 record is adjudicated and validated', () => {
    const inv = [...filler(250), repo(TARGET_ID, TARGET), ...filler(120, 300)]
    const { ex, s2, runner } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld(inv) })
    const { witnessRecord, replacements } = traverse(ex)
    const resolved = replacements.get(s2)!
    expect(isValidatedEvidence(resolved)).toBe(true)
    expect(isValidatedEvidence(witnessRecord)).toBe(true)
    expect(resolved.scanner_adjudications[0].classification).toBe('EXPECTED_PROVIDER_IDENTIFIER')
    expect(witnessRecord.projection).toEqual({ pages_traversed: 5, terminal: 'EMPTY_PAGE', matched: [{ id: TARGET_ID, owner: { login: OWNER } }] })
    expect(ex.isAdjudicatedValue(TARGET)).toBe(true)
    expect(ex.hasPendingAdjudications()).toBe(false)
    // Pagination ran to COMPLETION (empty page), in order, even after the match on page 3.
    expect(runner.calls.filter((c) => c.opId === 'G-R5').map((c) => c.endpoint)).toEqual([1, 2, 3, 4, 5].map((p) => `/user/repos?per_page=100&page=${p}`))
  })
  it('non-matching repositories are discarded: absent from every record, never retained', () => {
    const inv = [...filler(150), repo(TARGET_ID, TARGET)]
    const { ex } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld(inv) })
    const pageRecords: unknown[] = []
    do pageRecords.push(ex.run('G-R5', { page: String(ex.witness.expectedPage()) }))
    while (!ex.witness.isComplete())
    const { witnessRecord } = ex.finalizeRepositoryWitness()
    const all = JSON.stringify([pageRecords, witnessRecord])
    for (const r of filler(150)) { expect(all).not.toContain(r.name); expect(all).not.toContain(`"id":${r.id},`) }
    expect(all).not.toContain(TARGET) // the matched NAME is never duplicated into G-R5 evidence either
    expect(all).not.toContain('desc ')
    expect(all).not.toContain('html_url')
    expect(ex.witness.retainedCounts()).toEqual({ targets: 1, matchedIdentities: 1 })
  })
  it('bounded memory: 9,900 repositories retain exactly the target set, not the inventory', () => {
    const inv = [...filler(9899), repo(TARGET_ID, TARGET)]
    const { ex } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld(inv) })
    traverse(ex)
    expect(ex.witness.retainedCounts()).toEqual({ targets: 1, matchedIdentities: 1 })
  })
})

describe('witness FAIL / UNKNOWN / ERROR -> STOP', () => {
  const cases: [string, Repo[], string][] = [
    ['zero match (repoId absent from the inventory)', filler(30), 'STOP_WITNESS_ZERO_MATCH'],
    ['wrong name', [repo(TARGET_ID, repoShaped(2))], 'STOP_WITNESS_NAME_MISMATCH'],
    ['case difference in name (no normalization)', [repo(TARGET_ID, TARGET.toLowerCase())], 'STOP_WITNESS_NAME_MISMATCH'],
    ['wrong owner', [repo(TARGET_ID, TARGET, 'someone-else')], 'STOP_WITNESS_OWNER_MISMATCH'],
    ['case difference in owner', [repo(TARGET_ID, TARGET, 'LorenzoZanello')], 'STOP_WITNESS_OWNER_MISMATCH'],
    ['incoherent full_name', [repo(TARGET_ID, TARGET, OWNER, `${OWNER}/other`)], 'STOP_WITNESS_FULL_NAME_INCOHERENT'],
    ['duplicate id across pages', [repo(TARGET_ID, TARGET), ...filler(100, 10), repo(TARGET_ID, TARGET)], 'STOP_WITNESS_MULTIPLE_MATCH'],
    ['same owner/name, different id', [repo(TARGET_ID + 1, TARGET)], 'STOP_WITNESS_ZERO_MATCH'],
  ]
  for (const [name, inv, tok] of cases) {
    it(name, () => {
      const { ex } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld(inv) })
      expect(token(() => traverse(ex))).toBe(tok)
    })
  }
  const pageFaults: [string, Record<string, RunResult>, string][] = [
    ['401', { '/user/repos?per_page=100&page=1': httpErr(401) }, 'STOP_PROVIDER_ERROR'],
    ['403', { '/user/repos?per_page=100&page=1': httpErr(403) }, 'STOP_PROVIDER_ERROR'],
    ['429 rate limit', { '/user/repos?per_page=100&page=1': httpErr(429) }, 'STOP_PROVIDER_ERROR'],
    ['timeout / no status', { '/user/repos?per_page=100&page=1': { status: null, stdout: '', stderr: '' } }, 'STOP_PROVIDER_STATUS_UNRESOLVED'],
    ['malformed page (object)', { '/user/repos?per_page=100&page=1': json({ items: [] }) }, 'STOP_PROVIDER_OUTPUT_UNPARSABLE'],
    ['malformed JSON', { '/user/repos?per_page=100&page=1': { status: 0, stdout: '[{', stderr: '' } }, 'STOP_PROVIDER_OUTPUT_UNPARSABLE'],
    ['item missing owner.login', { '/user/repos?per_page=100&page=1': json([{ id: 5, name: 'a', full_name: 'x/a' }]) }, 'STOP_PROVIDER_OUTPUT_UNPARSABLE'],
    ['item with non-numeric id', { '/user/repos?per_page=100&page=1': json([{ id: '5', name: 'a', full_name: 'x/a', owner: { login: 'x' } }]) }, 'STOP_PROVIDER_OUTPUT_UNPARSABLE'],
    ['page larger than per_page', { '/user/repos?per_page=100&page=1': json(filler(101)) }, 'STOP_PAGINATION_INCOMPLETE'],
    ['pagination loop (same page repeated)', { '/user/repos?per_page=100&page=1': json(filler(100)), '/user/repos?per_page=100&page=2': json(filler(100)) }, 'STOP_PAGINATION_LOOP'],
  ]
  for (const [name, pages, tok] of pageFaults) {
    it(`G-R5 ${name}`, () => {
      const { ex } = primedWith({ ...vr2s2With(goodLink), ...pages })
      expect(token(() => traverse(ex))).toBe(tok)
    })
  }
  it('page cap: an inventory that never ends STOPs instead of truncating', () => {
    const pages: Record<string, RunResult> = {}
    for (let p = 1; p <= MAX_INVENTORY_PAGES + 1; p++) pages[`/user/repos?per_page=100&page=${p}`] = json(filler(100, p * 1000))
    const { ex } = primedWith({ ...vr2s2With(goodLink), ...pages })
    expect(token(() => traverse(ex))).toBe('STOP_PAGINATION_INCOMPLETE')
  })
  it('verdict before completion (truncated traversal) STOPs', () => {
    const { ex } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld([repo(TARGET_ID, TARGET), ...filler(150)]) })
    ex.run('G-R5', { page: '1' })
    expect(token(() => ex.finalizeRepositoryWitness())).toBe('STOP_PAGINATION_INCOMPLETE')
  })
})

describe('request safety: no Vercel value can reach GitHub', () => {
  it('every G-R5 request is exactly api --method GET /user/repos?per_page=100&page=N', () => {
    const { ex, runner } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld([repo(TARGET_ID, TARGET)]) })
    traverse(ex)
    const calls = runner.calls.filter((c) => c.opId === 'G-R5')
    expect(calls.length).toBe(2)
    for (const c of calls) {
      expect(c.argv).toEqual(['api', '--method', 'GET', c.endpoint])
      expect(c.endpoint).toMatch(/^\/user\/repos\?per_page=100&page=[1-9][0-9]{0,2}$/)
      for (const v of [TARGET, OWNER, String(TARGET_ID), 'flagged']) expect(JSON.stringify(c)).not.toContain(v)
    }
  })
  it('the builder uses ONLY the page: extra params (repo, org, repoId, q) are ignored', () => {
    const inv = buildInvocation(getOp('G-R5'), { page: '2', repo: TARGET, org: OWNER, repoId: String(TARGET_ID), q: 'x' }, ctx)
    expect(inv.argv).toEqual(['api', '--method', 'GET', '/user/repos?per_page=100&page=2'])
  })
  for (const bad of ['0', '01', '-1', '1000', '1 ', '1/../x', '1&q=x', '1?x', 'a', '']) {
    it(`the builder refuses page ${JSON.stringify(bad)}`, () => {
      expect(token(() => buildInvocation(getOp('G-R5'), { page: bad }, ctx))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
    })
  }
  for (const [name, endpoint] of [
    ['a repo name in the query', `/user/repos?per_page=100&page=1&q=${TARGET}`],
    ['an org in the query', `/user/repos?per_page=100&page=1&affiliation=${OWNER}`],
    ['the repoId in the path', `/repositories/${TARGET_ID}`],
    ['an owner/name path', `/repos/${OWNER}/${TARGET}`],
    ['search', `/search/repositories?q=${TARGET}`],
  ] as const) {
    it(`the exact-shape guard refuses ${name}`, () => {
      const inv = { opId: 'G-R5', tool: 'gh' as const, file: ctx.ghFile, argv: ['api', '--method', 'GET', endpoint], env: ctx.ghEnv, endpoint }
      expect(token(() => assertInvocationSafe(inv, getOp('G-R5'), ctx))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
    })
  }
  it('G-R5 is refused without a pending adjudication, out of order, and after completion', () => {
    const plain = new SafeReadExecutor(fakeRunner(world(inventoryWorld([]))), ctx)
    plain.run('G-R1')
    expect(token(() => plain.run('G-R5', { page: '1' }))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
    const { ex } = primedWith({ ...vr2s2With(goodLink), ...inventoryWorld([repo(TARGET_ID, TARGET)]) })
    expect(token(() => ex.run('G-R5', { page: '2' }))).toBe('STOP_PAGINATION_INCOMPLETE')
    traverse(ex)
    expect(token(() => ex.run('G-R5', { page: '3' }))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
  })
})

describe('cross-run isolation: the witness starts empty in every execution', () => {
  it('a completed witness in run A gives run B nothing', () => {
    const w = { ...vr2s2With(goodLink), ...inventoryWorld([repo(TARGET_ID, TARGET)]) }
    const a = primedWith(w)
    traverse(a.ex)
    expect(a.ex.isAdjudicatedValue(TARGET)).toBe(true)
    const b = new SafeReadExecutor(fakeRunner(world(w)), ctx)
    expect(b.isAdjudicatedValue(TARGET)).toBe(false)
    expect(b.witness.hasTargets()).toBe(false)
    expect(token(() => b.finalizeRepositoryWitness())).toBe('STOP_WITNESS_UNKNOWN')
  })
  it('a fresh witness cannot be satisfied without its own pages (no cached inventory, no hard-coded identity)', () => {
    const w = new RepositoryInventoryWitness()
    w.addTarget({ projectId: 'p', repoId: TARGET_ID, linkType: 'github', linkRepo: TARGET, linkOrg: OWNER })
    expect(token(() => w.verdict())).toBe('STOP_PAGINATION_INCOMPLETE')
    w.ingestPage(1, [])
    expect(token(() => w.verdict())).toBe('STOP_WITNESS_ZERO_MATCH')
  })
  it('the witness itself re-checks link.type (second layer behind the deferral rule)', () => {
    const w = new RepositoryInventoryWitness()
    w.addTarget({ projectId: 'p', repoId: 5, linkType: 'gitlab', linkRepo: 'a', linkOrg: 'o' })
    w.ingestPage(1, [{ id: 5, name: 'a', full_name: 'o/a', owner: { login: 'o' } }])
    w.ingestPage(2, [])
    expect(token(() => w.verdict())).toBe('STOP_WITNESS_TYPE_MISMATCH')
  })
  it('the G-R5 projection is exactly id, name, full_name, owner.login (no broadening)', () => {
    expect(getOp('G-R5').allowlist).toEqual(['[].id', '[].name', '[].full_name', '[].owner.login'])
  })
  it('targets cannot be added once the traversal started', () => {
    const w = new RepositoryInventoryWitness()
    w.addTarget({ projectId: 'p', repoId: 1, linkType: 'github', linkRepo: 'a', linkOrg: 'o' })
    w.ingestPage(1, [{ id: 2, name: 'b', full_name: 'o/b', owner: { login: 'o' } }])
    expect(token(() => w.addTarget({ projectId: 'q', repoId: 3, linkType: 'github', linkRepo: 'c', linkOrg: 'o' }))).toBe('STOP_WITNESS_ORDER')
  })
})

describe('evidence re-scan (EC-1) honours ONLY the same-run adjudication', () => {
  const record = (adjudicated: boolean, repoValue = TARGET) => JSON.stringify({
    op_id: 'V-R2.S2', projection: { projects: [{ id: 'prj_FLAGGED00003', link: { type: 'github', repo: repoValue, org: OWNER, repoId: TARGET_ID } }] },
    scanner_adjudications: adjudicated ? [{ normalized_schema_path: 'projects[*].link.repo', project_id: 'prj_FLAGGED00003', detector_id: 'OPAQUE_HIGH_ENTROPY', classification: 'EXPECTED_PROVIDER_IDENTIFIER', basis: 'SAME_RUN_AUTHENTICATED_REPOSITORY_INVENTORY_ID_MATCH' }] : [],
  }, null, 1)
  it('adjudicated + same-run value -> explained at BOTH levels', () => {
    const r = scanEvidenceText(record(true), 'f', (v) => v === TARGET)
    expect(r.unexplained).toEqual([])
    expect(r.adjudicatedExplained).toBe(2)
  })
  it('no adjudication marker -> unexplained', () => {
    expect(scanEvidenceText(record(false), 'f', () => true).unexplained.length).toBe(2)
  })
  it('marker but NOT a same-run value -> unexplained', () => {
    expect(scanEvidenceText(record(true), 'f', () => false).unexplained.length).toBe(2)
  })
  it('the same value elsewhere in the record -> unexplained', () => {
    const t = record(true).replace('"op_id": "V-R2.S2",', `"op_id": "V-R2.S2", "note": "${TARGET}",`)
    const r = scanEvidenceText(t, 'f', (v) => v === TARGET)
    expect(r.unexplained.some((f) => f.where.includes('note') || f.level === 'SERIALIZED')).toBe(true)
  })
  it('a marker on any other op is not honoured', () => {
    const t = record(true).replace('"V-R2.S2"', '"V-R1"')
    expect(scanEvidenceText(t, 'f', () => true).unexplained.length).toBe(2)
  })
})
