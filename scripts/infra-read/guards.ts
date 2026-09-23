// scripts/infra-read/guards.ts
//
// Invocation construction and EXACT-SHAPE validation, plus in-process output
// projection. Two rules govern everything here:
//
//   1. An invocation is built from the closed registry and then compared,
//      token for token, against the only shape that op may have. It is an
//      ALLOWLIST comparison, not a denylist scan. The denylists below exist to
//      produce a precise refusal token for the forms a reviewer asked about;
//      they are not what keeps a write out.
//
//   2. Provider output is parsed in-process and reduced to the op's field
//      allowlist. The raw object never leaves this module, is never logged and
//      is never serialized "for debugging".

import path from 'node:path'
import { X_R1_URL, Refusal, type OpDef, type Params, type Tool } from './ops'
import { assertXcc1Env } from './xcc1'

export interface Invocation {
  readonly opId: string
  readonly tool: Tool
  readonly file: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  /** The provider path for gh/vercel governed reads; absent for fixed-argv ops. */
  readonly endpoint?: string
}

export interface ToolContext {
  readonly ghFile: string
  readonly nodeFile: string
  readonly vercelEntry: string
  readonly ghEnv: Readonly<Record<string, string>>
  readonly vercelEnv: Readonly<Record<string, string>>
  readonly xcc1Env: Readonly<Record<string, string>>
  readonly xcc1Cwd: string
}

// ------------------------------------------------------------- denylists

/** gh flags that carry a body, change the verb, add headers, or echo transport. */
export const GH_FORBIDDEN_FLAGS = [
  '-f', '--raw-field', '-F', '--field', '--input', '-X', '-H', '--header', '-i', '--include',
  '--verbose', '--hostname', '-q', '--jq', '-t', '--template', '--cache', '-p', '--preview',
  '--show-token', '--silent',
] as const

/**
 * vercel flags measured on CLI 54.14.2 `vercel api --help`. Note the ones that
 * differ from gh: --generate (emits a request, e.g. curl, carrying the token),
 * --dangerously-skip-permissions (skips DELETE confirmation), --spec-url.
 * Also MEASURED in the installed bundle: `--method GET` plus `-f/-F` sends the
 * fields as a JSON BODY on a GET, not as a query string.
 */
export const VERCEL_FORBIDDEN_FLAGS = [
  '-f', '--raw-field', '-F', '--field', '--input', '-X', '-H', '--header', '-i', '--include',
  '--verbose', '--generate', '--dangerously-skip-permissions', '--spec-url', '--refresh', '--silent',
  '--paginate', '-d', '--debug', '-t', '--token', '-S', '--scope', '--cwd', '-Q', '--global-config',
  '-A', '--local-config',
] as const

function flagHit(token: string, flags: readonly string[]): string | undefined {
  for (const f of flags) {
    if (token === f || token.startsWith(`${f}=`)) return f
    if (!f.startsWith('--') && token.startsWith(f) && token.length > f.length) return f
  }
  return undefined
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

const GH_ENV_FORBIDDEN = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG', 'GH_HOST']
const VERCEL_ENV_FORBIDDEN = ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'DEBUG']

/** Environment for gh: inherit, then remove credential overrides so the keyring identity measured by RC-9a is the one used. */
export function buildGhEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && !GH_ENV_FORBIDDEN.includes(k)) env[k] = v
  env.GH_PROMPT_DISABLED = '1'
  env.GH_NO_UPDATE_NOTIFIER = '1'
  env.GH_PAGER = ''
  env.NO_COLOR = '1'
  return env
}

export function buildVercelEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && !VERCEL_ENV_FORBIDDEN.includes(k)) env[k] = v
  env.NO_COLOR = '1'
  return env
}

// ------------------------------------------------------------- construction

export function buildInvocation(op: OpDef, params: Params, ctx: ToolContext): Invocation {
  if (op.tool === 'gh') {
    if (op.fixedArgs) return { opId: op.id, tool: 'gh', file: ctx.ghFile, argv: [...op.fixedArgs], env: ctx.ghEnv }
    const endpoint = op.build!(params)
    const argv = ['api', '--method', 'GET', ...(op.ghPaginate ? ['--paginate', '--slurp'] : []), endpoint]
    return { opId: op.id, tool: 'gh', file: ctx.ghFile, argv, env: ctx.ghEnv, endpoint }
  }
  if (op.tool === 'vercel') {
    if (op.fixedArgs) return { opId: op.id, tool: 'vercel', file: ctx.nodeFile, argv: [ctx.vercelEntry, ...op.fixedArgs], env: ctx.vercelEnv }
    const endpoint = op.build!(params)
    const argv = [ctx.vercelEntry, 'api', endpoint, '--method', 'GET', '--raw']
    return { opId: op.id, tool: 'vercel', file: ctx.nodeFile, argv, env: ctx.vercelEnv, endpoint }
  }
  return { opId: op.id, tool: 'git', file: 'git', argv: [...op.fixedArgs!], env: ctx.xcc1Env, cwd: ctx.xcc1Cwd }
}

