// @vitest-environment node
// tests/infra-read/safe-read-executor.test.ts
//
// Safe-read executor: closed registry, exact-shape method guards, in-process
// projection, ordering (G-R1 first / RC-9b), RNA-1, freshness classes, and the
// terminating DN-0 protocol. NO NETWORK: every provider call goes to a fake
// runner. Every refusal test is paired with proof that the same fake runner IS
// installed and reachable, so a "never called" assertion is not vacuous.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'
import path from 'node:path'
import {
  CTX, PRJ_AG, PRJ_PW, SHA_A, SHA_B, TEAM, X_R1_URL, antigravityProject, fakeDeployHookUrl, fakeRunner, repoShaped, world,
} from './fixtures'
import type { Invocation, ToolContext } from '../../scripts/infra-read/guards'

const h = vi.hoisted(() => ({
  mutate: undefined as undefined | ((inv: Invocation) => Invocation),
  bypassProjection: false,
}))

vi.mock('../../scripts/infra-read/guards', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../scripts/infra-read/guards')>()
  return {
    ...orig,
    buildInvocation: (...a: Parameters<typeof orig.buildInvocation>) => {
      const inv = orig.buildInvocation(...a)
      return h.mutate ? h.mutate(inv) : inv
    },
    project: (...a: Parameters<typeof orig.project>) =>
      h.bypassProjection ? { projection: a[1], absent: [] } : orig.project(...a),
  }
})

const { SafeReadExecutor, isValidatedEvidence } = await import('../../scripts/infra-read/executor')
const { Refusal, getOp } = await import('../../scripts/infra-read/ops')
const { assertInvocationSafe, project } = await import('../../scripts/infra-read/guards')
const { createXcc1Context, buildXcc1Env } = await import('../../scripts/infra-read/xcc1')
const protocol = await import('../../scripts/infra-read/protocol')
const { scanText } = await import('../../scripts/infra-read/evidence-scan')

const xctx = createXcc1Context()
const ctx: ToolContext = { ...CTX, xcc1Env: buildXcc1Env(xctx, process.env), xcc1Cwd: xctx.cwd }
afterAll(() => rmSync(xctx.root, { recursive: true, force: true }))

beforeEach(() => { h.mutate = undefined; h.bypassProjection = false })

function refusalToken(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

/** Drive an executor to the point where GitHub G-R2 / Vercel role-limb ops are legitimately reachable. */
function primed(runner = fakeRunner()) {
  const ex = new SafeReadExecutor(runner, ctx)
  ex.run('G-R1')
  ex.run('G-R3')
  ex.run('V-R2.S1')
  ex.run('V-R2.S2', { teamId: TEAM })
  return { ex, runner }
}

describe('closed registry', () => {
  it('POSITIVE CONTROL: a registry op reaches the runner with the exact GET shape', () => {
    const runner = fakeRunner()
    const ex = new SafeReadExecutor(runner, ctx)
    const rec = ex.run('G-R1')
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].argv).toEqual(['api', '--method', 'GET', '/repos/lorenzozanello/uellix-antigravity'])
    expect(isValidatedEvidence(rec)).toBe(true)
  })

  it('refuses an operation that is not in the registry, before any runner call', () => {
    const runner = fakeRunner()
    const ex = new SafeReadExecutor(runner, ctx)
    for (const id of ['G-R9', 'V-R2.DELETE', 'deleteProject', 'M-8']) {
      expect(refusalToken(() => ex.run(id))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
    }
    expect(runner.calls).toHaveLength(0)
  })

  it('refuses an ARBITRARY ENDPOINT even inside a registry op (builder mutated to another path)', () => {
    const runner = fakeRunner()
    h.mutate = (inv) => ({ ...inv, endpoint: '/repos/lorenzozanello/other-repo', argv: ['api', '--method', 'GET', '/repos/lorenzozanello/other-repo'] })
    expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('G-R1'))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
    expect(runner.calls).toHaveLength(0)
  })
})

