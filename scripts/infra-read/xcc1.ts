// scripts/infra-read/xcc1.ts
//
// XCC-1 — the effective credential-free contract for X-R1 (git ls-remote).
//
// MEASURED on the executor host (EstefaniaOG, git 2.54.0.windows.1), locally,
// with `git credential fill` against a .invalid host and zero network:
//
//   * credential.helper=manager is configured in the SYSTEM gitconfig, and a
//     URL-scoped credential.https://dev.azure.com.* key beside it.
//   * `-c credential.helper=` empties the helper list, BUT each askpass vector
//     still returns a password with GIT_TERMINAL_PROMPT=0:
//       core.askPass=<prog>, GIT_ASKPASS=<prog>, SSH_ASKPASS=<prog>.
//     GIT_TERMINAL_PROMPT only disables the LAST rung of that chain.
//   * GIT_ASKPASS defined-and-EMPTY cuts the whole chain, even with
//     core.askPass and SSH_ASKPASS set. Node delivers an empty variable to a
//     Windows child intact.
//   * %TEMP% on this host is ITSELF a git repository. Any git command run from
//     a temp subdirectory discovers it and reads its .git/config unless
//     GIT_CEILING_DIRECTORIES stops the upward search.
//   * installed git-config.html: an empty http.extraHeader "will reset the
//     extra headers to the empty list". url.<base>.insteadOf has no reset form.
//
// So XCC-1 does not rely on any single reset. It builds the environment from
// scratch (nothing inherited can carry GIT_ASKPASS, GIT_CONFIG_PARAMETERS,
// GIT_DIR or a proxy with userinfo), removes every configuration SOURCE
// (system, global, and repository discovery), points HOME at an empty
// directory so no .netrc/_netrc is found, and then MEASURES, immediately
// before X-R1, that the only configuration git can see is the executor's own
// three command-line resets. Anything else is a breach and X-R1 does not run.

import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Refusal } from './ops'

export interface Xcc1Context {
  readonly root: string
  readonly home: string
  readonly cwd: string
  readonly emptyGlobalConfig: string
}

/** The three resets the executor passes with -c, lower-cased as `git config --list` reports them. */
export const XCC1_COMMAND_LINE_KEYS = ['credential.helper', 'core.askpass', 'http.extraheader'] as const

/** Only these variables may exist in the X-R1 environment. */
const PASSTHROUGH = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'COMSPEC'] as const
const REQUIRED_FIXED: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
}

export function createXcc1Context(parent: string = tmpdir()): Xcc1Context {
  const root = mkdtempSync(path.join(parent, 'xcc1-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'work')
  mkdirSync(home)
  mkdirSync(cwd)
  const emptyGlobalConfig = path.join(root, 'empty.gitconfig')
  writeFileSync(emptyGlobalConfig, '')
  return { root, home, cwd, emptyGlobalConfig }
}

export function buildXcc1Env(ctx: Xcc1Context, base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of PASSTHROUGH) {
    const v = base[k]
    if (typeof v === 'string') env[k] = v
  }
  Object.assign(env, REQUIRED_FIXED)
  env.HOME = ctx.home
  env.USERPROFILE = ctx.home
  env.GIT_CONFIG_GLOBAL = ctx.emptyGlobalConfig
  env.GIT_CEILING_DIRECTORIES = ctx.root
  return env
}

/** Static check of an X-R1 environment. Throws on any deviation from the XCC-1 form. */
export function assertXcc1Env(env: Readonly<Record<string, string>>, cwd: string): void {
  const allowed = new Set<string>([...PASSTHROUGH, ...Object.keys(REQUIRED_FIXED), 'HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CEILING_DIRECTORIES'])
  for (const k of Object.keys(env)) {
    if (!allowed.has(k)) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', `variable ${k} is not permitted in the X-R1 environment`)
  }
  for (const [k, v] of Object.entries(REQUIRED_FIXED)) {
    if (!Object.prototype.hasOwnProperty.call(env, k) || env[k] !== v) {
      // GIT_ASKPASS must be DEFINED and EMPTY: unset lets core.askPass and SSH_ASKPASS run.
      throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', `${k} must be defined as ${JSON.stringify(v)}`)
    }
  }
  const ceiling = env.GIT_CEILING_DIRECTORIES
  if (!ceiling) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'GIT_CEILING_DIRECTORIES missing')
  const rel = path.relative(path.resolve(ceiling), path.resolve(cwd))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'cwd is not strictly below the ceiling directory')
  }
  if (!env.HOME || env.HOME !== env.USERPROFILE) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'HOME/USERPROFILE not the isolated home')
  const g = env.GIT_CONFIG_GLOBAL
  if (!g) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'GIT_CONFIG_GLOBAL missing')
  try {
    if (statSync(g).size !== 0) throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'GIT_CONFIG_GLOBAL is not empty')
  } catch (e) {
    if (e instanceof Refusal) throw e
    throw new Refusal('STOP_XCC1_CONTRACT_VIOLATION', 'GIT_CONFIG_GLOBAL unreadable')
  }
}

/** argv for the runtime isolation preflight: the same resets, listing what git can see. */
export const XCC1_PREFLIGHT_ARGS = ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', 'config', '--list', '--show-origin'] as const

/**
 * Runtime proof. `git config --list --show-origin`, run with the exact X-R1
 * environment and cwd, must show exactly the executor's three command-line
 * entries and NOTHING from any file. A single file-origin line — a helper, an
 * extraHeader, an insteadOf, a cookie file, even a harmless core.* key from a
 * discovered repository — means a configuration source leaked in, and X-R1 is
 * refused. Values are never read; only origins and key names.
 */
export function assertIsolationListing(stdout: string): void {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  const seen: string[] = []
  for (const line of lines) {
    const tab = line.indexOf('\t')
    const origin = tab === -1 ? '' : line.slice(0, tab)
    const key = (tab === -1 ? line : line.slice(tab + 1)).split('=')[0].toLowerCase()
    if (origin !== 'command line:') throw new Refusal('STOP_XCC1_ISOLATION_BREACH', `configuration from a non-command-line source (${key})`)
    seen.push(key)
  }
  const expected = [...XCC1_COMMAND_LINE_KEYS].sort()
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(expected)) {
    throw new Refusal('STOP_XCC1_ISOLATION_BREACH', 'command-line configuration set differs from the XCC-1 resets')
  }
}
