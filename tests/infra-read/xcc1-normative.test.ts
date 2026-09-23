// @vitest-environment node
// tests/infra-read/xcc1-normative.test.ts
//
// The X-R1 credential-free contract as an INDEPENDENT machine expectation
// (v1.0.5, remediating IC I13-I15). The spec is pinned here by LITERAL, so it
// cannot be weakened in xcc1-normative.ts without going RED; the registry and
// the XCC-1 builder are then checked AGAINST it, so they cannot drift from it
// either. Local only: git runs against nothing but its own configuration.

import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  XCC1_NORMATIVE, NormativeViolation, assertXcc1NormativeArgv, assertXcc1NormativeEnv,
  assertXcc1NormativePreflightArgv, assertXcc1NormativePreflightListing,
} from '../../scripts/infra-read/xcc1-normative'
import { getOp } from '../../scripts/infra-read/ops'
import { XCC1_PREFLIGHT_ARGS, buildXcc1Env, createXcc1Context } from '../../scripts/infra-read/xcc1'

const ctx = createXcc1Context()
const env = buildXcc1Env(ctx, process.env)
afterAll(() => rmSync(ctx.root, { recursive: true, force: true }))

const URL_ = 'https://github.com/lorenzozanello/uellix-antigravity.git'
const RESETS = ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=']

function violation(fn: () => void): string {
  try { fn() } catch (e) { if (e instanceof NormativeViolation) return e.message; throw e }
  return 'NO_VIOLATION'
}

