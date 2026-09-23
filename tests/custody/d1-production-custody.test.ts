// @vitest-environment node
// tests/custody/d1-production-custody.test.ts
//
// N30, THE PRODUCTION DEPOSIT, AND THE GOVERNED REMOVAL — ON EVERY PLATFORM.
//
// The vault primitives are replaced by an in-memory fake that records every
// call, so each property below is a property of the production code path and
// not of a Windows host. Nothing here touches a real Credential Manager.
//
// The mutation controls this file carries (lane section 14):
//   depositor argv secret, depositor echo, missing post-write probe, N30 closed
//   without a positive probe, wildcard sweep.

import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const vault = new Map<string, Buffer>()
let probeAfterWriteLies = false
let retrieveCorrupts = false

vi.mock('@/db/custody/wcm-credential-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/custody/wcm-credential-store')>()
  return {
    ...actual,
    probeCredential: vi.fn(async (t: string) => {
      calls.push(`probe:${t}`)
      if (probeAfterWriteLies && vault.has(t)) return false
      return vault.has(t)
    }),
    depositCredential: vi.fn(async (p: { target: string; secret: Buffer }) => {
      calls.push(`deposit:${p.target}`)
      vault.set(p.target, Buffer.from(p.secret))
    }),
    retrieveCredential: vi.fn(async (t: string) => {
      calls.push(`retrieve:${t}`)
      const v = vault.get(t)
      if (v === undefined) return null
      const copy = Buffer.from(v)
      if (retrieveCorrupts) copy[copy.length - 1] ^= 1
      return copy
    }),
    removeCredential: vi.fn(async (t: string) => {
      calls.push(`remove:${t}`)
      return vault.delete(t)
    }),
    sweepCredentials: vi.fn(async (p: string) => {
      calls.push(`sweep:${p}`)
      return []
    }),
  }
})

import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'
import { checkDsnShape, d1AuditorWcmTarget, depositGovernedCredential } from '@/db/custody/production-custody'
import { SWEEPABLE_TARGET_PREFIXES } from '@/db/custody/wcm-credential-store'
import { main as depositMain, parseDepositorArgs } from '@/scripts/custody/d1-n30-deposit'
import { main as removeMain } from '@/scripts/custody/d1-wcm-remove'

// Synthetic, assembled at run time: no credential-shaped literal sits in the file.
const PROD_VALUE = Buffer.from(
  ['postgresql:', '//uellix_auditor:', 'Z'.repeat(43), '@db.', KNOWN_STAGING_PROJECT_REF, '.supabase.co:5432/postgres'].join(''),
  'utf8'
)
const SYN_VALUE = Buffer.from(['postgresql:', '//uellix_auditor:', 'y'.repeat(32), '@unit.invalid:5432/postgres'].join(''), 'utf8')
const SYN_TARGET = `${SWEEPABLE_TARGET_PREFIXES[0]}-UNIT`

function pipe(value: Buffer): Readable & { isTTY?: boolean } {
  return Readable.from([Buffer.concat([value, Buffer.from('\n')])])
}

let written = ''
beforeEach(() => {
  calls.length = 0
  vault.clear()
  probeAfterWriteLies = false
  retrieveCorrupts = false
  written = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    written += typeof c === 'string' ? c : Buffer.from(c).toString('utf8')
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the production entry identity', () => {
  it('is derived from the pinned staging ref and lies outside every sweepable namespace', () => {
    const t = d1AuditorWcmTarget()
    expect(t.endsWith(KNOWN_STAGING_PROJECT_REF)).toBe(true)
    expect(SWEEPABLE_TARGET_PREFIXES.some((p) => t.startsWith(p))).toBe(false)
  })
})

describe('checkDsnShape', () => {
  it('accepts a production-shaped value for the pinned direct host only', () => {
    expect(checkDsnShape(PROD_VALUE, 'production')).toBeNull()
    expect(checkDsnShape(PROD_VALUE, 'synthetic')).not.toBeNull()
  })
  it('accepts a synthetic value only with an .invalid host', () => {
    expect(checkDsnShape(SYN_VALUE, 'synthetic')).toBeNull()
    expect(checkDsnShape(SYN_VALUE, 'production')).not.toBeNull()
  })
  it('refuses another role, whitespace, and two @', () => {
    expect(checkDsnShape(Buffer.from(PROD_VALUE.toString().replace('uellix_auditor', 'postgres')), 'production')).not.toBeNull()
    expect(checkDsnShape(Buffer.concat([PROD_VALUE, Buffer.from(' ')]), 'production')).not.toBeNull()
    expect(checkDsnShape(Buffer.from(PROD_VALUE.toString().replace('Z@', 'Z@x@')), 'production')).not.toBeNull()
  })
})

