// @vitest-environment node
// tests/infra-read/l7-deployment-repo.test.ts
//
// v1.0.9 (owner decision OPTION 1, lane CV1-INFRA-L7-DEPLOYMENT-REPO-WITNESS-EXTENSION-R1).
// An OPAQUE_HIGH_ENTROPY finding at V-R2.L7 deployments[*].meta.githubRepo is
// adjudicated ONLY when the value is byte-for-byte the V-R2.S2 link.repo that
// the SAME executor's G-R5 witness adjudicated for the SAME team + project the
// deployments page was requested for. It creates no trust source of its own.
// Everything else STOPs with the certified diagnostic. All values are synthetic
// and assembled at runtime; the provider is the fake world; no network.

import { describe, it, expect } from 'vitest'
import {
  DEPLOYMENT_REPO_ADJUDICATION_BASIS, OWNER_CORROBORATION_UNAVAILABLE, SafeReadExecutor, assertEnvelopeConforms,
  deploymentRepoFindingsExplained, isValidatedEvidence, type EvidenceRecord,
} from '../../scripts/infra-read/executor'
import { Refusal } from '../../scripts/infra-read/ops'
import { SecretDetectedRefusal } from '../../scripts/infra-read/safe-diagnostic'
import { GITHUB_REPOSITORY_NAME_RE } from '../../scripts/infra-read/repo-witness'
import { bundleSameProjectLookup, scanEvidenceFiles, scanEvidenceText } from '../../scripts/infra-read/evidence-adjudication'
import { scanText } from '../../scripts/infra-read/evidence-scan'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CTX, TEAM, antigravityProject, fakeRunner, repoShaped, world } from './fixtures'
import type { RunResult } from '../../scripts/infra-read/executor'

