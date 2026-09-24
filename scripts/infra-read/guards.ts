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
import { NormativeViolation, assertXcc1NormativeArgv, assertXcc1NormativeEnv } from './xcc1-normative'

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
 * differ from gh: --generate (emits a request TEMPLATE instead of reading; v1.0.5
 * erratum: the measured curl template carries a <TOKEN> placeholder, not the token),
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

// ------------------------------------------------------------- environment model (v1.0.5)
//
// gh and vercel get a deliberately CONSTRUCTED environment, not the caller's
// environment minus a denylist. MEASURED on the executor host: the caller's
// environment carried CLAUDE_CODE_MESSAGING_TOKEN, which the previous denylist
// passed to both CLIs; and the independent IC measured that a case-sensitive
// denylist is bypassed on Windows by Gh_Token / Vercel_Token, which the child
// then reads as GH_TOKEN / VERCEL_TOKEN. Names are therefore compared in upper
// case everywhere, and only these classes are carried:
//
//   OS / process context      PATH, PATHEXT, SystemRoot, WINDIR, SystemDrive, ComSpec, TEMP, TMP, TMPDIR, LANG, LC_ALL, TZ
//   account / profile context APPDATA, LOCALAPPDATA, USERPROFILE, HOME, HOMEDRIVE, HOMEPATH, USERNAME, USERDOMAIN
//                             — gh finds its config and hosts.yml through APPDATA; the Windows keyring needs no
//                             variable; Vercel CLI finds auth.json under APPDATA (xdg.data)
//   gh only                   DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR (POSIX keyring access)
//
// Deliberately NOT carried (decided, not by omission):
//   credentials               *TOKEN*, *SECRET*, *PASSW*, *API_KEY*, *PRIVATE_KEY*, *CREDENTIAL*, *COOKIE*, *AUTH*
//   identity redirection      GH_HOST, GH_CONFIG_DIR, GH_REPO, VERCEL_*, NOW_*, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME
//   code / trust injection    NODE_OPTIONS, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, NODE_USE_SYSTEM_CA,
//                             SSL_CERT_FILE, SSL_CERT_DIR
//   traffic redirection       HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY (none is set on the executor host; if the
//                             network needs one, the read fails visibly instead of routing a credential through it)
//   diagnostics               DEBUG, GH_DEBUG
// NODE_USE_SYSTEM_CA IS set on the host. Dropping it narrows Node's trust to its
// bundled public roots, which chain Vercel's public API; a TLS failure then
// signals interception rather than being accepted.

const OS_AND_ACCOUNT = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
] as const
const GH_FIXED: Readonly<Record<string, string>> = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1' }
const VERCEL_FIXED: Readonly<Record<string, string>> = { NO_COLOR: '1' }
export const GH_ENV_ALLOWED_UPPER: ReadonlySet<string> = new Set([...OS_AND_ACCOUNT, 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', ...Object.keys(GH_FIXED)])
export const VERCEL_ENV_ALLOWED_UPPER: ReadonlySet<string> = new Set([...OS_AND_ACCOUNT, ...Object.keys(VERCEL_FIXED)])

/** Credential-bearing name shapes, matched on the UPPER-CASED name. */
export const CREDENTIAL_NAME_RE = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH/

function constructEnv(base: Readonly<Record<string, string | undefined>>, allowedUpper: ReadonlySet<string>, fixed: Readonly<Record<string, string>>): Record<string, string> {
  const byUpper = new Map<string, [string, string][]>()
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue
    const u = k.toUpperCase()
    const list = byUpper.get(u) ?? []
    list.push([k, v])
    byUpper.set(u, list)
  }
  const env: Record<string, string> = {}
  for (const u of allowedUpper) {
    if (u in fixed) continue
    const hits = byUpper.get(u)
    if (!hits) continue
    if (new Set(hits.map(([, v]) => v)).size > 1) {
      // Two case variants with different values: which one the child sees is platform-dependent. Refuse.
      throw new Refusal('STOP_ENV_AMBIGUOUS', `environment carries conflicting case variants of ${u}`)
    }
    env[hits[0][0]] = hits[0][1]
  }
  return { ...env, ...fixed }
}

/** Constructed environment for gh. The keyring identity RC-9a measures is the one gh resolves under it. */
export function buildGhEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return constructEnv(base, GH_ENV_ALLOWED_UPPER, GH_FIXED)
}

export function buildVercelEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return constructEnv(base, VERCEL_ENV_ALLOWED_UPPER, VERCEL_FIXED)
}

/** Invocation-time check, independent of the builder: every name, upper-cased, must be allowed and none credential-shaped. */
function assertProviderEnv(env: Readonly<Record<string, string>>, allowedUpper: ReadonlySet<string>, tool: string): void {
  const seen = new Set<string>()
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase()
    if (CREDENTIAL_NAME_RE.test(u)) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', `${tool} env carries a credential-shaped variable (${u})`)
    if (!allowedUpper.has(u)) throw new Refusal('STOP_ENV_NOT_ALLOWLISTED', `${tool} env carries ${u}, outside the constructed environment`)
    if (seen.has(u)) throw new Refusal('STOP_ENV_AMBIGUOUS', `${tool} env carries two case variants of ${u}`)
    seen.add(u)
  }
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
    assertProviderEnv(inv.env, GH_ENV_ALLOWED_UPPER, 'gh')
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
    assertProviderEnv(inv.env, VERCEL_ENV_ALLOWED_UPPER, 'vercel')
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
  // The normative contract is checked FIRST and independently of ops.ts: the
  // sameArgv comparison below shares its oracle with the builder (IC I13).
  asXcc1Refusal(() => assertXcc1NormativeArgv(inv.argv))
  if (!sameArgv(inv.argv, op.fixedArgs!))throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'git argv is not the XCC-1 form')
  const url = inv.argv[inv.argv.length - 1]
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'X-R1 URL unparsable') }
  if (url !== X_R1_URL || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'X-R1 URL is not the canonical credential-free https URL')
  }
  if (!inv.cwd || path.resolve(inv.cwd) !== path.resolve(ctx.xcc1Cwd)) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'X-R1 cwd is not the isolated cwd')
  assertXcc1Env(inv.env, inv.cwd)
  asXcc1Refusal(() => assertXcc1NormativeEnv(inv.env, inv.cwd!))
}

/** Re-throws a normative violation under the XCC-1 refusal token. */
export function asXcc1Refusal(check: () => void): void {
  try { check() } catch (e) {
    if (e instanceof NormativeViolation) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', e.message)
    throw e
  }
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