describe('GitHub method guard (mutants must never reach execution)', () => {
  const GH = '/repos/lorenzozanello/uellix-antigravity'
  const cases: [string, string[]][] = [
    ['implicit POST via -f', ['api', GH, '-f', 'name=x']],
    ['implicit POST via --raw-field', ['api', '--method', 'GET', GH, '--raw-field', 'a=b']],
    ['typed field -F', ['api', '--method', 'GET', GH, '-F', 'a=1']],
    ['--field long form', ['api', '--method', 'GET', GH, '--field=a=1']],
    ['explicit POST via --method', ['api', '--method', 'POST', GH]],
    ['explicit POST via -X', ['api', '-X', 'POST', GH]],
    ['--method=DELETE inline', ['api', '--method=DELETE', GH]],
    ['--input body file', ['api', '--method', 'GET', GH, '--input', 'body.json']],
    ['missing --method (relies on gh default)', ['api', GH]],
    ['--verbose transport echo', ['api', '--method', 'GET', GH, '--verbose']],
    ['-i response headers', ['api', '--method', 'GET', GH, '-i']],
    ['-H custom header', ['api', '--method', 'GET', GH, '-H', 'Accept: x']],
    ['--hostname redirect', ['api', '--method', 'GET', GH, '--hostname', 'evil.example']],
  ]
  for (const [name, argv] of cases) {
    it(`REFUSED: ${name}`, () => {
      const runner = fakeRunner()
      h.mutate = (inv) => ({ ...inv, argv })
      const tok = refusalToken(() => new SafeReadExecutor(runner, ctx).run('G-R1'))
      expect(['STOP_GH_NON_GET_OR_BODY_FORM', 'STOP_READ_AUTHORITY_EXCEEDED']).toContain(tok)
      expect(runner.calls).toHaveLength(0)
    })
  }
  it('REFUSED: gh auth status --show-token (secret-revealing PACMI mode)', () => {
    const runner = fakeRunner()
    h.mutate = (inv) => ({ ...inv, argv: ['auth', 'status', '--show-token'] })
    expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('PACMI-G1'))).toBe('STOP_GH_NON_GET_OR_BODY_FORM')
    expect(runner.calls).toHaveLength(0)
  })
  for (const name of ['GH_TOKEN', 'Gh_Token', 'gh_token', 'GITHUB_TOKEN', 'Github_Token', 'GH_ENTERPRISE_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
    it(`REFUSED: a credential-shaped variable in the gh environment (${name}; Windows names are case-insensitive)`, () => {
      const runner = fakeRunner()
      h.mutate = (inv) => ({ ...inv, env: { ...inv.env, [name]: 'x' } })
      expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('G-R1'))).toBe('STOP_CREDENTIAL_OVERRIDE_IN_ENV')
      expect(runner.calls).toHaveLength(0)
    })
  }
  for (const name of ['GH_CONFIG_DIR', 'Gh_Config_Dir', 'GH_HOST', 'NODE_OPTIONS', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'HTTP_PROXY', 'XDG_CONFIG_HOME']) {
    it(`REFUSED: ${name} is outside the constructed gh environment`, () => {
      const runner = fakeRunner()
      h.mutate = (inv) => ({ ...inv, env: { ...inv.env, [name]: 'x' } })
      expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('G-R1'))).toBe('STOP_ENV_NOT_ALLOWLISTED')
      expect(runner.calls).toHaveLength(0)
    })
  }
  it('REFUSED: two case variants of one allowed name in the gh environment', () => {
    const runner = fakeRunner()
    h.mutate = (inv) => ({ ...inv, env: { ...inv.env, PATH: 'a', Path: 'b' } })
    expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('G-R1'))).toBe('STOP_ENV_AMBIGUOUS')
    expect(runner.calls).toHaveLength(0)
  })
})