// ------------------------------------------------------------- validation

function checkEndpoint(op: OpDef, endpoint: string | undefined, token: string): string {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
    // Rejects provider operation identifiers (e.g. `deleteProject`) as well as
    // any non-path argument: only a registry path may reach the provider.
    throw new Refusal(token, 'endpoint is not a registry path')
  }
  if (/\s|#/.test(endpoint) || !op.pathPattern || !op.pathPattern.test(endpoint)) {
    throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', `endpoint does not match the closed pattern of ${op.id}`)
  }
  return endpoint
}

export function assertInvocationSafe(inv: Invocation, op: OpDef, ctx: ToolContext): void {
  if (inv.opId !== op.id || inv.tool !== op.tool) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'invocation/op mismatch')

  if (op.tool === 'gh') {
    if (inv.file !== ctx.ghFile) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'gh executable substituted')
    for (const t of inv.argv) {
      const hit = flagHit(t, GH_FORBIDDEN_FLAGS)
      if (hit) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM', `forbidden gh flag ${hit}`)
      if (t.startsWith('--method=') || (t === '--method' && inv.argv[inv.argv.indexOf(t) + 1] !== 'GET')) {
        throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM', 'gh method is not GET')
      }
    }
    for (const k of GH_ENV_FORBIDDEN) if (k in inv.env) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', `gh env carries ${k}`)
    if (op.fixedArgs) {
      if (!sameArgv(inv.argv, op.fixedArgs)) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'gh fixed argv altered')
      return
    }
    const endpoint = checkEndpoint(op, inv.endpoint, 'STOP_READ_AUTHORITY_EXCEEDED')
    const expected = ['api', '--method', 'GET', ...(op.ghPaginate ? ['--paginate', '--slurp'] : []), endpoint]
    if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM', 'gh argv is not the exact GET shape')
    return
  }

  if (op.tool === 'vercel') {
    if (inv.file !== ctx.nodeFile || inv.argv[0] !== ctx.vercelEntry) {
      throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'vercel entry substituted')
    }
    for (const t of inv.argv.slice(1)) {
      const hit = flagHit(t, VERCEL_FORBIDDEN_FLAGS)
      if (hit) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM', `forbidden vercel flag ${hit}`)
      if (t.startsWith('--method=')) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM', 'vercel method is not the literal GET form')
    }
    for (const k of VERCEL_ENV_FORBIDDEN) if (k in inv.env) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', `vercel env carries ${k}`)
    if (op.fixedArgs) {
      if (!sameArgv(inv.argv, [ctx.vercelEntry, ...op.fixedArgs])) throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'vercel fixed argv altered')
      return
    }
    const endpoint = checkEndpoint(op, inv.endpoint, 'STOP_VERCEL_WRITE_OPERATION_ID')
    const expected = [ctx.vercelEntry, 'api', endpoint, '--method', 'GET', '--raw']
    if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM', 'vercel argv is not the exact GET shape')
    return
  }

  // git / X-R1 (XCC-1)
  if (inv.file !== 'git') throw new Refusal('STOP_READ_AUTHORITY_EXCEEDED', 'git executable substituted')
  if (!sameArgv(inv.argv, op.fixedArgs!)) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'git argv is not the XCC-1 form')
  const url = inv.argv[inv.argv.length - 1]
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'X-R1 URL unparsable') }
  if (url !== X_R1_URL || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'X-R1 URL is not the canonical credential-free https URL')
  }
  if (!inv.cwd || path.resolve(inv.cwd) !== path.resolve(ctx.xcc1Cwd)) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'X-R1 cwd is not the isolated cwd')
  assertXcc1Env(inv.env, inv.cwd)
}

// ------------------------------------------------------------- projection

