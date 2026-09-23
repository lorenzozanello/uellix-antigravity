// scripts/infra-read/xcc1-normative.ts
//
// The NORMATIVE X-R1 credential-free contract, as an independent machine
// expectation (v1.0.5, remediating IC I13-I15).
//
// The independent IC found that removing a `-c` reset from X-R1's argv
// survived every test, because the guard compared the built argv against
// ops.ts's fixedArgs — the same array the builder used. A check whose oracle
// is the thing it checks cannot fail. This module states the contract by
// MEANING and parses the argv against it, so a builder that drops a reset is
// refused regardless of what ops.ts says. It must not import from ops.ts or
// xcc1.ts; tests pin its content literally, so weakening it here also fails.

import path from 'node:path'
import { statSync } from 'node:fs'

export class NormativeViolation extends Error {
  constructor(detail: string) {
    super(`STOP_XCC1_NORMATIVE_VIOLATION: ${detail}`)
    this.name = 'NormativeViolation'
  }
}

export const XCC1_NORMATIVE = Object.freeze({
  /** Resets passed with -c, keyed by git's lower-cased config name; value must be the empty string. */
  requiredConfigResets: Object.freeze({ 'credential.helper': '', 'core.askpass': '', 'http.extraheader': '' }),
  subcommand: 'ls-remote',
  origin: Object.freeze({ protocol: 'https:', host: 'github.com', pathname: '/lorenzozanello/uellix-antigravity.git' }),
  /** Exact values. GIT_ASKPASS must be DEFINED and EMPTY: unset lets core.askPass and SSH_ASKPASS run. */
  env: Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' }),
  /** Variables that must point INSIDE the isolation root (the ceiling directory). */
  mustBeInsideCeiling: Object.freeze(['GIT_CONFIG_GLOBAL', 'HOME', 'USERPROFILE']),
  /** The preflight must list exactly the reset keys, all from the command line, before X-R1 may run. */
  requiresRuntimePreflight: true,
  preflightTail: Object.freeze(['config', '--list', '--show-origin']),
})

function parseResets(argv: readonly string[]): { resets: Map<string, string>; rest: string[] } {
  const resets = new Map<string, string>()
  let i = 0
  while (i < argv.length && argv[i] === '-c') {
    const pair = argv[i + 1]
    if (typeof pair !== 'string' || !pair.includes('=')) throw new NormativeViolation('malformed -c pair')
    const eq = pair.indexOf('=')
    const key = pair.slice(0, eq).toLowerCase()
    if (resets.has(key)) throw new NormativeViolation(`duplicate -c ${key}`)
    resets.set(key, pair.slice(eq + 1))
    i += 2
  }
  return { resets, rest: argv.slice(i) }
}

function assertResets(resets: Map<string, string>): void {
  const want = XCC1_NORMATIVE.requiredConfigResets as Readonly<Record<string, string>>
  for (const [k, v] of Object.entries(want)) {
    if (!resets.has(k)) throw new NormativeViolation(`required reset ${k} is missing`)
    if (resets.get(k) !== v) throw new NormativeViolation(`reset ${k} is not the empty value`)
  }
  for (const k of resets.keys()) if (!(k in want)) throw new NormativeViolation(`unexpected -c ${k}`)
}

/** X-R1 argv: exactly the required resets, then `ls-remote <canonical https origin>`, nothing else. */
export function assertXcc1NormativeArgv(argv: readonly string[]): void {
  const { resets, rest } = parseResets(argv)
  assertResets(resets)
  if (rest.length !== 2 || rest[0] !== XCC1_NORMATIVE.subcommand) throw new NormativeViolation('X-R1 must be exactly `ls-remote <origin>` after the resets')
  let u: URL
  try { u = new URL(rest[1]) } catch { throw new NormativeViolation('origin is not a URL') }
  const o = XCC1_NORMATIVE.origin
  if (u.protocol !== o.protocol || u.host !== o.host || u.pathname !== o.pathname || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw new NormativeViolation('origin is not the canonical credential-free https URL')
  }
}

/** Preflight argv: the SAME resets as X-R1, then `config --list --show-origin`. */
export function assertXcc1NormativePreflightArgv(argv: readonly string[]): void {
  const { resets, rest } = parseResets(argv)
  assertResets(resets)
  const tail = XCC1_NORMATIVE.preflightTail
  if (rest.length !== tail.length || rest.some((t, i) => t !== tail[i])) throw new NormativeViolation('preflight tail is not `config --list --show-origin`')
}

/**
 * Preflight RESULT: every visible key comes from the command line, the key set
 * is exactly the required resets, each with the empty value, and no URL
 * rewrite (insteadOf) is visible from any source. Independent of xcc1.ts's
 * assertIsolationListing, so weakening either one alone stays RED.
 */
export function assertXcc1NormativePreflightListing(stdout: string): void {
  const want = Object.keys(XCC1_NORMATIVE.requiredConfigResets).sort()
  const seen: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const tab = line.indexOf('\t')
    if (tab === -1 || line.slice(0, tab) !== 'command line:') throw new NormativeViolation('a configuration line does not come from the command line')
    const kv = line.slice(tab + 1)
    const eq = kv.indexOf('=')
    const key = (eq === -1 ? kv : kv.slice(0, eq)).toLowerCase()
    if (/^url\..*\.(?:insteadof|pushinsteadof)$/.test(key)) throw new NormativeViolation('a URL rewrite (insteadOf) is visible to X-R1')
    if (eq === -1 || kv.slice(eq + 1) !== '') throw new NormativeViolation(`${key} is not reset to the empty value`)
    seen.push(key)
  }
  if (JSON.stringify(seen.sort()) !== JSON.stringify(want)) throw new NormativeViolation('visible configuration is not exactly the required resets')
}

/** Environment semantics: exact values, isolation paths inside the ceiling, cwd strictly below it, empty global config. */
export function assertXcc1NormativeEnv(env: Readonly<Record<string, string>>, cwd: string): void {
  for (const [k, v] of Object.entries(XCC1_NORMATIVE.env)) {
    if (!Object.prototype.hasOwnProperty.call(env, k) || env[k] !== v) throw new NormativeViolation(`${k} must be exactly ${JSON.stringify(v)}`)
  }
  const ceiling = env.GIT_CEILING_DIRECTORIES
  if (!ceiling) throw new NormativeViolation('GIT_CEILING_DIRECTORIES missing')
  const below = (p: string) => {
    const rel = path.relative(path.resolve(ceiling), path.resolve(p))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  if (!below(cwd)) throw new NormativeViolation('cwd is not strictly below the ceiling')
  for (const k of XCC1_NORMATIVE.mustBeInsideCeiling) {
    const v = env[k]
    if (!v || !below(v)) throw new NormativeViolation(`${k} does not point inside the isolation root`)
  }
  let size: number
  try { size = statSync(env.GIT_CONFIG_GLOBAL).size } catch { throw new NormativeViolation('GIT_CONFIG_GLOBAL unreadable') }
  if (size !== 0) throw new NormativeViolation('GIT_CONFIG_GLOBAL is not empty')
}
