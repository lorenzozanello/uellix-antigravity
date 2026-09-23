// @vitest-environment node
// tests/infra-read/env-model.test.ts
//
// The CONSTRUCTED provider environment (v1.0.5). The IC measured on Windows
// that Gh_Token / Vercel_Token bypass a case-sensitive denylist and reach the
// child as GH_TOKEN / VERCEL_TOKEN. The builder now carries only enumerated
// classes, compared in upper case, and refuses conflicting case variants.
// Measured on the executor host with this environment (offline): `gh config
// get git_protocol -h github.com` resolves (exit 0) and `vercel --version`
// runs (exit 0), so OS/account context needed for keyring and auth.json
// resolution is carried.

import { describe, it, expect } from 'vitest'
import {
  CREDENTIAL_NAME_RE, GH_ENV_ALLOWED_UPPER, VERCEL_ENV_ALLOWED_UPPER, buildGhEnv, buildVercelEnv,
} from '../../scripts/infra-read/guards'
import { Refusal } from '../../scripts/infra-read/ops'

const HOST_LIKE: Record<string, string> = {
  Path: 'C:\\Windows\\system32', PATHEXT: '.COM;.EXE', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'cmd.exe',
  TEMP: 'C:\\t', TMP: 'C:\\t', APPDATA: 'C:\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\u\\AppData\\Local', USERPROFILE: 'C:\\u',
  HOMEDRIVE: 'C:', HOMEPATH: '\\u', USERNAME: 'u', USERDOMAIN: 'd',
  // Everything below must NOT reach a provider CLI.
  Gh_Token: 'x', gh_token: 'x', Github_Token: 'x', Vercel_Token: 'x', vercel_token: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 'x',
  GH_CONFIG_DIR: 'C:\\evil', Gh_Host: 'evil.example', GH_REPO: 'o/r', VERCEL_ORG_ID: 'x', Vercel_Project_Id: 'x', NOW_TOKEN: 'x',
  NODE_OPTIONS: '--require evil.js', node_options: '--require evil.js', NODE_EXTRA_CA_CERTS: 'ca.pem', NODE_TLS_REJECT_UNAUTHORIZED: '0',
  NODE_USE_SYSTEM_CA: '1', SSL_CERT_FILE: 'x', HTTPS_PROXY: 'http://p', http_proxy: 'http://p', ALL_PROXY: 'http://p', NO_PROXY: '*',
  XDG_CONFIG_HOME: 'x', XDG_DATA_HOME: 'x', DEBUG: '*', GH_DEBUG: 'api', GIT_EDITOR: 'x',
}

describe('constructed gh / vercel environments', () => {
  for (const [tool, build, allowed] of [['gh', buildGhEnv, GH_ENV_ALLOWED_UPPER], ['vercel', buildVercelEnv, VERCEL_ENV_ALLOWED_UPPER]] as const) {
    it(`${tool}: carries only allowlisted names (compared in upper case) and no credential-shaped name`, () => {
      const env = build(HOST_LIKE)
      for (const k of Object.keys(env)) {
        expect(allowed.has(k.toUpperCase())).toBe(true)
        expect(CREDENTIAL_NAME_RE.test(k.toUpperCase())).toBe(false)
      }
      const upper = Object.keys(env).map((k) => k.toUpperCase())
      for (const bad of ['GH_TOKEN', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'NOW_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_REPO',
        'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_SYSTEM_CA',
        'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DEBUG', 'GH_DEBUG', 'GIT_EDITOR']) {
        expect(upper).not.toContain(bad)
      }
    })
    it(`${tool}: keeps the OS/account context the CLI needs (original spelling preserved)`, () => {
      const env = build(HOST_LIKE)
      expect(env.Path).toBe(HOST_LIKE.Path)
      expect(env.SystemRoot).toBe(HOST_LIKE.SystemRoot)
      expect(env.APPDATA).toBe(HOST_LIKE.APPDATA)
      expect(env.USERPROFILE).toBe(HOST_LIKE.USERPROFILE)
      expect(env.NO_COLOR).toBe('1')
    })
    it(`${tool}: conflicting case variants of an allowed name are refused (STOP_ENV_AMBIGUOUS)`, () => {
      try { build({ ...HOST_LIKE, PATH: 'D:\\other' }); expect.unreachable() } catch (e) {
        expect(e).toBeInstanceOf(Refusal)
        expect((e as Refusal).token).toBe('STOP_ENV_AMBIGUOUS')
      }
    })
    it(`${tool}: identical case variants are not ambiguous`, () => {
      expect(() => build({ ...HOST_LIKE, PATH: HOST_LIKE.Path })).not.toThrow()
    })
  }
  it('gh fixed values cannot be overridden by the caller', () => {
    const env = buildGhEnv({ ...HOST_LIKE, gh_prompt_disabled: '0', GH_PAGER: 'less' })
    expect(env.GH_PROMPT_DISABLED).toBe('1')
    expect(env.GH_PAGER).toBe('')
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'GH_PROMPT_DISABLED')).toEqual(['GH_PROMPT_DISABLED'])
  })
  it('the allowlists are exactly these classes (pinned)', () => {
    const os = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
      'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN']
    expect([...GH_ENV_ALLOWED_UPPER].sort()).toEqual([...os, 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'GH_PAGER', 'NO_COLOR'].sort())
    expect([...VERCEL_ENV_ALLOWED_UPPER].sort()).toEqual([...os, 'NO_COLOR'].sort())
  })
})
