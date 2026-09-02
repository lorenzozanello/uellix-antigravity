// lib/stella/__tests__/eligibility-hygiene.test.ts
//
// G1-B PRECONDITIONS — P1: THE SAME VALUE MUST NOT BE ELIGIBLE IN ONE LAYER AND
// INELIGIBLE IN THE NEXT.
//
// ---------------------------------------------------------------------------
// DRIFT 1 — THE WHITESPACE API KEY
// ---------------------------------------------------------------------------
// Two places decide whether Stella has a provider key, and they disagreed:
//
//   lib/stella/config.ts          canUseStella = isEnabled && key.length > 0
//   lib/stella/capability-readiness.ts   blocker  = ... key.trim() === ''
//
// A key set to `"   "` — a mis-pasted secret, a trailing newline in a Vercel
// value — is therefore PRESENT to the six Stella server-action gates and ABSENT
// to the readiness table. The consequence is not cosmetic: the action gate is
// the one that decides whether to proceed, so the run continues, mints a
// ticket, RESERVES A QUOTA UNIT, and only then hands `"   "` to Google as an
// API key. The failure surfaces as a provider 4xx after the reservation, not as
// a refusal before it.
//
// `.trim()` is the correct reading in BOTH places: a key that is only
// whitespace is an absent key.
//
// ---------------------------------------------------------------------------
// DRIFT 2 — THE PADDED PROJECT ID
// ---------------------------------------------------------------------------
// `issueGovernedStellaTicket` normalises its project id (`derivedProject`
// trims). `runGovernedStellaOperation` did not. So `" <uuid> "` was ISSUABLE
// (the ticket is welded to the trimmed id) and then UNEXECUTABLE (`isProjectId`
// rejects the padded form, and the request digest is computed over the padded
// string). The posture was fail-closed, which is why this is P1 and not P0 —
// but "eligible here, rejected there" is exactly the shape that turns into a
// tenancy bug the day one of the two layers is made more permissive.
//
// The fix is ONE normaliser, exported once and applied at both ends, so the two
// layers cannot disagree by construction.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeStellaProjectId } from '../operation-ticket/normalize-project-id'

describe('normalizeStellaProjectId', () => {
  it('strips surrounding whitespace', () => {
    expect(normalizeStellaProjectId('  9d8c0412-2782-4d2e-a1df-e2dfa1e0b3aa  '))
      .toBe('9d8c0412-2782-4d2e-a1df-e2dfa1e0b3aa')
  })

  it('rejects the empty and whitespace-only forms as null, not as ""', () => {
    // `null` rather than `''`: an empty string is a VALUE a later layer can
    // carry around and compare, and it compares equal to another empty string.
    // `null` forces the caller to branch.
    expect(normalizeStellaProjectId('')).toBeNull()
    expect(normalizeStellaProjectId('   ')).toBeNull()
    expect(normalizeStellaProjectId('\t\n')).toBeNull()
  })

  it('rejects non-strings without throwing', () => {
    expect(normalizeStellaProjectId(undefined as unknown as string)).toBeNull()
    expect(normalizeStellaProjectId(null as unknown as string)).toBeNull()
    expect(normalizeStellaProjectId(42 as unknown as string)).toBeNull()
  })

  it('changes nothing about an already-canonical id', () => {
    const id = '9d8c0412-2782-4d2e-a1df-e2dfa1e0b3aa'
    expect(normalizeStellaProjectId(id)).toBe(id)
  })
})

describe('both ends of the governed protocol use the same normaliser', () => {
  it('the issuer imports it rather than trimming inline', async () => {
    const { readFileSync } = await import('node:fs')
    const path = (await import('node:path')).default
    const source = readFileSync(
      path.join(process.cwd(), 'lib/stella/operation-ticket/issue-governed-ticket.ts'),
      'utf8'
    )
    expect(source).toContain('normalizeStellaProjectId')
  })

  it('the driver imports it rather than trusting its caller', async () => {
    const { readFileSync } = await import('node:fs')
    const path = (await import('node:path')).default
    const source = readFileSync(
      path.join(process.cwd(), 'lib/stella/operation-ticket/governed-operation.ts'),
      'utf8'
    )
    expect(source).toContain('normalizeStellaProjectId')
  })
})

describe('a whitespace-only GEMINI_API_KEY is an ABSENT key everywhere', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  async function loadWithKey(key: string) {
    vi.resetModules()
    vi.stubEnv('STELLA_ENABLED', 'true')
    vi.stubEnv('STELLA_ADVISOR_ENABLED', 'true')
    vi.stubEnv('GEMINI_API_KEY', key)
    const config = await import('../config')
    const readiness = await import('../capability-readiness')
    return { config, readiness }
  }

  it('canUseStella is false for a whitespace-only key', async () => {
    const { config } = await loadWithKey('   ')
    expect(config.stellaState.canUseStella).toBe(false)
  })

  it('agrees with the readiness table, which already trimmed', async () => {
    const { config, readiness } = await loadWithKey('   ')
    expect(config.stellaState.canUseStella).toBe(
      readiness.isStellaCapabilityReady('advisor')
    )
    expect(readiness.stellaCapabilityBlocker('advisor')).toBe('provider_key_missing')
  })

  it('still reports the key as missing', async () => {
    const { config } = await loadWithKey('   ')
    expect(config.stellaState.missingApiKey).toBe(true)
  })

  it('a real key stays eligible in both layers', async () => {
    const { config, readiness } = await loadWithKey('AIza-not-a-real-key')
    expect(config.stellaState.canUseStella).toBe(true)
    expect(readiness.isStellaCapabilityReady('advisor')).toBe(true)
  })
})
