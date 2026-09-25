// tests/custody/wcm-custody-mechanism.test.ts
//
// PLATFORM-INDEPENDENT CONTROLS OVER THE CUSTODY MECHANISM.
//
// Every test here runs on any platform, including the ubuntu-latest runners
// that are the only ones this repository has. Nothing in this file touches
// Windows Credential Manager, and nothing in it is skipped on a non-Windows
// host — which is the point. The behavioural half of the contract lives in the
// WINDOWS_LOCAL_SENTINEL demonstration and cannot run here; what CAN be
// asserted cross-platform is that the mechanism's argv is fixed, its bridge
// source carries no secret, and its refusals refuse.

import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'

import {
  BRIDGE_ENV_ALLOWLIST,
  CustodyError,
  ERROR_NOT_FOUND,
  bridgeArgv,
  isWindowsCredentialManagerAvailable,
} from '@/db/custody/wcm-credential-store'
import { WCM_BRIDGE_POWERSHELL_SOURCE } from '@/db/custody/wcm-powershell-source'
import { acquireSecretFromStdin, assertNonEchoingChannel } from '@/db/custody/secret-intake'
import { isAbsentFromThisProcessEnvironment } from '@/db/custody/process-delivery'
import { isInsideRepositoryTree } from '@/scripts/custody/build-sentinel-consumer'
import { AUDITOR_ENV_VAR_NAME } from '@/scripts/custody/n05-sentinel'

describe('the invocation contract is enforced by construction', () => {
  // RC-4's structural note: WCM-C3 can only be satisfied by a contract that
  // binds EVERY invocation. These assert that no caller input reaches argv.
  it('builds a fixed argv that a caller cannot influence', () => {
    const argv = bridgeArgv()
    expect(argv.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ])
    expect(argv).toHaveLength(6)
    // A pure function of nothing returns the same thing twice.
    expect(bridgeArgv()).toEqual(argv)
  })

  it('takes no parameters, so -NonInteractive cannot be dropped by a caller', () => {
    expect(bridgeArgv.length).toBe(0)
  })

  it('encodes the bridge source as UTF-16LE base64, byte for byte', () => {
    const encoded = bridgeArgv()[5]!
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      WCM_BRIDGE_POWERSHELL_SOURCE
    )
  })
})

describe('the bridge source is code and nothing else', () => {
  it('carries no connection string, userinfo pair or credential-shaped literal', () => {
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/postgres(?:ql)?:\/\//i)
    // A URL userinfo segment: something:something@something.
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/\/\/[^\s/'"]+:[^\s/'"]+@/)
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/\bsb_secret_|\bsbp_|\bAIza|\beyJ[A-Za-z0-9_-]{10,}/)
  })

  it('survives embedding in a TypeScript template literal unaltered', () => {
    // A backtick would terminate the literal; a `$`+`{` would interpolate. The
    // source is asserted free of both rather than trusted to stay that way.
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toContain('`')
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toContain('${')
  })

  it('never uses a prohibited delivery mechanism', () => {
    // setx and cmdkey are named prohibitions of N29 and N30: the first writes
    // a persistent user-scope variable, the second puts the value in argv.
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/\bsetx\b/i)
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/\bcmdkey\b/i)
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/SetEnvironmentVariable\s*\(\s*[^,]+,\s*[^,]+,\s*'(User|Machine)'/i)
  })

  it('treats only ERROR_NOT_FOUND as an absence', () => {
    expect(ERROR_NOT_FOUND).toBe(1168)
    // The bridge must compare against the constant, not swallow every failure.
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).toContain('$ERROR_NOT_FOUND = 1168')
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).toContain('present = $null')
  })

  it('binds its P/Invoke signatures in-process and starts no compiler child', () => {
    // Add-Type starts csc.exe and cvtres.exe on every call: processes that live
    // a few milliseconds inside the custody process tree and routinely exit
    // before an external observer can read their command line or environment
    // block. The bridge emits its signatures with Reflection.Emit instead.
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/Add-Type/i)
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).toContain('DefineDynamicAssembly')
    for (const entry of ['CredWriteW', 'CredReadW', 'CredDeleteW', 'CredEnumerateW', 'AttachConsole']) {
      expect(WCM_BRIDGE_POWERSHELL_SOURCE).toContain(`Entry = '${entry}'`)
    }
  })

  it('reads the secret from stdin and never from a parameter', () => {
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).toContain('[Console]::In.ReadLine()')
    expect(WCM_BRIDGE_POWERSHELL_SOURCE).not.toMatch(/param\s*\(/i)
  })
})