describe('the normative spec itself (pinned by literal)', () => {
  it('required resets, subcommand, origin and environment are exactly these', () => {
    expect(XCC1_NORMATIVE.requiredConfigResets).toEqual({ 'credential.helper': '', 'core.askpass': '', 'http.extraheader': '' })
    expect(XCC1_NORMATIVE.subcommand).toBe('ls-remote')
    expect(XCC1_NORMATIVE.origin).toEqual({ protocol: 'https:', host: 'github.com', pathname: '/lorenzozanello/uellix-antigravity.git' })
    expect(XCC1_NORMATIVE.env).toEqual({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' })
    expect([...XCC1_NORMATIVE.mustBeInsideCeiling]).toEqual(['GIT_CONFIG_GLOBAL', 'HOME', 'USERPROFILE'])
    expect(XCC1_NORMATIVE.requiresRuntimePreflight).toBe(true)
  })
  it('the spec module imports neither the registry nor the XCC-1 builder (independent oracle)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('scripts/infra-read/xcc1-normative.ts', 'utf8')
    expect(src).not.toMatch(/from '\.\/(?:ops|xcc1|guards)'/)
  })
})

describe('the registry and the builder conform to the spec', () => {
  it('X-R1 fixedArgs (ops.ts) satisfy the normative argv', () => {
    expect(violation(() => assertXcc1NormativeArgv(getOp('X-R1').fixedArgs!))).toBe('NO_VIOLATION')
  })
  it('XCC1_PREFLIGHT_ARGS (xcc1.ts) satisfy the normative preflight argv', () => {
    expect(violation(() => assertXcc1NormativePreflightArgv(XCC1_PREFLIGHT_ARGS))).toBe('NO_VIOLATION')
  })
  it('the built XCC-1 environment satisfies the normative environment', () => {
    expect(violation(() => assertXcc1NormativeEnv(env, ctx.cwd))).toBe('NO_VIOLATION')
  })
  it('REAL git: the preflight listing under the built environment satisfies the normative listing', () => {
    const r = spawnSync('git', [...XCC1_PREFLIGHT_ARGS], { cwd: ctx.cwd, env: env as unknown as NodeJS.ProcessEnv, encoding: 'utf8', shell: false })
    expect(r.status).toBe(0)
    expect(violation(() => assertXcc1NormativePreflightListing(r.stdout))).toBe('NO_VIOLATION')
  })
})

describe('each required reset, removed or altered, is a violation', () => {
  const tail = ['ls-remote', URL_]
  const cases: [string, string[]][] = [
    ['credential.helper reset removed', ['-c', 'core.askPass=', '-c', 'http.extraHeader=', ...tail]],
    ['core.askPass reset removed', ['-c', 'credential.helper=', '-c', 'http.extraHeader=', ...tail]],
    ['http.extraHeader reset removed', ['-c', 'credential.helper=', '-c', 'core.askPass=', ...tail]],
    ['all resets removed', [...tail]],
    ['credential.helper set to a helper', ['-c', 'credential.helper=manager', '-c', 'core.askPass=', '-c', 'http.extraHeader=', ...tail]],
    ['extraHeader carries a header', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=Authorization: x', ...tail]],
    ['an extra -c key (insteadOf injected)', [...RESETS, '-c', 'url.https://a@github.com/.insteadOf=https://github.com/', ...tail]],
    ['duplicate reset', [...RESETS, '-c', 'credential.helper=', ...tail]],
    ['subcommand other than ls-remote', [...RESETS, 'fetch', URL_]],
    ['extra argument after the origin', [...RESETS, 'ls-remote', URL_, 'refs/heads/main']],
    ['http origin', [...RESETS, 'ls-remote', URL_.replace('https', 'http')]],
    ['another host', [...RESETS, 'ls-remote', URL_.replace('github.com', 'github.example')]],
    ['another repository', [...RESETS, 'ls-remote', URL_.replace('uellix-antigravity', 'other')]],
    ['userinfo, no password', [...RESETS, 'ls-remote', URL_.replace('https://', 'https://someone@')]],
    ['ssh origin', [...RESETS, 'ls-remote', 'git@github.com:lorenzozanello/uellix-antigravity.git']],
  ]
  for (const [name, argv] of cases) {
    it(`VIOLATION: ${name}`, () => { expect(violation(() => assertXcc1NormativeArgv(argv))).not.toBe('NO_VIOLATION') })
  }
  it('VIOLATION: preflight argv missing a reset', () => {
    expect(violation(() => assertXcc1NormativePreflightArgv(['-c', 'credential.helper=', '-c', 'core.askPass=', 'config', '--list', '--show-origin']))).not.toBe('NO_VIOLATION')
  })
})

describe('environment semantics', () => {
  const cases: [string, (e: Record<string, string>) => void][] = [
    ['system config re-enabled', (e) => { e.GIT_CONFIG_NOSYSTEM = '0' }],
    ['system config flag unset', (e) => { delete e.GIT_CONFIG_NOSYSTEM }],
    ['terminal prompt enabled', (e) => { e.GIT_TERMINAL_PROMPT = '1' }],
    ['GIT_ASKPASS unset (core.askPass / SSH_ASKPASS would run)', (e) => { delete e.GIT_ASKPASS }],
    ['GIT_ASKPASS set', (e) => { e.GIT_ASKPASS = 'x' }],
    ['SSH_ASKPASS set', (e) => { e.SSH_ASKPASS = 'x' }],
    ['GCM interactive', (e) => { e.GCM_INTERACTIVE = 'auto' }],
    ['ceiling removed', (e) => { delete e.GIT_CEILING_DIRECTORIES }],
    ['global config outside the root', (e) => { e.GIT_CONFIG_GLOBAL = path.join(path.dirname(ctx.root), 'g') }],
    ['HOME outside the root', (e) => { e.HOME = path.dirname(ctx.root) }],
  ]
  for (const [name, mut] of cases) {
    it(`VIOLATION: ${name}`, () => {
      const e = { ...env }
      mut(e)
      expect(violation(() => assertXcc1NormativeEnv(e, ctx.cwd))).not.toBe('NO_VIOLATION')
    })
  }
  it('VIOLATION: a non-empty global config file', () => {
    const g = path.join(ctx.root, 'nonempty.gitconfig')
    writeFileSync(g, '[credential]\n\thelper = manager\n')
    expect(violation(() => assertXcc1NormativeEnv({ ...env, GIT_CONFIG_GLOBAL: g }, ctx.cwd))).not.toBe('NO_VIOLATION')
  })
})

describe('preflight listing semantics', () => {
  const good = 'command line:\tcredential.helper=\ncommand line:\tcore.askpass=\ncommand line:\thttp.extraheader=\n'
  it('POSITIVE', () => { expect(violation(() => assertXcc1NormativePreflightListing(good))).toBe('NO_VIOLATION') })
  const cases: [string, string][] = [
    ['file origin', `${good}file:C:/x/.gitconfig\tcore.editor=vi\n`],
    ['insteadOf from the command line', `${good}command line:\turl.https://a@github.com/.insteadof=https://github.com/\n`],
    ['a reset missing', 'command line:\tcredential.helper=\ncommand line:\tcore.askpass=\n'],
    ['a reset with a value', 'command line:\tcredential.helper=manager\ncommand line:\tcore.askpass=\ncommand line:\thttp.extraheader=\n'],
  ]
  for (const [name, stdout] of cases) {
    it(`VIOLATION: ${name}`, () => { expect(violation(() => assertXcc1NormativePreflightListing(stdout))).not.toBe('NO_VIOLATION') })
  }
})