describe('depositGovernedCredential: exactly one entry, proven by a read of the same scope', () => {
  it('meets N30 exit only after a positive post-write probe and an equal round trip', async () => {
    const r = await depositGovernedCredential({ value: PROD_VALUE, target: d1AuditorWcmTarget(), shape: 'production' })
    expect(r.n30ExitMet).toBe(true)
    const t = d1AuditorWcmTarget()
    expect(calls).toEqual([`probe:${t}`, `deposit:${t}`, `probe:${t}`, `retrieve:${t}`])
  })

  it('CONTROL missing-post-write-probe / N30-closed-without-positive-probe: a probe that reports absent after the write fails N30', async () => {
    probeAfterWriteLies = true
    const r = await depositGovernedCredential({ value: PROD_VALUE, target: d1AuditorWcmTarget(), shape: 'production' })
    expect(r.postWriteProbePresent).toBe(false)
    expect(r.n30ExitMet).toBe(false)
  })

  it('a round trip that returns different bytes fails N30', async () => {
    retrieveCorrupts = true
    const r = await depositGovernedCredential({ value: PROD_VALUE, target: d1AuditorWcmTarget(), shape: 'production' })
    expect(r.roundTripEqual).toBe(false)
    expect(r.n30ExitMet).toBe(false)
  })

  it('refuses to overwrite a pre-existing entry (STOP_N30_ENTRY_ALREADY_PRESENT) and writes nothing', async () => {
    vault.set(d1AuditorWcmTarget(), Buffer.from('old'))
    await expect(depositGovernedCredential({ value: PROD_VALUE, target: d1AuditorWcmTarget(), shape: 'production' })).rejects.toThrow(
      /STOP_N30_ENTRY_ALREADY_PRESENT/
    )
    expect(calls.some((c) => c.startsWith('deposit:'))).toBe(false)
  })

  it('refuses a production deposit into any other target, and a synthetic one outside the sentinel namespace', async () => {
    await expect(depositGovernedCredential({ value: PROD_VALUE, target: SYN_TARGET, shape: 'production' })).rejects.toThrow()
    await expect(depositGovernedCredential({ value: SYN_VALUE, target: d1AuditorWcmTarget(), shape: 'synthetic' })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('never removes and never sweeps', async () => {
    await depositGovernedCredential({ value: PROD_VALUE, target: d1AuditorWcmTarget(), shape: 'production' })
    expect(calls.some((c) => c.startsWith('remove:') || c.startsWith('sweep:'))).toBe(false)
  })
})

describe('the N30 depositor entry point', () => {
  it('CONTROL depositor-argv-secret: refuses any argument except one synthetic target', async () => {
    expect(() => parseDepositorArgs([PROD_VALUE.toString()])).toThrow()
    expect(() => parseDepositorArgs(['--value=x'])).toThrow()
    expect(() => parseDepositorArgs([`--synthetic-target=${SYN_TARGET}`, 'extra'])).toThrow()
    expect(parseDepositorArgs([])).toEqual({ target: d1AuditorWcmTarget(), shape: 'production' })
    await expect(depositMain([PROD_VALUE.toString()], pipe(PROD_VALUE))).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('refuses a terminal on stdin', async () => {
    const tty = Object.assign(pipe(PROD_VALUE), { isTTY: true })
    await expect(depositMain([], tty)).rejects.toThrow(/terminal/)
  })

  it('CONTROL depositor-echo: prints no representation of the value', async () => {
    const code = await depositMain([], pipe(PROD_VALUE))
    expect(code).toBe(0)
    expect(written).not.toContain(PROD_VALUE.toString())
    expect(written).not.toContain(PROD_VALUE.toString('base64'))
    expect(written).not.toContain('Z'.repeat(43))
    expect(JSON.parse(written.trim())).toMatchObject({ node: 'N30', shape: 'production', n30ExitMet: true })
  })

  it('exits non-zero when the post-write probe does not confirm the entry', async () => {
    probeAfterWriteLies = true
    expect(await depositMain([], pipe(PROD_VALUE))).toBe(1)
  })
})

describe('the governed removal entry point', () => {
  it('CONTROL wildcard-sweep: removes the one derived entry by exact name, never by sweep, and proves absence', async () => {
    vault.set(d1AuditorWcmTarget(), Buffer.from('x'))
    expect(await removeMain(['--confirm-remove-d1-auditor-entry'])).toBe(0)
    const t = d1AuditorWcmTarget()
    expect(calls).toEqual([`remove:${t}`, `probe:${t}`])
    expect(JSON.parse(written.trim())).toEqual({ act: 'D1_AUDITOR_WCM_REMOVAL', deleted: true, positiveAbsenceCheck: true })
  })

  it('refuses without the exact confirmation flag', async () => {
    expect(await removeMain([])).toBe(2)
    expect(await removeMain(['--confirm-remove-d1-auditor-entry', '--target=x'])).toBe(2)
    expect(calls).toEqual([])
  })
})
