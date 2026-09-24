// @vitest-environment node
// tests/infra-read/xcc1-local.test.ts
//
// XCC-1 against REAL git, with ZERO network: `git credential fill` for a
// `.invalid` host exercises the helper and askpass machinery without opening a
// socket, and `git config --list --show-origin` reports every configuration
// source git can see. Each refused vector is first shown to be LIVE (it really
// does produce a credential or leak configuration) so that its refusal is not
// vacuous.

import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  XCC1_PREFLIGHT_ARGS, assertIsolationListing, assertXcc1Env, buildXcc1Env, createXcc1Context,
} from '../../scripts/infra-read/xcc1'
import { Refusal } from '../../scripts/infra-read/ops'

const ctx = createXcc1Context()
/** Next.js augments ProcessEnv with NODE_ENV; a from-scratch child env deliberately has none. */
const asEnv = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv
afterAll(() => rmSync(ctx.root, { recursive: true, force: true }))

const marker = path.join(ctx.root, 'askpass-was-called')
const askpass = path.join(ctx.root, 'askpass.sh')
writeFileSync(askpass, `#!/bin/sh\necho called > "${marker.replace(/\\/g, '/')}"\necho x\n`)
chmodSync(askpass, 0o755)

function credentialFill(env: Record<string, string>, extra: string[] = [], cwd = ctx.cwd) {
  if (existsSync(marker)) rmSync(marker)
  const r = spawnSync('git', [...extra, 'credential', 'fill'], {
    cwd, env: asEnv(env), input: 'protocol=https\nhost=xcc1-test.invalid\n\n', encoding: 'utf8',
  })
  return { askpassInvoked: existsSync(marker), gotPassword: /password=/.test(r.stdout ?? '') }
}

function listing(env: Record<string, string>, cwd = ctx.cwd): string {
  const r = spawnSync('git', [...XCC1_PREFLIGHT_ARGS], { cwd, env: asEnv(env), encoding: 'utf8' })
  expect(r.status).toBe(0)
  return r.stdout
}