const ctx = { ...CTX, xcc1Env: {}, xcc1Cwd: '/tmp/unused' }
const json = (v: unknown): RunResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' })
const OWNER = 'lorenzozanello'
const TEAM2 = 'team_SECOND000002'
const PRJ_A = 'prj_PROJECTA0001'
const PRJ_B = 'prj_PROJECTB0002'
const ID_A = 9_000_001
const ID_B = 9_000_002
const REPO_A = repoShaped(4)
const REPO_B = repoShaped(5)
const pem = () => ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('')
const ghp = () => ['gh', 'p_', 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7', 'Hh8Ii9Jj0Kk1Ll2Mm3Nn4'].join('')
/** REPO_A with the case of ONE letter flipped: still entropy-only and grammar-valid. */
const caseFlipped = (v: string) => { const i = v.search(/[a-z]/); return v.slice(0, i) + v[i].toUpperCase() + v.slice(i + 1) }

function token(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

interface Prj { id: string; link?: Record<string, unknown> }
const linked = (id: string, repo: string, repoId: number): Prj => ({ id, link: { type: 'github', repo, org: OWNER, repoId } })
const inventoryItem = (id: number, name: string) => ({ id, name, full_name: `${OWNER}/${name}`, owner: { login: OWNER } })
const deploymentsOf = (...repos: unknown[]) => json({
  deployments: repos.map((r, i) => ({ uid: `dpl_${i}`, name: 'p', target: 'production', readyState: 'READY', source: 'git', createdAt: i, meta: { githubCommitSha: 'a'.repeat(40), githubCommitRef: 'main', githubRepo: r } })),
  pagination: { count: repos.length, next: null },
})
const l7Endpoint = (prj: string, team = TEAM) => `/v6/deployments?projectId=${prj}&teamId=${team}&limit=100`

interface Scenario {
  projects?: Prj[]
  team2Projects?: Prj[]
  inventory?: ReturnType<typeof inventoryItem>[]
  deployments?: Record<string, RunResult>
}

/** G-R1, G-R3, V-R2.S1 and V-R2.S2 for every team, in protocol order. */
function primed(s: Scenario) {
  const projects = s.projects ?? [linked(PRJ_A, REPO_A, ID_A), { id: PRJ_B }]
  const w: Record<string, RunResult> = {
    '/v2/teams?limit=100': json({ teams: s.team2Projects ? [{ id: TEAM }, { id: TEAM2 }] : [{ id: TEAM }], pagination: { count: 1, next: null } }),
    [`/v9/projects?teamId=${TEAM}&limit=100`]: json({ projects: [antigravityProject(), ...projects.map((p) => ({ name: p.id.toLowerCase(), accountId: TEAM, ...p }))], pagination: { count: 3, next: null } }),
    ...(s.team2Projects ? { [`/v9/projects?teamId=${TEAM2}&limit=100`]: json({ projects: s.team2Projects.map((p) => ({ name: `${p.id.toLowerCase()}-2`, accountId: TEAM2, ...p })), pagination: { count: 1, next: null } }) } : {}),
    '/user/repos?per_page=100&page=1': json(s.inventory ?? [inventoryItem(ID_A, REPO_A)]),
    '/user/repos?per_page=100&page=2': json([]),
    ...(s.deployments ?? {}),
  }
  const runner = fakeRunner(world(w))
  const ex = new SafeReadExecutor(runner, ctx)
  ex.run('G-R1'); ex.run('G-R3'); ex.run('V-R2.S1')
  const s2 = ex.run('V-R2.S2', { teamId: TEAM })
  const s2b = s.team2Projects ? ex.run('V-R2.S2', { teamId: TEAM2 }) : undefined
  return { ex, runner, s2, s2b }
}

/** The G-R5 traversal to completion, then the verdict (throws on any witness failure). */
function witness(ex: SafeReadExecutor) {
  do ex.run('G-R5', { page: String(ex.witness.expectedPage()) })
  while (!ex.witness.isComplete())
  return ex.finalizeRepositoryWitness()
}

function l7(ex: SafeReadExecutor, projectId: string, teamId = TEAM): { record?: EvidenceRecord; error?: unknown } {
  try { return { record: ex.run('V-R2.L7', { teamId, projectId }) } } catch (error) { return { error } }
}

function expectCertifiedStop(r: { record?: EvidenceRecord; error?: unknown }, detector = 'OPAQUE_HIGH_ENTROPY') {
  expect(r.record).toBeUndefined()
  expect(r.error).toBeInstanceOf(SecretDetectedRefusal)
  expect((r.error as SecretDetectedRefusal).token).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
  expect((r.error as SecretDetectedRefusal).diagnostics.map((d) => d.detector_id)).toContain(detector)
}

describe('synthetic values', () => {
  it('REPO_A / REPO_B / case-flipped are grammar-valid and trip OPAQUE_HIGH_ENTROPY only', () => {
    for (const v of [REPO_A, REPO_B, caseFlipped(REPO_A)]) {
      expect(GITHUB_REPOSITORY_NAME_RE.test(v)).toBe(true)
      expect(scanText(v).map((f) => f.detector)).toEqual(['OPAQUE_HIGH_ENTROPY'])
    }
    expect(caseFlipped(REPO_A)).not.toBe(REPO_A)
    expect(caseFlipped(REPO_A).toLowerCase()).toBe(REPO_A.toLowerCase())
    expect(REPO_A).not.toBe(REPO_B)
  })
})

describe('1 / 12. POSITIVE: same project, same run, exact value, only entropy -> adjudicated', () => {
  it('the L7 record is validated evidence carrying its ONE adjudication, bound to the same team + project', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A, REPO_A) } })
    witness(ex)
    const { record, error } = l7(ex, PRJ_A)
    expect(error).toBeUndefined()
    expect(isValidatedEvidence(record)).toBe(true)
    expect(record!.scanner_adjudications).toEqual([{
      normalized_schema_path: 'deployments[*].meta.githubRepo', team_id: TEAM, project_id: PRJ_A,
      detector_id: 'OPAQUE_HIGH_ENTROPY', classification: 'EXPECTED_PROVIDER_IDENTIFIER', basis: DEPLOYMENT_REPO_ADJUDICATION_BASIS,
      source_op_id: 'V-R2.S2', source_normalized_schema_path: 'projects[*].link.repo', source_basis: 'SAME_RUN_AUTHENTICATED_REPOSITORY_INVENTORY_ID_MATCH',
      same_run_witness_op_id: 'G-R5', exact_equality: true, owner_corroboration: OWNER_CORROBORATION_UNAVAILABLE,
    }])
    expect(ex.isWitnessedLinkRepoFor(TEAM, PRJ_A, REPO_A)).toBe(true)
  })
  it('the adjudication carries no provider value (only ids and fixed tokens)', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    witness(ex)
    const { record } = l7(ex, PRJ_A)
    expect(JSON.stringify(record!.scanner_adjudications)).not.toContain(REPO_A)
  })
  it('a page with no finding carries no adjudication (ordinary evidence)', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf('uellix-production-web') } })
    witness(ex)
    const { record } = l7(ex, PRJ_A)
    expect(isValidatedEvidence(record)).toBe(true)
    expect(record!.scanner_adjudications).toEqual([])
  })
})