describe('the bridge environment allowlist', () => {
  it('does not carry the delivery variable, under any casing', () => {
    for (const name of BRIDGE_ENV_ALLOWLIST) {
      expect(name.toUpperCase()).not.toBe(AUDITOR_ENV_VAR_NAME)
    }
  })

  it('carries no UELLIX or DATABASE variable at all', () => {
    for (const name of BRIDGE_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/UELLIX|DATABASE|URL|SECRET|TOKEN|KEY|PASSWORD/i)
    }
  })

  it('includes TEMP, which PowerShell itself uses', () => {
    // Kept as a control because its absence is a measured past failure: a
    // bridge started without TEMP threw before reaching any operation, and the
    // error surfaced as a CredWriteW failure pointing at a call that never ran.
    expect(BRIDGE_ENV_ALLOWLIST).toContain('TEMP')
  })
})

describe('secret acquisition refuses every echoing channel', () => {
  it('refuses a TTY', () => {
    expect(() => assertNonEchoingChannel({ isTTY: true, argv: [] })).toThrow(CustodyError)
  })

  it('accepts a pipe', () => {
    expect(() => assertNonEchoingChannel({ isTTY: false, argv: [] })).not.toThrow()
  })

  it.each([
    ['--secret=abc', 'a named secret flag'],
    ['--password=abc', 'a named password flag'],
    ['-pass=abc', 'a short password flag'],
    ['--dsn=abc', 'a named dsn flag'],
    ['postgresql://u:not-a-real-password@h:5432/d', 'a bare connection string'],
  ])('refuses %s (%s) already visible in argv', (arg) => {
    expect(() => assertNonEchoingChannel({ isTTY: false, argv: ['node', 'x.js', arg] })).toThrow(
      /process-table-visible|echoing channel/
    )
  })
})

describe('acquireSecretFromStdin', () => {
  const pipe = (s: string): NodeJS.ReadableStream & { isTTY?: boolean } =>
    Object.assign(Readable.from([Buffer.from(s, 'utf8')]), { isTTY: false })

  it('strips exactly one trailing newline and nothing else', async () => {
    const got = await acquireSecretFromStdin(pipe('value-with-  spaces  \r\n'), [])
    expect(got.toString('utf8')).toBe('value-with-  spaces  ')
  })

  it('leaves a value with no trailing newline untouched', async () => {
    const got = await acquireSecretFromStdin(pipe('abc'), [])
    expect(got.toString('utf8')).toBe('abc')
  })

  it('strips only ONE newline, so a value ending in a blank line keeps it', async () => {
    const got = await acquireSecretFromStdin(pipe('abc\n\n'), [])
    expect(got.toString('utf8')).toBe('abc\n')
  })

  it('rejects an empty stream rather than depositing nothing', async () => {
    await expect(acquireSecretFromStdin(pipe(''), [])).rejects.toThrow(/carried no value/)
  })

  it('rejects a value larger than a connection string could be', async () => {
    await expect(acquireSecretFromStdin(pipe('x'.repeat(8193)), [])).rejects.toThrow(
      /larger than 8192 bytes/
    )
  })

  it('returns a Buffer the caller can zero', async () => {
    const got = await acquireSecretFromStdin(pipe('abc'), [])
    expect(Buffer.isBuffer(got)).toBe(true)
    got.fill(0)
    expect(got.toString('utf8')).toBe('\u0000\u0000\u0000')
  })
})

describe('process-scoped delivery never writes this process environment', () => {
  it('reports the delivery variable absent from this process', () => {
    // If this ever fails, some other code has set the auditor variable in the
    // test runner, and every delivery observation in the suite is compromised.
    expect(isAbsentFromThisProcessEnvironment(AUDITOR_ENV_VAR_NAME)).toBe(true)
    expect(process.env[AUDITOR_ENV_VAR_NAME]).toBeUndefined()
  })
})

describe('the out-of-tree requirement', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo'
  const inside = process.platform === 'win32' ? 'C:\\repo\\tmp\\out' : '/repo/tmp/out'
  const outside = process.platform === 'win32' ? 'C:\\other\\out' : '/other/out'

  it('classifies a path inside the tree as inside', () => {
    expect(isInsideRepositoryTree(root, inside)).toBe(true)
    expect(isInsideRepositoryTree(root, root)).toBe(true)
  })

  it('classifies a path outside the tree as outside', () => {
    expect(isInsideRepositoryTree(root, outside)).toBe(false)
  })

  it('does not mistake a sibling directory with a shared prefix for a child', () => {
    const sibling = process.platform === 'win32' ? 'C:\\repo-other\\out' : '/repo-other/out'
    expect(isInsideRepositoryTree(root, sibling)).toBe(false)
  })
})

describe('the platform gate reports a capability, never a verdict', () => {
  it('agrees with process.platform', () => {
    expect(isWindowsCredentialManagerAvailable()).toBe(process.platform === 'win32')
  })
})
