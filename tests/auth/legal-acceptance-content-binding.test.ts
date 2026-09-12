// tests/auth/legal-acceptance-content-binding.test.ts
//
// CL-1 (HPO-ODS-W2-28) — presentation-binding repair (independent-audit
// continuation). Proves that the content the acceptance page shows is
// NON-VACUOUSLY bound to the exact T2 row being accepted:
//
//   1. computeSelfDescribingDigest / contentMatchesDigest implement the
//      SAME 'sha256:<hex>' shape db/migrations/0070's CHECK constraint pins,
//      so a value this module calls "matching" is one Postgres would also
//      accept as a legal_instrument_versions.content_digest.
//   2. loadRequiredInstrumentsPendingAcceptance excludes — never falls back
//      to an older version for — a required key whose latest applicable
//      version has NULL content_bytes, or bytes that do not verify against
//      content_digest. Both are the SAME fail-closed outcome as an
//      unpublished key: nothing provably bound to that key is offered.
//   3. A version whose content genuinely matches is included with the EXACT
//      instrumentVersionId, locale and digest the row carries — so a
//      submitted acceptance (app/(public)/accept-legal/actions.ts) can only
//      ever reference a version whose displayed content was verified.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecute = vi.fn()
vi.mock('@/db/client', () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}))

import {
  computeSelfDescribingDigest,
  contentMatchesDigest,
  loadRequiredInstrumentsPendingAcceptance,
} from '@/lib/auth/legal-acceptance'

describe('computeSelfDescribingDigest / contentMatchesDigest', () => {
  it('produces the exact shape the T2 CHECK constraint requires: sha256:<64 lowercase hex>', () => {
    const digest = computeSelfDescribingDigest('Términos de ejemplo — v1')
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is deterministic and content-sensitive: one byte of difference changes the digest', () => {
    const a = computeSelfDescribingDigest('Términos de ejemplo — v1')
    const b = computeSelfDescribingDigest('Términos de ejemplo — v1.')
    expect(a).not.toBe(b)
    expect(computeSelfDescribingDigest('Términos de ejemplo — v1')).toBe(a)
  })

  it('contentMatchesDigest is true only for the exact bytes the digest was computed over', () => {
    const bytes = 'Política de privacidad de ejemplo'
    const digest = computeSelfDescribingDigest(bytes)
    expect(contentMatchesDigest(bytes, digest)).toBe(true)
    expect(contentMatchesDigest(bytes + ' (editado)', digest)).toBe(false)
    expect(contentMatchesDigest(bytes, 'sha256:' + '0'.repeat(64))).toBe(false)
  })
})

describe('loadRequiredInstrumentsPendingAcceptance — fail-closed content binding', () => {
  beforeEach(() => {
    mockExecute.mockClear()
  })

  const GENUINE_TEXT = 'Texto sintético de prueba para terms_of_service v3.'
  const GENUINE_DIGEST = computeSelfDescribingDigest(GENUINE_TEXT)

  function row(overrides: Partial<{
    instrument_key: string
    instrument_version_id: string
    version: number
    locale: string
    content_digest: string
    content_bytes: string | null
  }>) {
    return {
      instrument_key: 'terms_of_service',
      instrument_version_id: 'v-1111',
      version: 3,
      locale: 'es',
      content_digest: GENUINE_DIGEST,
      content_bytes: GENUINE_TEXT,
      ...overrides,
    }
  }

  it('includes a version whose retained bytes verify against content_digest, with the exact fields the row carries', async () => {
    mockExecute.mockResolvedValueOnce([row({})])
    const pending = await loadRequiredInstrumentsPendingAcceptance('user-1')
    expect(pending).toEqual([
      {
        instrumentKey: 'terms_of_service',
        instrumentVersionId: 'v-1111',
        version: 3,
        locale: 'es',
        contentDigest: GENUINE_DIGEST,
        content: GENUINE_TEXT,
      },
    ])
  })

  it('EXCLUDES a version with NULL content_bytes — never renders a version it cannot verify', async () => {
    mockExecute.mockResolvedValueOnce([row({ content_bytes: null })])
    const pending = await loadRequiredInstrumentsPendingAcceptance('user-1')
    expect(pending).toEqual([])
  })

  it('EXCLUDES a version whose retained bytes do NOT match content_digest — tampered or corrupted content is refused, not shown', async () => {
    mockExecute.mockResolvedValueOnce([row({ content_bytes: GENUINE_TEXT + ' (silently altered)' })])
    const pending = await loadRequiredInstrumentsPendingAcceptance('user-1')
    expect(pending).toEqual([])
  })

  it('does NOT fall back to an older, presentable version when the latest fails verification — the key is simply not offered', async () => {
    // Only one candidate row per key reaches this function (the SQL query
    // itself picks DISTINCT ON the greatest version per key) — this control
    // pins that the JS layer performs no compensating re-query either.
    mockExecute.mockResolvedValueOnce([row({ content_bytes: null })])
    await loadRequiredInstrumentsPendingAcceptance('user-1')
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('a partial set — one key verifies, the sibling required key has no presentable content — offers ONLY the verified key', async () => {
    mockExecute.mockResolvedValueOnce([
      row({ instrument_key: 'terms_of_service' }),
      row({ instrument_key: 'privacy_policy', instrument_version_id: 'v-2222', content_bytes: null }),
    ])
    const pending = await loadRequiredInstrumentsPendingAcceptance('user-1')
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
  })
})