describe('2 / 5. EXACT equality only, no normalization of any kind', () => {
  const variants: [string, () => string][] = [
    ['case-changed value', () => caseFlipped(REPO_A)],
    ['a different grammar-valid repo name of the same shape', () => REPO_B],
    ['trailing space (trim)', () => `${REPO_A} `],
    ['owner-prefixed form (owner stripping)', () => `${OWNER}/${REPO_A}`],
    ['.git suffix', () => `${REPO_A}.git`],
    ['URL form', () => `https://github.com/${OWNER}/${REPO_A}`],
    ['a superstring', () => `${REPO_A}x`],
  ]
  for (const [name, v] of variants) {
    it(`STOP: ${name}`, () => {
      const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(v()) } })
      witness(ex)
      const r = l7(ex, PRJ_A)
      expect(r.error).toBeInstanceOf(SecretDetectedRefusal)
      expect((r.error as Refusal).token).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
    })
  }
  // A LONGER witnessed name, so that a shorter / normalizable variant still trips the detector.
  const LONG = `${REPO_A}-Ab3Cd`
  const longWorld = (value: string) => primed({
    projects: [linked(PRJ_A, LONG, ID_A)], inventory: [inventoryItem(ID_A, LONG)],
    deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(value) },
  })
  it('the longer witnessed name is itself adjudicated exactly (positive control)', () => {
    const { ex } = longWorld(LONG)
    witness(ex)
    expect(isValidatedEvidence(l7(ex, PRJ_A).record)).toBe(true)
  })
  it('STOP: a strict prefix of the witnessed name (substring match)', () => {
    const { ex } = longWorld(REPO_A)
    witness(ex)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('STOP: a Unicode compatibility form that NFKC-normalizes to the witnessed name', () => {
    const fullwidthLast = LONG.slice(0, -1) + String.fromCharCode(LONG.charCodeAt(LONG.length - 1) + 0xfee0)
    expect(fullwidthLast.normalize('NFKC')).toBe(LONG)
    const { ex } = longWorld(fullwidthLast)
    witness(ex)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('a value below every detector threshold is ordinary evidence: there is nothing to adjudicate', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A.slice(0, -1)) } })
    witness(ex)
    const { record } = l7(ex, PRJ_A)
    expect(isValidatedEvidence(record)).toBe(true)
    expect(record!.scanner_adjudications).toEqual([])
  })

  it('STOP when only ONE deployment of the page differs (every finding must be explained)', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A, caseFlipped(REPO_A), REPO_A) } })
    witness(ex)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
})

describe('3. SAME PROJECT binding: cross-project substitution STOPs', () => {
  it('project B deployment carrying project A\'s adjudicated repo (B never adjudicated) -> STOP', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_B)]: deploymentsOf(REPO_A) } })
    witness(ex)
    expect(ex.isWitnessedLinkRepoFor(TEAM, PRJ_A, REPO_A)).toBe(true)
    expectCertifiedStop(l7(ex, PRJ_B))
  })
  it('A and B both adjudicated with different repos; B\'s deployment carries A\'s repo -> STOP', () => {
    const { ex } = primed({
      projects: [linked(PRJ_A, REPO_A, ID_A), linked(PRJ_B, REPO_B, ID_B)],
      inventory: [inventoryItem(ID_A, REPO_A), inventoryItem(ID_B, REPO_B)],
      deployments: { [l7Endpoint(PRJ_B)]: deploymentsOf(REPO_A), [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) },
    })
    witness(ex)
    expectCertifiedStop(l7(ex, PRJ_B))
    // ...while A's own deployments are adjudicated in the same run (positive control).
    expect(isValidatedEvidence(l7(ex, PRJ_A).record)).toBe(true)
  })
  it('same projectId under ANOTHER team/scope that never adjudicated it -> STOP (scope is part of the binding)', () => {
    const { ex } = primed({
      team2Projects: [{ id: PRJ_A }],
      deployments: { [l7Endpoint(PRJ_A, TEAM2)]: deploymentsOf(REPO_A) },
    })
    witness(ex)
    expect(ex.isWitnessedLinkRepoFor(TEAM, PRJ_A, REPO_A)).toBe(true)
    expect(ex.isWitnessedLinkRepoFor(TEAM2, PRJ_A, REPO_A)).toBe(false)
    expectCertifiedStop(l7(ex, PRJ_A, TEAM2))
  })
})