function tokenOf(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

function hostileGlobal(name: string, body: string): string {
  const f = path.join(ctx.root, `${name}.gitconfig`)
  writeFileSync(f, body)
  return f
}

const env = buildXcc1Env(ctx, process.env)

describe('XCC-1 positive controls (real git, no network)', () => {
  it('the executor environment passes the static guard', () => {
    expect(() => assertXcc1Env(env, ctx.cwd)).not.toThrow()
  })
  it('the isolation preflight sees ONLY the three command-line resets', () => {
    expect(() => assertIsolationListing(listing(env))).not.toThrow()
  })
  it('no credential is produced — even with a hostile core.askPass, the empty GIT_ASKPASS cuts the chain', () => {
    const r = credentialFill(env, ['-c', 'credential.helper=', '-c', `core.askPass=${askpass}`])
    expect(r).toEqual({ askpassInvoked: false, gotPassword: false })
  })
})

describe('XCC-1 mutants: each vector is LIVE, and each is refused', () => {
  it('askpass available via GIT_ASKPASS: live, and refused by the static guard', () => {
    const bad = { ...env, GIT_ASKPASS: askpass }
    expect(credentialFill(bad, ['-c', 'credential.helper='])).toEqual({ askpassInvoked: true, gotPassword: true })
    expect(tokenOf(() => assertXcc1Env(bad, ctx.cwd))).toBe('STOP_XCC1_CONTRACT_VIOLATION')
  })

  it('askpass via core.askPass when GIT_ASKPASS is UNSET: live, and refused', () => {
    const bad: Record<string, string> = { ...env }
    delete bad.GIT_ASKPASS
    expect(credentialFill(bad, ['-c', 'credential.helper=', '-c', `core.askPass=${askpass}`])).toEqual({ askpassInvoked: true, gotPassword: true })
    expect(tokenOf(() => assertXcc1Env(bad, ctx.cwd))).toBe('STOP_XCC1_CONTRACT_VIOLATION')
  })

  it('askpass via SSH_ASKPASS when GIT_ASKPASS is unset: live, and refused', () => {
    const bad: Record<string, string> = { ...env, SSH_ASKPASS: askpass }
    delete bad.GIT_ASKPASS
    expect(credentialFill(bad, ['-c', 'credential.helper='])).toEqual({ askpassInvoked: true, gotPassword: true })
    expect(tokenOf(() => assertXcc1Env(bad, ctx.cwd))).toBe('STOP_XCC1_CONTRACT_VIOLATION')
  })

  it('credential helper still active from a config file: visible to the preflight, refused', () => {
    const f = hostileGlobal('helper', `[credential]\n\thelper = ${askpass.replace(/\\/g, '/')}\n`)
    const bad = { ...env, GIT_CONFIG_GLOBAL: f }
    expect(tokenOf(() => assertIsolationListing(listing(bad)))).toBe('STOP_XCC1_ISOLATION_BREACH')
    expect(tokenOf(() => assertXcc1Env(bad, ctx.cwd))).toBe('STOP_XCC1_CONTRACT_VIOLATION')
  })

  it('extraHeader credential path from a config file: visible to the preflight, refused', () => {
    const header = ['Author', 'ization: Basic ', 'eDp5'].join('')
    const f = hostileGlobal('header', `[http]\n\textraHeader = ${header}\n`)
    expect(tokenOf(() => assertIsolationListing(listing({ ...env, GIT_CONFIG_GLOBAL: f })))).toBe('STOP_XCC1_ISOLATION_BREACH')
  })

  it('insteadOf rewriting to a credential-bearing URL: visible to the preflight, refused', () => {
    const f = hostileGlobal('insteadof', '[url "https://someone@github.com/"]\n\tinsteadOf = https://github.com/\n')
    expect(tokenOf(() => assertIsolationListing(listing({ ...env, GIT_CONFIG_GLOBAL: f })))).toBe('STOP_XCC1_ISOLATION_BREACH')
  })

  it('repository discovery without a ceiling: a parent repo config leaks in, refused', () => {
    const repo = path.join(ctx.root, 'parent-repo')
    const inner = path.join(repo, 'inner')
    mkdirSync(inner, { recursive: true })
    expect(spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' }).status).toBe(0)
    const bad: Record<string, string> = { ...env }
    delete bad.GIT_CEILING_DIRECTORIES
    expect(tokenOf(() => assertIsolationListing(listing(bad, inner)))).toBe('STOP_XCC1_ISOLATION_BREACH')
    expect(tokenOf(() => assertXcc1Env(bad, inner))).toBe('STOP_XCC1_CONTRACT_VIOLATION')
  })

  it('a FILE-provided credential.helper SUBSTITUTED for the missing command-line reset is refused (only the origin check sees it)', () => {
    // Same three key NAMES as the XCC-1 resets, so a key-set comparison alone would pass.
    // Mutation battery M13 survived without this test.
    const f = hostileGlobal('substituted', `[credential]\n\thelper = ${askpass.replace(/\\/g, '/')}\n`)
    const r = spawnSync('git', ['-c', 'core.askPass=', '-c', 'http.extraHeader=', 'config', '--list', '--show-origin'], {
      cwd: ctx.cwd, env: asEnv({ ...env, GIT_CONFIG_GLOBAL: f }), encoding: 'utf8',
    })
    const keys = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')[1].split('=')[0].toLowerCase()).sort()
    expect(keys).toEqual(['core.askpass', 'credential.helper', 'http.extraheader'])
    expect(tokenOf(() => assertIsolationListing(r.stdout))).toBe('STOP_XCC1_ISOLATION_BREACH')
  })

  it('an injected -c beyond the three resets is refused by the listing check', () => {
    const r = spawnSync('git', ['-c', 'http.cookieFile=/tmp/c', ...XCC1_PREFLIGHT_ARGS], { cwd: ctx.cwd, env: asEnv(env), encoding: 'utf8' })
    expect(tokenOf(() => assertIsolationListing(r.stdout))).toBe('STOP_XCC1_ISOLATION_BREACH')
  })
})