describe('Vercel method guard (flag semantics differ from gh)', () => {
  const EP = `/v9/projects/uellix-antigravity?teamId=${TEAM}`
  const V = CTX.vercelEntry
  const cases: [string, string[], string][] = [
    ['-f body semantics (GET + -f sends a JSON BODY)', [V, 'api', EP, '--method', 'GET', '--raw', '-f', 'teamId=x'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--raw-field', [V, 'api', EP, '--method', 'GET', '--raw', '--raw-field', 'a=b'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['-F typed field', [V, 'api', EP, '--method', 'GET', '--raw', '-F', 'a=1'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--input body', [V, 'api', EP, '--method', 'GET', '--raw', '--input', '-'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--method DELETE', [V, 'api', EP, '--method', 'DELETE', '--raw'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['-X PATCH', [V, 'api', EP, '-X', 'PATCH', '--raw'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--generate=curl (emits a request template, not a read; v1.0.5 erratum: the template carries a <TOKEN> placeholder)', [V, 'api', EP, '--method', 'GET', '--generate=curl'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--verbose (full request/response)', [V, 'api', EP, '--method', 'GET', '--raw', '--verbose'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--dangerously-skip-permissions', [V, 'api', EP, '--method', 'GET', '--dangerously-skip-permissions'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['--scope context override (DF-12)', [V, 'api', EP, '--method', 'GET', '--raw', '--scope', 'other'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
    ['no explicit --method', [V, 'api', EP, '--raw'], 'STOP_VERCEL_NON_GET_OR_BODY_FORM'],
  ]
  for (const [name, argv, token] of cases) {
    it(`REFUSED: ${name}`, () => {
      const { ex, runner } = primed()
      const before = runner.calls.length
      h.mutate = (inv) => ({ ...inv, argv })
      expect(refusalToken(() => ex.run('V-R1', { teamId: TEAM }))).toBe(token)
      expect(runner.calls.length).toBe(before)
    })
  }
  for (const name of ['VERCEL_TOKEN', 'Vercel_Token', 'vercel_token', 'VERCEL_AUTH_TOKEN', 'NOW_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
    it(`REFUSED: a credential-shaped variable in the vercel environment (${name})`, () => {
      const { ex, runner } = primed()
      const before = runner.calls.length
      h.mutate = (inv) => ({ ...inv, env: { ...inv.env, [name]: 'x' } })
      expect(refusalToken(() => ex.run('V-R1', { teamId: TEAM }))).toBe('STOP_CREDENTIAL_OVERRIDE_IN_ENV')
      expect(runner.calls.length).toBe(before)
    })
  }
  for (const name of ['VERCEL_ORG_ID', 'Vercel_Project_Id', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS']) {
    it(`REFUSED: ${name} is outside the constructed vercel environment`, () => {
      const { ex, runner } = primed()
      const before = runner.calls.length
      h.mutate = (inv) => ({ ...inv, env: { ...inv.env, [name]: 'x' } })
      expect(refusalToken(() => ex.run('V-R1', { teamId: TEAM }))).toBe('STOP_ENV_NOT_ALLOWLISTED')
      expect(runner.calls.length).toBe(before)
    })
  }
  it('REFUSED: a write OPERATION ID instead of a registry path', () => {
    const { ex, runner } = primed()
    const before = runner.calls.length
    h.mutate = (inv) => ({ ...inv, endpoint: 'deleteProject', argv: [V, 'api', 'deleteProject', '--method', 'GET', '--raw'] })
    expect(refusalToken(() => ex.run('V-R1', { teamId: TEAM }))).toBe('STOP_VERCEL_WRITE_OPERATION_ID')
    expect(runner.calls.length).toBe(before)
  })
  it('REFUSED: decrypt=true cannot be expressed (closed pattern)', () => {
    const { ex, runner } = primed()
    const before = runner.calls.length
    const bad = `/v10/projects/${PRJ_PW}/env?decrypt=true&teamId=${TEAM}`
    h.mutate = (inv) => ({ ...inv, endpoint: bad, argv: [V, 'api', bad, '--method', 'GET', '--raw'] })
    expect(refusalToken(() => ex.run('V-R2.L5', { teamId: TEAM, projectId: PRJ_PW }))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
    expect(runner.calls.length).toBe(before)
  })
})

describe('output projection (raw provider output never becomes evidence)', () => {
  it('V-R1 projection drops the deploy-hook URL, the password and env values; keeps presence booleans and the autodeploy locus', () => {
    const p = project(getOp('V-R1'), antigravityProject())
    const s = JSON.stringify(p.projection)
    expect(s).not.toContain(fakeDeployHookUrl())
    expect(s).not.toMatch(/"url"|"password"|"value"|latestDeployments|"env"/)
    expect((p.projection as { gitProviderOptions: { createDeployments: string } }).gitProviderOptions.createDeployments).toBe('enabled')
    expect((p.projection as { __presence: Record<string, boolean> }).__presence).toEqual({ passwordProtection: true, trustedIps: false })
    expect((p.projection as { link: { deployHooks: { id: string }[] } }).link.deployHooks[0].id).toBe('dh_1')
  })

  it('REFUSED: raw response persistence — a bypassed projector is caught by conformance', () => {
    const { ex } = primed()
    h.bypassProjection = true
    expect(refusalToken(() => ex.run('V-R1', { teamId: TEAM }))).toBe('STOP_PROJECTION_NONCONFORMANT')
    expect(isValidatedEvidence(antigravityProject())).toBe(false)
  })

  it('REFUSED: deploy-hook URL output even through an ALLOWLISTED field (second layer: detectors)', () => {
    const p = antigravityProject()
    p.link.deployHooks[0].name = fakeDeployHookUrl()
    const { ex } = primed(fakeRunner(world({ [`/v9/projects/uellix-antigravity?teamId=${TEAM}`]: { status: 0, stdout: JSON.stringify(p), stderr: '' } })))
    expect(refusalToken(() => ex.run('V-R1', { teamId: TEAM }))).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
  })

  it('env-value output: L5 drops `value`; a bypassed projector carrying it is refused', () => {
    const rec = primed().ex.run('V-R2.L5', { teamId: TEAM, projectId: PRJ_PW })
    expect(JSON.stringify(rec.projection)).not.toContain('THIS-IS-AN-ENV-VALUE')
    expect(JSON.stringify(rec.projection)).toContain('NEXT_PUBLIC_X')
    const { ex } = primed()
    h.bypassProjection = true
    expect(refusalToken(() => ex.run('V-R2.L5', { teamId: TEAM, projectId: PRJ_PW }))).toBe('STOP_PROJECTION_NONCONFORMANT')
  })

  it('PACMI-G1 drops a token field from gh output and PACMI-V3 keeps only the executor row', () => {
    const runner = fakeRunner()
    const ex = new SafeReadExecutor(runner, ctx)
    const g = ex.run('PACMI-G1')
    expect(scanText(JSON.stringify(g.projection))).toEqual([])
    expect(JSON.stringify(g.projection)).toContain('workflow')
    ex.run('PACMI-V1')
    const v3 = ex.run('PACMI-V3')
    expect(v3.projection).toEqual({ members: [{ uid: 'u1', username: 'lorenzozanello-5040', role: 'OWNER' }] })
  })
})

describe('ordering, RC-9b, scope and RNA-1', () => {
  it('REFUSED: G-R2 before G-R1', () => {
    const runner = fakeRunner()
    const ex = new SafeReadExecutor(runner, ctx)
    expect(refusalToken(() => ex.run('G-R2.WITNESS', { branch: 'main' }))).toBe('STOP_GR1_NOT_FIRST')
    expect(runner.calls).toHaveLength(0)
  })

  it('REFUSED: G-R2 after a G-R1 that returned NO permission object (RC-9b not discharged)', () => {
    const noPerms = { id: 1, full_name: 'lorenzozanello/uellix-antigravity', default_branch: 'main' }
    const runner = fakeRunner(world({ '/repos/lorenzozanello/uellix-antigravity': { status: 0, stdout: JSON.stringify(noPerms), stderr: '' } }))
    const ex = new SafeReadExecutor(runner, ctx)
    expect(ex.run('G-R1').assertions.rc9b_permission_object_captured).toBe(false)
    expect(refusalToken(() => ex.run('G-R2.WITNESS', { branch: 'main' }))).toBe('STOP_RC9B_NOT_DISCHARGED')
    expect(runner.calls).toHaveLength(1)
  })

  it('POSITIVE: after G-R1 captured permissions, G-R2 is reachable', () => {
    const { ex } = primed()
    expect(ex.run('G-R2.WITNESS', { branch: 'main' }).assertions.branch_resolves).toBe(true)
  })

  it('REFUSED: a protected-branch target that is not a governed ref', () => {
    const { ex } = primed()
    expect(refusalToken(() => ex.run('G-R2.A', { branch: 'some/other' }))).toBe('STOP_READ_AUTHORITY_EXCEEDED')
  })

  it('REFUSED: a Vercel project read before the scope set was enumerated', () => {
    const runner = fakeRunner()
    expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('V-R1', { teamId: TEAM }))).toBe('STOP_SCOPE_ENUMERATION_INCOMPLETE')
    expect(runner.calls).toHaveLength(0)
  })

  it('REFUSED (RNA-1): V-R2 role limbs never target uellix-antigravity, for every limb', () => {
    const { ex, runner } = primed()
    const before = runner.calls.length
    for (const limb of ['V-R2.L1', 'V-R2.L3', 'V-R2.L5', 'V-R2.L7']) {
      expect(refusalToken(() => ex.run(limb, { teamId: TEAM, projectId: PRJ_AG }))).toBe('STOP_RNA1_ANTIGRAVITY_EXCLUDED')
    }
    expect(runner.calls.length).toBe(before)
    expect(ex.run('V-R2.L5', { teamId: TEAM, projectId: PRJ_PW }).outcome).toBe('OK')
  })

  it('REFUSED (RNA-1): role limbs before the scope inventory is complete (boundary unverifiable)', () => {
    const runner = fakeRunner()
    const ex = new SafeReadExecutor(runner, ctx)
    ex.run('V-R2.S1')
    expect(refusalToken(() => ex.run('V-R2.L5', { teamId: TEAM, projectId: PRJ_PW }))).toBe('STOP_RNA1_BOUNDARY_UNVERIFIABLE')
  })

  it('REFUSED: V-R4 is F_IMMEDIATE_ONLY_BEFORE_MUTATION and never runs in the read-only phase', () => {
    const { ex, runner } = primed()
    const before = runner.calls.length
    expect(refusalToken(() => ex.run('V-R4.DEPLOYMENTS', { teamId: TEAM, projectId: PRJ_AG }))).toBe('STOP_FRESHNESS_CLASS_NOT_EXECUTABLE_IN_THIS_PHASE')
    expect(runner.calls.length).toBe(before)
  })

  it('every EXECUTE_NOW record states it is evidence only, never a standing prestate', () => {
    const { ex } = primed()
    expect(ex.run('V-R3', { teamId: TEAM }).prestate_validity).toBe('EVIDENCE_ONLY__NOT_A_STANDING_PRESTATE')
  })
})

describe('X-R1 invocation guard (XCC-1)', () => {
  const op = getOp('X-R1')
  const good = () => ({ opId: 'X-R1', tool: 'git' as const, file: 'git', argv: [...op.fixedArgs!], env: ctx.xcc1Env, cwd: ctx.xcc1Cwd })
  it('POSITIVE: the XCC-1 form passes the static guard', () => {
    expect(() => assertInvocationSafe(good(), op, ctx)).not.toThrow()
  })
  it('REFUSED: X-R1 without the isolation preflight immediately before it', () => {
    const runner = fakeRunner()
    expect(refusalToken(() => new SafeReadExecutor(runner, ctx).run('X-R1'))).toBe('STOP_XCC1_ISOLATION_BREACH')
    expect(runner.calls).toHaveLength(0)
  })
  const bad: [string, (i: ReturnType<typeof good>) => ReturnType<typeof good>][] = [
    ['credential helper still active (reset removed)', (i) => ({ ...i, argv: i.argv.slice(2) })],
    ['core.askPass reset removed', (i) => ({ ...i, argv: [...i.argv.slice(0, 2), ...i.argv.slice(4)] })],
    ['http.extraHeader reset removed', (i) => ({ ...i, argv: [...i.argv.slice(0, 4), ...i.argv.slice(6)] })],
    ['credential.helper reset to a helper', (i) => ({ ...i, argv: ['-c', 'credential.helper=manager', ...i.argv.slice(2)] })],
    ['terminal prompt enabled', (i) => ({ ...i, env: { ...i.env, GIT_TERMINAL_PROMPT: '1' } })],
    ['terminal prompt unset', (i) => { const e = { ...i.env }; delete e.GIT_TERMINAL_PROMPT; return { ...i, env: e } }],
    ['global config pointed outside the isolation root', (i) => ({ ...i, env: { ...i.env, GIT_CONFIG_GLOBAL: path.join(path.dirname(xctx.root), 'gitconfig') } })],
    ['userinfo without a password', (i) => ({ ...i, argv: [...i.argv.slice(0, -1), X_R1_URL.replace('https://', 'https://someone@')] })],
    ['credential-bearing URL', (i) => ({ ...i, argv: [...i.argv.slice(0, -1), X_R1_URL.replace('https://', 'https://user:pw@')] })],
    ['ssh URL', (i) => ({ ...i, argv: [...i.argv.slice(0, -1), 'git@github.com:lorenzozanello/uellix-antigravity.git'] })],
    ['http (not https)', (i) => ({ ...i, argv: [...i.argv.slice(0, -1), X_R1_URL.replace('https', 'http')] })],
    ['askpass available (GIT_ASKPASS set)', (i) => ({ ...i, env: { ...i.env, GIT_ASKPASS: '/tmp/askpass.sh' } })],
    ['askpass available (GIT_ASKPASS unset lets core.askPass/SSH_ASKPASS run)', (i) => { const e = { ...i.env }; delete e.GIT_ASKPASS; return { ...i, env: e } }],
    ['SSH_ASKPASS set', (i) => ({ ...i, env: { ...i.env, SSH_ASKPASS: '/tmp/a.sh' } })],
    ['extraHeader injected via GIT_CONFIG_PARAMETERS', (i) => ({ ...i, env: { ...i.env, GIT_CONFIG_PARAMETERS: "'http.extraheader=X'" } })],
    ['ceiling removed', (i) => { const e = { ...i.env }; delete e.GIT_CEILING_DIRECTORIES; return { ...i, env: e } }],
    ['system config re-enabled', (i) => ({ ...i, env: { ...i.env, GIT_CONFIG_NOSYSTEM: '0' } })],
    ['cwd outside the isolated root', (i) => ({ ...i, cwd: path.dirname(xctx.root) })],
  ]
  for (const [name, mut] of bad) {
    it(`REFUSED: ${name}`, () => {
      const tok = refusalToken(() => assertInvocationSafe(mut(good()), op, ctx))
      expect(tok).toBe('STOP_XCC1_CONTRACT_VIOLATION')
    })
  }
  // v1.0.5 (IC I13-I15): registry DRIFT. The op's own fixedArgs lose a reset, and the
  // invocation is built from that same op, so sameArgv agrees with it. Only the
  // independent normative contract can refuse this.
  for (const drop of ['credential.helper=', 'core.askPass=', 'http.extraHeader=']) {
    it(`REFUSED: registry drift drops ${drop} (builder and sameArgv share the oracle)`, () => {
      const i = op.fixedArgs!.indexOf(drop)
      const drifted = { ...op, fixedArgs: [...op.fixedArgs!.slice(0, i - 1), ...op.fixedArgs!.slice(i + 1)] }
      const inv = { ...good(), argv: [...drifted.fixedArgs] }
      expect(refusalToken(() => assertInvocationSafe(inv, drifted, ctx))).toBe('STOP_XCC1_CONTRACT_VIOLATION')
    })
  }
})

// ------------------------------------------------------------- protocol

const CAND = '9'.repeat(40)

/** A certification event document, shaped like the materialized ones. */
function icEvent(over: { verdict?: string; blocking?: number; candidate?: string | null; cls?: string; packageId?: string } = {}): string {
  return JSON.stringify({
    authority_class: over.cls ?? 'INDEPENDENT_CERTIFICATION_EVENT_RECORD__NOT_AN_AUTHORITY__NOT_AN_ARMING_ACT',
    package_id: over.packageId ?? 'X_IC',
    CERTIFIED_CANDIDATE: over.candidate === null ? {} : { candidate_head: over.candidate ?? CAND },
    VERDICT: { verdict: over.verdict ?? 'X_IC_PASS_WITH_NONBLOCKING_FINDINGS', blocking_findings: over.blocking ?? 0 },
  })
}

function fakeGit(opts: { moveHeadAfterReads?: number; diffSinceCandidate?: string; event?: string; residualConfig?: boolean; unsafeRemote?: boolean } = {}) {
  let head = 'c'.repeat(40)
  const calls: string[][] = []
  const envs: (Readonly<Record<string, string>> | undefined)[] = []
  let revParseHeadCount = 0
  const run = (args: readonly string[], env?: Readonly<Record<string, string>>) => {
    calls.push([...args])
    envs.push(env)
    const a = args.join(' ')
    const out = (stdout: string) => ({ status: 0, stdout, stderr: '' })
    if (a === 'status --porcelain --untracked-files=all') return out('')
    if (a === 'rev-parse --abbrev-ref HEAD') return out('codex/cv1-infra-control-plane-read-authority-r1\n')
    if (a === 'rev-parse HEAD') {
      revParseHeadCount++
      if (opts.moveHeadAfterReads !== undefined && revParseHeadCount > 2 + opts.moveHeadAfterReads) head = 'd'.repeat(40)
      return out(`${head}\n`)
    }
    if (a === 'rev-parse HEAD^{tree}') return out('e'.repeat(40))
    if (a.startsWith('merge-base --is-ancestor')) return out('')
    if (a.startsWith('diff --name-status')) return out(opts.diffSinceCandidate ?? '')
    if (a === '-c credential.helper= -c core.askPass= -c http.extraHeader= fetch origin --prune') return out('')
    if (a.startsWith('config --name-only --get-regexp ^remote')) return opts.unsafeRemote ? { status: 1, stdout: '', stderr: '' } : out('remote.origin.url\n')
    if (a.startsWith('config --name-only --get-regexp ')) return opts.residualConfig ? out('url.x.insteadof\n') : { status: 1, stdout: '', stderr: '' }
    if (a === 'rev-parse origin/integration/commercial-v1') return out(SHA_B)
    if (a === 'rev-parse origin/integration/commercial-v1^{tree}') return out('f'.repeat(40))
    if (a.startsWith('rev-parse HEAD:')) return out('1'.repeat(40))
    if (a.startsWith('show HEAD:')) return out(opts.event ?? icEvent())
    if (a === 'rev-parse HEAD^') return out(`${'c'.repeat(40)}\n`)
    return { status: 1, stdout: '', stderr: `unexpected git ${a}` }
  }
  return { run, calls, envs }
}

const dn0cfg = {
  expectedBranch: 'codex/cv1-infra-control-plane-read-authority-r1',
  certifiedCandidate: CAND,
  allowedPostCertificationAdditions: [/^docs\/ops\/release\/CV1_INFRA_[A-Z0-9_]+_IC_v[0-9.]+\.json$/],
  parentBinding: '6f747e86e0a3eb62d4db87fabe6b331cd4c4a7b2',
  integrationRef: 'origin/integration/commercial-v1',
  pins: [{ path: 'docs/a.json', blob: '1'.repeat(40) }],
  certificationEvents: [{ path: 'docs/ic.json', packageId: 'X_IC', certifiedCandidate: CAND }],
}

describe('terminating DN-0 protocol (no network, fake git)', () => {
  it('POSITIVE: RC-9a -> DN-0 last -> reads; G-R1 first, V-R4 never, antigravity never in role limbs, no commit issued', () => {
    const runner = fakeRunner()
    const git = fakeGit()
    const ex = new SafeReadExecutor(runner, ctx)
    const bundle = protocol.runGovernedReadPhase({ executor: ex, git, dn0: dn0cfg })
    const ids = bundle.records.map((r) => r.op_id)
    expect(bundle.ac1.armed_at_runtime).toBe(true)
    expect(ids.indexOf('G-R1')).toBeLessThan(ids.findIndex((i) => i.startsWith('G-R2')))
    expect(ids.some((i) => i.startsWith('V-R4'))).toBe(false)
    const governedReads = new Set(bundle.records.filter((r) => r.record_kind === 'GOVERNED_READ_EVIDENCE').map((r) => r.read_id))
    expect([...governedReads].sort()).toEqual(['G-R1', 'G-R2', 'G-R3', 'G-R4', 'V-R1', 'V-R2', 'V-R3', 'X-R1'])
    for (const c of runner.calls) if (c.endpoint?.includes('/env?') || c.endpoint?.includes('/domains?') || c.endpoint?.includes('aliases?') || c.endpoint?.includes('deployments?')) expect(c.endpoint).not.toContain(PRJ_AG)
    expect(git.calls.some((c) => c[0] === 'commit')).toBe(false)
    const firstPacmi = runner.calls.findIndex((c) => c.opId.startsWith('PACMI'))
    const fetchIdx = git.calls.findIndex((c) => c.includes('fetch'))
    expect(firstPacmi).toBe(0)
    expect(fetchIdx).toBeGreaterThan(-1)
    expect(bundle.limb_d.any_match).toBe(true)
    expect(bundle.limb_d.pattern_forms_evaluated).toContain('refs/heads/release/**')
    expect(scanText(JSON.stringify(bundle))).toEqual([])
  })

  it('REFUSED: HEAD moves after DN-0 (a commit between DN-0 and the reads)', () => {
    const runner = fakeRunner()
    const ex = new SafeReadExecutor(runner, ctx)
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: ex, git: fakeGit({ moveHeadAfterReads: 1 }), dn0: dn0cfg }))).toBe('STOP_STALE_DN0')
  })

  it('REFUSED: the effective package was MODIFIED after certification', () => {
    const ex = new SafeReadExecutor(fakeRunner(), ctx)
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: ex, git: fakeGit({ diffSinceCandidate: 'M\tscripts/infra-read/guards.ts' }), dn0: dn0cfg }))).toBe('STOP_STALE_DN0')
  })

  it('POSITIVE: a certification-event file ADDED after certification is permitted', () => {
    const ex = new SafeReadExecutor(fakeRunner(), ctx)
    const b = protocol.runGovernedReadPhase({ executor: ex, git: fakeGit({ diffSinceCandidate: 'A\tdocs/ops/release/CV1_INFRA_EXECUTOR_HARDENING_IC_v1.0.0.json' }), dn0: dn0cfg })
    expect(b.dn0.post_certification_additions).toEqual(['docs/ops/release/CV1_INFRA_EXECUTOR_HARDENING_IC_v1.0.0.json'])
  })

  it('REFUSED: a certification event whose VERDICT.verdict is a FAIL (LIMB_1)', () => {
    const ex = new SafeReadExecutor(fakeRunner(), ctx)
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: ex, git: fakeGit({ event: icEvent({ verdict: 'X_IC_FAIL', blocking: 1 }) }), dn0: dn0cfg }))).toBe('STOP_ARMING_LIMB1_UNSATISFIED')
  })

  it('REFUSED: a PASS event that certifies a DIFFERENT candidate (LIMB_1)', () => {
    const ex = new SafeReadExecutor(fakeRunner(), ctx)
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: ex, git: fakeGit({ event: icEvent({ candidate: '8'.repeat(40) }) }), dn0: dn0cfg }))).toBe('STOP_ARMING_LIMB1_UNSATISFIED')
  })

  it('DN-0 fetch is credential-free: resets on argv, no askpass/prompt in env, residual config checked FIRST', () => {
    const git = fakeGit()
    protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(fakeRunner(), ctx), git, dn0: dn0cfg })
    const i = git.calls.findIndex((c) => c.includes('fetch'))
    expect(git.calls[i]).toEqual(['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', 'fetch', 'origin', '--prune'])
    expect(git.envs[i]).toEqual({ GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
    const r = git.calls.findIndex((c) => c[0] === 'config' && c.includes('--get-regexp') && c.includes(protocol.DN0_FETCH_RESIDUAL_VECTOR_REGEX))
    const u = git.calls.findIndex((c) => c[0] === 'config' && c.includes(protocol.DN0_REMOTE_URL_KEY_REGEX))
    expect(r).toBeGreaterThan(-1)
    expect(u).toBeGreaterThan(-1)
    expect(Math.max(r, u)).toBeLessThan(i)
    // Values never enter the process: every config probe is --name-only.
    for (const c of git.calls.filter((c) => c[0] === 'config')) expect(c[1]).toBe('--name-only')
  })

  it('REFUSED: origin is not https-without-userinfo (ssh key or URL token would be presented)', () => {
    const git = fakeGit({ unsafeRemote: true })
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(fakeRunner(), ctx), git, dn0: dn0cfg }))).toBe('STOP_DN0_FETCH_CREDENTIAL_VECTOR')
    expect(git.calls.some((c) => c.includes('fetch'))).toBe(false)
  })

  it('REFUSED: an insteadOf / cookieFile key would let the DN-0 fetch carry a credential', () => {
    const git = fakeGit({ residualConfig: true })
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(fakeRunner(), ctx), git, dn0: dn0cfg }))).toBe('STOP_DN0_FETCH_CREDENTIAL_VECTOR')
    expect(git.calls.some((c) => c.includes('fetch'))).toBe(false)
  })

  it('REFUSED: runtime RC-9a measures a GitHub identity other than the executor (login or token source)', () => {
    const who = world({ 'PACMI-G1': { status: 0, stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'someone-else', tokenSource: 'keyring', scopes: 'repo', gitProtocol: 'https' }] } }), stderr: '' } })
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(fakeRunner(who), ctx), git: fakeGit(), dn0: dn0cfg }))).toBe('STOP_RC9_UNRESOLVED')
    const env = world({ 'PACMI-G1': { status: 0, stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'lorenzozanello', tokenSource: 'GH_TOKEN', scopes: 'repo', gitProtocol: 'https' }] } }), stderr: '' } })
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(fakeRunner(env), ctx), git: fakeGit(), dn0: dn0cfg }))).toBe('STOP_RC9_UNRESOLVED')
  })

  it('REFUSED: runtime RC-9a cannot establish the Vercel ROLE (DF-12: context is not substituted)', () => {
    const runner = fakeRunner(world({ 'PACMI-V3': { status: 0, stdout: JSON.stringify({ members: [] }), stderr: '' } }))
    const ex = new SafeReadExecutor(runner, ctx)
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: ex, git: fakeGit(), dn0: dn0cfg }))).toBe('STOP_RC9_UNRESOLVED')
  })

  it('evidence-commit check: parent must be the DN-0 HEAD and the commit may only ADD evidence', () => {
    const git = fakeGit({ diffSinceCandidate: 'A\tdocs/ops/release/evidence/x/000_G-R1.json' })
    expect(() => protocol.assertEvidenceCommitParent(git, 'c'.repeat(40), 'docs/ops/release/evidence/')).not.toThrow()
    expect(refusalToken(() => protocol.assertEvidenceCommitParent(git, 'd'.repeat(40), 'docs/ops/release/evidence/'))).toBe('STOP_STALE_DN0')
    const git2 = fakeGit({ diffSinceCandidate: 'M\tscripts/infra-read/ops.ts' })
    expect(refusalToken(() => protocol.assertEvidenceCommitParent(git2, 'c'.repeat(40), 'docs/ops/release/evidence/'))).toBe('STOP_STALE_DN0')
  })

  // ------------------------------------------------------------- v1.0.7 (G-R5 witness, TI-2, RC-9a scope)
  const json = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' })
  const FLAG = repoShaped(1)
  const flaggedWorld = (inventory: { id: number; name: string; owner: string }[]) => {
    const pw = { id: PRJ_PW, name: 'uellix-production-web', link: { type: 'github', repo: FLAG, org: 'lorenzozanello', repoId: 424242 } }
    const pages: Record<string, ReturnType<typeof json>> = {
      [`/v9/projects?teamId=${TEAM}&limit=100`]: json({ projects: [antigravityProject(), pw], pagination: { count: 2, next: null } }),
      '/user/repos?per_page=100&page=1': json(inventory.map((r) => ({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner } }))),
      '/user/repos?per_page=100&page=2': json([]),
    }
    return world(pages)
  }

  it('POSITIVE (v1.0.7): a deferred link.repo finding is adjudicated by G-R5 right after the V-R2 inventory and BEFORE V-R1; 9 read classes', () => {
    const runner = fakeRunner(flaggedWorld([{ id: 7, name: 'other', owner: 'lorenzozanello' }, { id: 424242, name: FLAG, owner: 'lorenzozanello' }]))
    const bundle = protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(runner, ctx), git: fakeGit(), dn0: dn0cfg })
    const classes = [...new Set(bundle.records.filter((r) => r.record_kind === 'GOVERNED_READ_EVIDENCE').map((r) => r.read_id))].sort()
    expect(classes).toEqual(['G-R1', 'G-R2', 'G-R3', 'G-R4', 'G-R5', 'V-R1', 'V-R2', 'V-R3', 'X-R1'])
    for (const r of bundle.records) expect(isValidatedEvidence(r)).toBe(true)
    const ids = runner.calls.map((c) => c.opId)
    const lastS2 = ids.lastIndexOf('V-R2.S2')
    const firstR5 = ids.indexOf('G-R5')
    expect(firstR5).toBeGreaterThan(lastS2)
    expect(ids.indexOf('V-R1')).toBeGreaterThan(ids.lastIndexOf('G-R5'))
    const s2 = bundle.records.find((r) => r.op_id === 'V-R2.S2')!
    expect(s2.scanner_adjudications.map((a) => a.classification)).toEqual(['EXPECTED_PROVIDER_IDENTIFIER'])
    expect(bundle.not_executed_by_design).toEqual(['V-R4 (F_IMMEDIATE_ONLY_BEFORE_MUTATION: bracket M-7, never in the read-only phase)'])
    // The inventory itself never becomes evidence.
    expect(JSON.stringify(bundle)).not.toContain('"other"')
  })

  it('REFUSED (v1.0.7): the same phase STOPs when the inventory does not bind the repoId (no evidence)', () => {
    const runner = fakeRunner(flaggedWorld([{ id: 7, name: 'other', owner: 'lorenzozanello' }]))
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(runner, ctx), git: fakeGit(), dn0: dn0cfg }))).toBe('STOP_WITNESS_ZERO_MATCH')
    expect(runner.calls.some((c) => c.opId === 'V-R1')).toBe(false)
  })

  it('G-R5 is NOT executed when V-R2.S2 has no deferred finding, and the bundle says so', () => {
    const runner = fakeRunner()
    const bundle = protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(runner, ctx), git: fakeGit(), dn0: dn0cfg })
    expect(runner.calls.some((c) => c.opId === 'G-R5')).toBe(false)
    expect(bundle.not_executed_by_design.some((x) => x.startsWith('G-R5 (NOT_REQUIRED'))).toBe(true)
  })

  it('REFUSED (v1.0.7 RC-9a): a credential without the `repo` scope stops before any read', () => {
    const noRepo = world({ 'PACMI-G1': json({ hosts: { 'github.com': [{ login: 'lorenzozanello', active: true, state: 'success', scopes: 'gist, read:org, workflow', tokenSource: 'keyring', host: 'github.com' }] } }) })
    const runner = fakeRunner(noRepo)
    expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(runner, ctx), git: fakeGit(), dn0: dn0cfg }))).toBe('STOP_RC9_UNRESOLVED')
    expect(runner.calls.some((c) => c.opId === 'G-R1')).toBe(false)
  })

  const ti2Cases: [string, Record<string, unknown>][] = [
    ['link.repo in owner/name form (the CM-6 reading)', { repo: 'lorenzozanello/uellix-antigravity' }],
    ['link.org not the governed owner', { org: 'someone-else' }],
    ['link.repoId not G-R1 repository id', { repoId: 2 }],
    ['link.repoId as a string', { repoId: '1' }],
    ['link.type not github', { type: 'gitlab' }],
  ]
  for (const [name, over] of ti2Cases) {
    it(`REFUSED (v1.0.7 TI-2): ${name}`, () => {
      const ag = antigravityProject() as { link: Record<string, unknown> }
      const w = world({ [`/v9/projects/uellix-antigravity?teamId=${TEAM}`]: json({ ...ag, link: { ...ag.link, ...over } }) })
      expect(refusalToken(() => protocol.runGovernedReadPhase({ executor: new SafeReadExecutor(fakeRunner(w), ctx), git: fakeGit(), dn0: dn0cfg }))).toBe('STOP_PROJECT_IDENTITY_MISMATCH')
    })
  }

  it('SHA fixtures are distinct (guards against a vacuous G-R4 provenance check)', () => {
    expect(SHA_A).not.toBe(SHA_B)
  })
})