describe('4. SAME RUN only: historical witness is insufficient', () => {
  it('a previous executor adjudicated the project; a NEW executor (new run) without its own witness STOPs', () => {
    const first = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    witness(first.ex)
    expect(isValidatedEvidence(l7(first.ex, PRJ_A).record)).toBe(true)
    // New run: S2 lists project A WITHOUT an entropy link, so no witness is due in this run.
    const second = primed({ projects: [{ id: PRJ_A }, { id: PRJ_B }], deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    expect(second.ex.hasPendingAdjudications()).toBe(false)
    expect(second.ex.isWitnessedLinkRepoFor(TEAM, PRJ_A, REPO_A)).toBe(false)
    expectCertifiedStop(l7(second.ex, PRJ_A))
  })
  it('the binding cannot be injected: the executor exposes no setter, only the witness finalization fills it', () => {
    const { ex } = primed({})
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(ex))
    expect(proto.filter((n) => /witnessed|adjudicat/i.test(n)).sort()).toEqual(['bindWitnessedLinkRepo', 'hasPendingAdjudications', 'isAdjudicatedValue', 'isWitnessedLinkRepoFor'].sort())
  })
})

describe('5 / 9 / 10 / 11. no same-run adjudicated V-R2.S2 source -> STOP', () => {
  it('5. same project, no prior V-R2.S2 adjudication (its link.repo is an ordinary name)', () => {
    const { ex } = primed({ projects: [linked(PRJ_A, 'uellix-production-web', ID_A)], deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    expect(ex.hasPendingAdjudications()).toBe(false)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('9. same-run V-R2.S2 unresolved: deferred, witness not finalized', () => {
    const { ex, s2 } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    expect(isValidatedEvidence(s2)).toBe(false)
    expect(ex.hasPendingAdjudications()).toBe(true)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('9b. unresolved even after the traversal completed but before the verdict', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    do ex.run('G-R5', { page: String(ex.witness.expectedPage()) })
    while (!ex.witness.isComplete())
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('10. zero G-R5 witness: the verdict STOPs and L7 stays unexplained', () => {
    const { ex } = primed({ inventory: [inventoryItem(1234, 'something-else')], deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    expect(token(() => witness(ex))).toBe('STOP_WITNESS_ZERO_MATCH')
    expect(ex.isWitnessedLinkRepoFor(TEAM, PRJ_A, REPO_A)).toBe(false)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('11. duplicate / ambiguous G-R5 witness: the verdict STOPs and L7 stays unexplained', () => {
    const { ex } = primed({ inventory: [inventoryItem(ID_A, REPO_A), inventoryItem(ID_A, REPO_A)], deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    expect(token(() => witness(ex))).toBe('STOP_WITNESS_MULTIPLE_MATCH')
    expect(ex.isWitnessedLinkRepoFor(TEAM, PRJ_A, REPO_A)).toBe(false)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
  it('11b. witness name mismatch: the verdict STOPs and L7 stays unexplained', () => {
    const { ex } = primed({ inventory: [inventoryItem(ID_A, REPO_B)], deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    expect(token(() => witness(ex))).toBe('STOP_WITNESS_NAME_MISMATCH')
    expectCertifiedStop(l7(ex, PRJ_A))
  })
})

describe('6 / 7 / 8. grammar and other detectors STOP (mixed detector values are never adjudicated)', () => {
  const cases: [string, () => string, string][] = [
    ['6. grammar-invalid (entropy only)', () => `${REPO_A}!`, 'OPAQUE_HIGH_ENTROPY'],
    ['7. PRIVATE_KEY + entropy', () => `${pem()}${REPO_A}`, 'PRIVATE_KEY_BLOCK'],
    ['8. GITHUB_TOKEN_FAMILY + entropy (grammar-valid!)', ghp, 'GITHUB_TOKEN_FAMILY'],
    ['8. URL userinfo + entropy', () => ['https://', 'x', '@h/', REPO_A].join(''), 'URL_USERINFO'],
    ['8. ENV_ASSIGNMENT_SECRET + entropy', () => ['GH_', 'TOKEN=', REPO_A].join(''), 'ENV_ASSIGNMENT_SECRET'],
  ]
  for (const [name, value, detector] of cases) {
    it(`STOP: ${name}`, () => {
      const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(value()) } })
      witness(ex)
      expectCertifiedStop(l7(ex, PRJ_A), detector)
    })
  }
  it('the witnessed value at ANOTHER L7 leaf (deployments[*].name) is not explained', () => {
    const page = json({ deployments: [{ uid: 'dpl_0', name: REPO_A, target: 'production', meta: { githubRepo: REPO_A } }], pagination: { count: 1, next: null } })
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: page } })
    witness(ex)
    expectCertifiedStop(l7(ex, PRJ_A))
  })
})

describe('each layer of the L7 predicate is independently load-bearing (defense in depth)', () => {
  const at = (detector: string, value: unknown, generic = 'deployments[].meta.githubRepo') => ({ detector, generic, value })
  it('positive: every finding entropy, at the leaf, grammar-valid, exact', () => {
    expect(deploymentRepoFindingsExplained([at('OPAQUE_HIGH_ENTROPY', REPO_A), at('OPAQUE_HIGH_ENTROPY', REPO_A)], REPO_A)).toBe(true)
  })
  it('an empty finding set explains nothing', () => {
    expect(deploymentRepoFindingsExplained([], REPO_A)).toBe(false)
  })
  it('path layer: the witnessed value at another path', () => {
    expect(deploymentRepoFindingsExplained([at('OPAQUE_HIGH_ENTROPY', REPO_A, 'deployments[].name')], REPO_A)).toBe(false)
  })
  it('detector layer: a non-entropy finding located at the leaf, even on the exact witnessed value', () => {
    expect(deploymentRepoFindingsExplained([at('GITHUB_TOKEN_FAMILY', REPO_A)], REPO_A)).toBe(false)
  })
  it('grammar layer: even if the bound value were outside the grammar', () => {
    const bad = `${REPO_A}!`
    expect(scanText(bad).map((f) => f.detector)).toEqual(['OPAQUE_HIGH_ENTROPY'])
    expect(deploymentRepoFindingsExplained([at('OPAQUE_HIGH_ENTROPY', bad)], bad)).toBe(false)
  })
  it('value-detector layer: even if the bound value itself tripped another detector', () => {
    const mixed = ghp()
    expect(GITHUB_REPOSITORY_NAME_RE.test(mixed)).toBe(true)
    expect(deploymentRepoFindingsExplained([at('OPAQUE_HIGH_ENTROPY', mixed)], mixed)).toBe(false)
  })
  it('equality layer: exact only', () => {
    expect(deploymentRepoFindingsExplained([at('OPAQUE_HIGH_ENTROPY', caseFlipped(REPO_A))], REPO_A)).toBe(false)
    expect(deploymentRepoFindingsExplained([at('OPAQUE_HIGH_ENTROPY', REPO_B)], REPO_A)).toBe(false)
  })
})

describe('the exception is NOT global', () => {
  it('no other op can carry an L7 adjudication, and an L7 adjudication in any other form is refused', () => {
    const { ex } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(REPO_A) } })
    witness(ex)
    const good = l7(ex, PRJ_A).record!
    expect(() => assertEnvelopeConforms(good)).not.toThrow()
    const adj = good.scanner_adjudications[0]
    const variants: Record<string, unknown>[] = [
      { ...good, op_id: 'V-R2.L5' },
      { ...good, op_id: 'V-R2.S2' },
      { ...good, scanner_adjudications: [adj, adj] },
      { ...good, scanner_adjudications: [{ ...adj, project_id: PRJ_B }] }, // not the record's own request scope
      { ...good, scanner_adjudications: [{ ...adj, team_id: TEAM2 }] },
      { ...good, scanner_adjudications: [{ ...adj, exact_equality: false }] },
      { ...good, scanner_adjudications: [{ ...adj, same_run_witness_op_id: 'HISTORICAL' }] },
      { ...good, scanner_adjudications: [{ ...adj, owner_corroboration: 'CORROBORATED' }] },
      { ...good, scanner_adjudications: [{ ...adj, value: REPO_A }] },
    ]
    for (const v of variants) expect(token(() => assertEnvelopeConforms(v))).toBe('STOP_ENVELOPE_NONCONFORMANT')
  })
  it('V-R4.DEPLOYMENTS (same meta field, F_IMMEDIATE) is still refused in this phase', () => {
    const { ex } = primed({})
    witness(ex)
    expect(token(() => ex.run('V-R4.DEPLOYMENTS', { teamId: TEAM, projectId: PRJ_A }))).toBe('STOP_FRESHNESS_CLASS_NOT_EXECUTABLE_IN_THIS_PHASE')
  })
})

// ------------------------------------------------------------- EC-1 evidence re-scan

describe('EC-1 evidence re-scan distinguishes and binds the L7 adjudication', () => {
  function bundleFiles(l7Value = REPO_A, over: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r) {
    const { ex, s2 } = primed({ deployments: { [l7Endpoint(PRJ_A)]: deploymentsOf(l7Value) } })
    const { replacements, witnessRecord } = witness(ex)
    const s2r = replacements.get(s2)!
    const l7r = l7(ex, PRJ_A).record!
    const dir = mkdtempSync(path.join(tmpdir(), 'l7-ec1-'))
    const files = [['000_V-R2.S2.json', s2r], ['001_G-R5.json', witnessRecord], ['002_V-R2.L7.json', over(l7r as unknown as Record<string, unknown>)]].map(([n, r]) => {
      const f = path.join(dir, n as string)
      writeFileSync(f, `${JSON.stringify(r, null, 1)}\n`)
      return f
    })
    return { ex, files, l7r }
  }
  it('in-run: every finding explained, the L7 entropy findings included', () => {
    const { ex, files } = bundleFiles()
    const rep = scanEvidenceFiles(files, (v) => ex.isAdjudicatedValue(v), (t, p, v) => ex.isWitnessedLinkRepoFor(t, p, v))
    expect(rep.unexplained).toEqual([])
    expect(rep.adjudicatedExplained).toBe(4) // S2 serialized + decoded, L7 serialized + decoded
  })
  it('standalone (pre-commit): the bundle\'s own V-R2.S2 binding explains it', () => {
    const { files } = bundleFiles()
    expect(scanEvidenceFiles(files, () => true, () => true).unexplained).toEqual([])
  })
  it('the caller lookup alone is not enough: without the bundle\'s V-R2.S2 record the L7 finding is unexplained', () => {
    const { ex, files } = bundleFiles()
    const rep = scanEvidenceFiles(files.slice(1), (v) => ex.isAdjudicatedValue(v), () => true)
    expect(rep.unexplained.map((f) => f.detector)).toEqual(['OPAQUE_HIGH_ENTROPY', 'OPAQUE_HIGH_ENTROPY'])
  })
  it('the bundle alone is not enough in-run: a caller lookup that does not bind the value leaves it unexplained', () => {
    const { ex, files } = bundleFiles()
    const rep = scanEvidenceFiles(files, (v) => ex.isAdjudicatedValue(v), () => false)
    expect(rep.unexplained.map((f) => `${f.level}:${f.detector}`)).toEqual(['SERIALIZED:OPAQUE_HIGH_ENTROPY', 'DECODED:OPAQUE_HIGH_ENTROPY'])
  })
  it('a forged L7 adjudication naming another project than the record\'s own request is unexplained', () => {
    const { files } = bundleFiles(REPO_A, (r) => ({ ...r, scanner_adjudications: [{ ...(r.scanner_adjudications as Record<string, unknown>[])[0], project_id: PRJ_B }] }))
    expect(scanEvidenceFiles(files, () => true, () => true).unexplained.length).toBe(2)
  })
  it('an L7 record whose OWN request was for another project cannot borrow a bound project\'s adjudication', () => {
    // The adjudication names PRJ_A (bound by the bundle), but the record's request scope is PRJ_B.
    const { files } = bundleFiles(REPO_A, (r) => ({ ...r, operation: { ...(r.operation as Record<string, unknown>), endpoint: l7Endpoint(PRJ_B) } }))
    expect(scanEvidenceFiles(files, () => true, () => true).unexplained.length).toBe(2)
  })
  it('an L7 record without its adjudication marker is unexplained', () => {
    const { files } = bundleFiles(REPO_A, (r) => ({ ...r, scanner_adjudications: [] }))
    expect(scanEvidenceFiles(files, () => true, () => true).unexplained.length).toBe(2)
  })
  const record = (value: string) => JSON.stringify({
    op_id: 'V-R2.L7', operation: { tool: 'vercel', method: 'GET', endpoint: l7Endpoint(PRJ_A) },
    projection: { deployments: [{ uid: 'dpl_0', meta: { githubRepo: value } }] },
    scanner_adjudications: [{
      normalized_schema_path: 'deployments[*].meta.githubRepo', team_id: TEAM, project_id: PRJ_A, detector_id: 'OPAQUE_HIGH_ENTROPY',
      classification: 'EXPECTED_PROVIDER_IDENTIFIER', basis: DEPLOYMENT_REPO_ADJUDICATION_BASIS, source_op_id: 'V-R2.S2',
      source_normalized_schema_path: 'projects[*].link.repo', source_basis: 'SAME_RUN_AUTHENTICATED_REPOSITORY_INVENTORY_ID_MATCH',
      same_run_witness_op_id: 'G-R5', exact_equality: true, owner_corroboration: OWNER_CORROBORATION_UNAVAILABLE,
    }],
  }, null, 1)
  it('record-level: explained only for the value bound to the SAME team + project', () => {
    expect(scanEvidenceText(record(REPO_A), 'f', () => false, (t, p, v) => t === TEAM && p === PRJ_A && v === REPO_A).unexplained).toEqual([])
    expect(scanEvidenceText(record(REPO_A), 'f', () => false, (t, p, v) => t === TEAM && p === PRJ_B && v === REPO_A).unexplained.length).toBe(2)
    expect(scanEvidenceText(record(REPO_A), 'f', () => false).unexplained.length).toBe(2) // default: no binding
  })
  it('record-level grammar layer: an entropy-only value outside the grammar is never explained', () => {
    expect(scanEvidenceText(record(`${REPO_A}!`), 'f', () => false, () => true).unexplained.length).toBeGreaterThan(0)
  })
  it('record-level detector layer: a mixed value is not adjudicated AT ALL (0 explained)', () => {
    const r = scanEvidenceText(record(ghp()), 'f', () => false, () => true)
    expect(r.adjudicatedExplained).toBe(0)
    expect(r.unexplained.map((f) => f.detector)).toContain('GITHUB_TOKEN_FAMILY')
    expect(r.unexplained.map((f) => f.detector)).toContain('OPAQUE_HIGH_ENTROPY')
  })
  it('the bundle lookup refuses a project bound to two different values (ambiguous source)', () => {
    const s2 = (repo: string) => ({
      op_id: 'V-R2.S2', operation: { endpoint: `/v9/projects?teamId=${TEAM}&limit=100` },
      projection: { projects: [{ id: PRJ_A, link: { repo } }] },
      scanner_adjudications: [{ normalized_schema_path: 'projects[*].link.repo', project_id: PRJ_A, detector_id: 'OPAQUE_HIGH_ENTROPY', classification: 'EXPECTED_PROVIDER_IDENTIFIER' }],
    })
    expect(bundleSameProjectLookup([s2(REPO_A)])(TEAM, PRJ_A, REPO_A)).toBe(true)
    expect(bundleSameProjectLookup([s2(REPO_A)])(TEAM2, PRJ_A, REPO_A)).toBe(false)
    expect(bundleSameProjectLookup([s2(REPO_A), s2(REPO_B)])(TEAM, PRJ_A, REPO_A)).toBe(false)
  })
})