type Seg = string | number
interface Leaf { generic: string; concrete: Seg[]; value: unknown }
const EMPTY_ARRAY = Symbol('empty-array')
const EMPTY_OBJECT = Symbol('empty-object')
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function flatten(v: unknown, generic: string, concrete: Seg[], out: Leaf[]): void {
  if (Array.isArray(v)) {
    const g = `${generic}[]`
    if (v.length === 0) { out.push({ generic: g, concrete, value: EMPTY_ARRAY }); return }
    v.forEach((el, i) => flatten(el, g, [...concrete, i], out))
    return
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v)
    if (keys.length === 0) { out.push({ generic, concrete, value: EMPTY_OBJECT }); return }
    for (const k of keys) {
      if (UNSAFE_KEYS.has(k)) throw new Refusal('STOP_PROJECTION_NONCONFORMANT', 'unsafe key in provider output')
      flatten(v[k], generic === '' ? k : `${generic}.${k}`, [...concrete, k], out)
    }
    return
  }
  out.push({ generic, concrete, value: v })
}

export function matchesAllowlist(generic: string, allowlist: readonly string[]): boolean {
  for (const p of allowlist) {
    if (p === generic) return true
    if (p.endsWith('.**')) {
      const base = p.slice(0, -3)
      if (generic === base || generic.startsWith(`${base}.`) || generic.startsWith(`${base}[]`)) return true
    }
  }
  return false
}

function setAt(root: { v: unknown }, concrete: Seg[], value: unknown): void {
  if (concrete.length === 0) { root.v = value; return }
  if (root.v === undefined) root.v = typeof concrete[0] === 'number' ? [] : {}
  let cur = root.v as Record<string | number, unknown>
  for (let i = 0; i < concrete.length; i++) {
    const seg = concrete[i]
    if (i === concrete.length - 1) { cur[seg] = value; return }
    if (cur[seg] === undefined) cur[seg] = typeof concrete[i + 1] === 'number' ? [] : {}
    cur = cur[seg] as Record<string | number, unknown>
  }
}

export interface Projection {
  readonly projection: unknown
  readonly absent: readonly { path: string; kind: 'ABSENT_KEY' | 'PRESENT_NULL' }[]
}

/** Reduce provider output to the op's allowlist. Unknown fields are dropped silently, never echoed. */
export function project(op: OpDef, source: unknown): Projection {
  const leaves: Leaf[] = []
  flatten(source, '', [], leaves)
  const root: { v: unknown } = { v: undefined }
  for (const leaf of leaves) {
    if (!matchesAllowlist(leaf.generic, op.allowlist)) continue
    const value = leaf.value === EMPTY_ARRAY ? [] : leaf.value === EMPTY_OBJECT ? {} : leaf.value
    setAt(root, leaf.concrete, value)
  }
  let projection: unknown = root.v === undefined ? {} : root.v
  if (op.presenceOnly && isPlainObject(source)) {
    const presence: Record<string, boolean> = {}
    for (const name of op.presenceOnly) {
      presence[name] = Object.prototype.hasOwnProperty.call(source, name) && source[name] !== null && source[name] !== undefined
    }
    projection = { ...(isPlainObject(projection) ? projection : {}), __presence: presence }
  }
  const absent: { path: string; kind: 'ABSENT_KEY' | 'PRESENT_NULL' }[] = []
  if (isPlainObject(source)) {
    for (const p of op.allowlist) {
      if (p.includes('[]') || p.includes('**')) continue
      let cur: unknown = source
      let missing = false
      for (const seg of p.split('.')) {
        if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) { missing = true; break }
        cur = cur[seg]
      }
      if (missing) absent.push({ path: p, kind: 'ABSENT_KEY' })
      else if (cur === null) absent.push({ path: p, kind: 'PRESENT_NULL' })
    }
  }
  return { projection, absent }
}

/**
 * Post-projection conformance: every leaf of what is about to become evidence
 * must be allowlisted. This is what refuses a projector that was bypassed or
 * mutated into passing the raw object through.
 */
export function assertProjectionConforms(op: OpDef, projection: unknown): void {
  const leaves: Leaf[] = []
  flatten(projection, '', [], leaves)
  for (const leaf of leaves) {
    if (leaf.generic === '' && leaf.value === EMPTY_OBJECT) continue
    if (leaf.generic.startsWith('__presence.')) {
      const name = leaf.generic.slice('__presence.'.length)
      if (op.presenceOnly?.includes(name) && typeof leaf.value === 'boolean') continue
      throw new Refusal('STOP_PROJECTION_NONCONFORMANT', `presence field ${name} not declared or not boolean`)
    }
    if (!matchesAllowlist(leaf.generic, op.allowlist)) {
      throw new Refusal('STOP_PROJECTION_NONCONFORMANT', `field ${leaf.generic} is outside the allowlist of ${op.id}`)
    }
  }
}
