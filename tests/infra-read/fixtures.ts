// tests/infra-read/fixtures.ts — a fake provider world for the safe-read executor.
//
// Token-shaped and hook-shaped strings are ASSEMBLED AT RUNTIME so that no
// credential-shaped literal is ever committed to this repository.

import type { Invocation, ToolContext } from '../../scripts/infra-read/guards'
import type { RunResult } from '../../scripts/infra-read/executor'
import { X_R1_URL } from '../../scripts/infra-read/ops'

export const SHA_A = 'a'.repeat(40)
export const SHA_B = 'b'.repeat(40)
export const TEAM = 'team_ABCDEF123456'
export const PRJ_AG = 'prj_ANTIGRAV0001'
export const PRJ_PW = 'prj_PRODWEB00002'
export const fakeGithubToken = () => ['gh', 'o_', 'Q7'.repeat(18)].join('')
export const fakeDeployHookUrl = () => ['https://api.', 'vercel.com/v1/integrations/deploy/', PRJ_AG, '/Zx9Kq2'].join('')

export const CTX: ToolContext = {
  ghFile: 'gh',
  nodeFile: '/usr/bin/node',
  vercelEntry: '/opt/vercel/dist/vc.js',
  ghEnv: { PATH: '/bin', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  vercelEnv: { PATH: '/bin', NO_COLOR: '1' },
  xcc1Env: {},
  xcc1Cwd: '/tmp/xcc1-test/work',
}

const json = (v: unknown): RunResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' })
const notFound = (msg = 'Not Found'): RunResult => ({ status: 1, stdout: '{"message":"Not Found"}', stderr: `gh: ${msg} (HTTP 404)` })

export function antigravityProject() {
  return {
    id: PRJ_AG, name: 'uellix-antigravity', accountId: TEAM, createdAt: 1, updatedAt: 2,
    link: {
      // v1.0.7: link.repo is the repository NAME; the owner is link.org; repoId is G-R1's repository id.
      type: 'github', repo: 'uellix-antigravity', org: 'lorenzozanello', productionBranch: 'main', repoId: 1,
      deployHooks: [{ id: 'dh_1', name: 'hook', ref: 'main', createdAt: 3, url: fakeDeployHookUrl() }],
    },
    gitProviderOptions: { createDeployments: 'enabled' },
    passwordProtection: { deploymentType: 'preview', password: ['hun', 'ter', '2hunter2'].join('') },
    env: [{ key: 'K', value: 'plain-value-that-must-not-leak' }],
    latestDeployments: [{ uid: 'dpl_zzz' }],
  }
}

/** Provider responses keyed by endpoint (gh/vercel governed) or opId (fixed-argv ops). */
export function world(overrides: Record<string, RunResult> = {}): Record<string, RunResult> {
  const GH = '/repos/lorenzozanello/uellix-antigravity'
  const repo = {
    id: 1, node_id: 'R_1', full_name: 'lorenzozanello/uellix-antigravity', default_branch: 'feature/sprint-0-foundation',
    private: false, visibility: 'public', owner: { login: 'lorenzozanello' }, clone_url: 'https://github.com/x.git',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  }
  const branch = (name: string) => json({ name, protected: false, commit: { sha: SHA_A }, _links: { self: 'x' } })
  return {
    [GH]: json(repo),
    [`${GH}/branches/main`]: branch('main'),
    [`${GH}/branches/integration%2Fcommercial-v1`]: branch('integration/commercial-v1'),
    [`${GH}/branches/feature%2Fsprint-0-foundation`]: branch('feature/sprint-0-foundation'),
    [`${GH}/branches/main/protection`]: notFound('Branch not protected'),
    [`${GH}/branches/integration%2Fcommercial-v1/protection`]: notFound('Branch not protected'),
    [`${GH}/branches/feature%2Fsprint-0-foundation/protection`]: notFound('Branch not protected'),
    [`${GH}/rules/branches/main?per_page=100`]: json([]),
    [`${GH}/rules/branches/integration%2Fcommercial-v1?per_page=100`]: json([]),
    [`${GH}/rules/branches/feature%2Fsprint-0-foundation?per_page=100`]: json([]),
    [`${GH}/rulesets?per_page=100`]: json([[{ id: 11, name: 'r', target: 'branch', source_type: 'Repository', source: 'x', enforcement: 'active', node_id: 'n' }]]),
    [`${GH}/rulesets/11`]: json({
      id: 11, name: 'r', target: 'branch', enforcement: 'active', node_id: 'n',
      conditions: { ref_name: { include: ['refs/heads/release/**'], exclude: [] } },
      rules: [{ type: 'deletion' }], bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }],
    }),
    [`${GH}/commits/${SHA_B}/check-runs?per_page=100`]: json([{ total_count: 1, check_runs: [{ id: 1, name: 'Lint, typecheck, test, build', status: 'completed', conclusion: 'success', head_sha: SHA_B, app: { slug: 'github-actions' }, output: { text: 'job output never leaves the process' } }] }]),
    [`${GH}/commits/${SHA_B}/status`]: json({ state: 'success', sha: SHA_B, total_count: 0, statuses: [] }),
    '/v2/teams?limit=100': json({ teams: [{ id: TEAM, slug: 'lorenzozanello-5040s-projects', name: 'p', billing: { plan: 'hobby' } }], pagination: { count: 1, next: null } }),
    [`/v9/projects?teamId=${TEAM}&limit=100`]: json({ projects: [antigravityProject(), { id: PRJ_PW, name: 'uellix-production-web', link: { type: 'github', repo: 'lorenzozanello/uellix-production-web' } }], pagination: { count: 2, next: null } }),
    [`/v9/projects/uellix-production-web?teamId=${TEAM}`]: json({ id: PRJ_PW, name: 'uellix-production-web' }),
    [`/v9/projects/uellix-antigravity?teamId=${TEAM}`]: json(antigravityProject()),
    [`/v9/projects/${PRJ_PW}/domains?teamId=${TEAM}&limit=100`]: json({ domains: [{ name: 'pw.vercel.app', verified: true, createdAt: 1 }], pagination: { count: 1, next: null } }),
    [`/v4/aliases?projectId=${PRJ_PW}&teamId=${TEAM}&limit=100`]: json({ aliases: [{ uid: 'a1', alias: 'pw.vercel.app', deploymentId: 'dpl_1', projectId: PRJ_PW }], pagination: { count: 1, next: null } }),
    [`/v10/projects/${PRJ_PW}/env?decrypt=false&teamId=${TEAM}`]: json({ envs: [{ id: 'e1', key: 'NEXT_PUBLIC_X', target: ['production'], type: 'plain', value: 'THIS-IS-AN-ENV-VALUE', createdAt: 1, updatedAt: 2 }] }),
    [`/v6/deployments?projectId=${PRJ_PW}&teamId=${TEAM}&limit=100`]: json({ deployments: [{ uid: 'dpl_1', target: 'production', readyState: 'READY', source: 'git', meta: { githubCommitSha: SHA_A, githubCommitRef: 'main' } }], pagination: { count: 1, next: null } }),
    'X-R1': { status: 0, stdout: `${SHA_A}\tHEAD\n${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/integration/commercial-v1\n`, stderr: '' },
    'XCC-1.PREFLIGHT': { status: 0, stdout: 'command line:\tcredential.helper=\ncommand line:\tcore.askpass=\ncommand line:\thttp.extraheader=\n', stderr: '' },
    'PACMI-G1': json({ hosts: { 'github.com': [{ login: 'lorenzozanello', active: true, state: 'success', scopes: 'gist, read:org, repo, workflow', tokenSource: 'keyring', host: 'github.com', token: fakeGithubToken() }] } }),
    'PACMI-V1': json({ username: 'lorenzozanello-5040', email: 'owner@example.invalid' }),
    'PACMI-V2': json({ teams: [{ id: TEAM, slug: 'lorenzozanello-5040s-projects', name: 'p', current: true }] }),
    'PACMI-V3': json({ members: [{ uid: 'u1', username: 'lorenzozanello-5040', role: 'OWNER', email: 'o@example.invalid' }, { uid: 'u2', username: 'someone-else', role: 'MEMBER' }] }),
    ...overrides,
  }
}

export interface FakeRunner {
  (inv: Invocation): RunResult
  calls: Invocation[]
}

export function fakeRunner(w: Record<string, RunResult> = world()): FakeRunner {
  const calls: Invocation[] = []
  const fn = ((inv: Invocation) => {
    calls.push(inv)
    const key = inv.endpoint ?? inv.opId
    const r = w[key]
    if (!r) throw new Error(`fixture world has no response for ${key}`)
    return r
  }) as FakeRunner
  fn.calls = calls
  return fn
}

/** v1.0.7: a 40-character, GitHub-name-shaped synthetic value that OPAQUE_HIGH_ENTROPY flags. Assembled at runtime. */
export function repoShaped(seed: number): string {
  const a = 'Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu1Vw3Xy5Za7Bc9'
  const parts: string[] = []
  // Segment lengths 10 + 10 + 9 + 8 plus 3 hyphens = exactly 40 characters.
  ;[10, 10, 9, 8].forEach((len, i) => parts.push([...Array(len)].map((_, j) => a[(seed * 7 + i * 11 + j * 3) % a.length]).join('')))
  return parts.join('-')
}

export { X_R1_URL }
