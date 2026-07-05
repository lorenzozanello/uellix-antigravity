// tests/fx.service.test.ts
// Fase 1a — FX adapter: COP TRM fetch + USD conversion.
// Never hits the real datos.gov.co endpoint — fetch is injected/mocked.

import { describe, it, expect, vi } from 'vitest'
import { convertToUsd, fetchCopTrmRate, COP_TRM_ENDPOINT } from '@/lib/pipeline/fx'

// A minimal Response-like stub for the injected fetch.
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response
}

describe('convertToUsd', () => {
  it('divides amount by rate_to_usd (exact case)', () => {
    // 415810 COP / 4158.1 = 100 USD exactly
    expect(convertToUsd('415810', '4158.1')).toBe('100.0000')
  })

  it('rounds to 4 decimals (HALF_UP) on non-exact division', () => {
    // 1_000_000 / 4158.1 = 240.494456... -> 240.4945 (5th decimal is 5+, rounds up)
    expect(convertToUsd('1000000', '4158.1')).toBe('240.4945')
  })

  it('returns 0.0000 for a zero amount', () => {
    expect(convertToUsd('0', '4158.1')).toBe('0.0000')
  })

  it('throws on a non-positive rate (guards divide-by-zero)', () => {
    expect(() => convertToUsd('100', '0')).toThrow()
  })
})

describe('fetchCopTrmRate', () => {
  const DATE = '2024-06-28'

  it('queries the datos.gov.co TRM endpoint with a vigencia-range where clause', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ valor: '4158.1', unidad: 'COP', vigenciadesde: '2024-06-28T00:00:00.000', vigenciahasta: '2024-06-28T00:00:00.000' }])
    )

    await fetchCopTrmRate(DATE, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const calledUrl = String(fetchImpl.mock.calls[0][0])
    expect(calledUrl).toContain(COP_TRM_ENDPOINT)
    expect(calledUrl).toContain('vigenciadesde')
    expect(calledUrl).toContain('vigenciahasta')
    expect(calledUrl).toContain('2024-06-28')
  })

  it('returns the parsed rate on a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ valor: '4158.1', unidad: 'COP', vigenciadesde: '2024-06-28T00:00:00.000', vigenciahasta: '2024-06-28T00:00:00.000' }])
    )

    const result = await fetchCopTrmRate(DATE, fetchImpl)

    expect(result).not.toBeNull()
    expect(result!.rateToUsd).toBe('4158.1')
    expect(result!.rateDate).toBe('2024-06-28')
    expect(result!.source).toMatch(/TRM/i)
  })

  it('accepts a Date object and normalizes it to YYYY-MM-DD', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ valor: '4148.04', unidad: 'COP', vigenciadesde: '2024-06-29T00:00:00.000', vigenciahasta: '2024-07-02T00:00:00.000' }])
    )

    const result = await fetchCopTrmRate(new Date('2024-06-30T12:00:00.000Z'), fetchImpl)

    expect(String(fetchImpl.mock.calls[0][0])).toContain('2024-06-30')
    expect(result!.rateToUsd).toBe('4148.04')
  })

  it('returns null when the endpoint returns an empty array (no rate for date)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]))
    expect(await fetchCopTrmRate(DATE, fetchImpl)).toBeNull()
  })

  it('returns null on a non-ok HTTP response (never fabricates a rate)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('service down', false, 503))
    expect(await fetchCopTrmRate(DATE, fetchImpl)).toBeNull()
  })

  it('returns null when fetch throws (source unreachable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await fetchCopTrmRate(DATE, fetchImpl)).toBeNull()
  })

  it('returns null when the row is missing valor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ unidad: 'COP', vigenciadesde: '2024-06-28T00:00:00.000', vigenciahasta: '2024-06-28T00:00:00.000' }])
    )
    expect(await fetchCopTrmRate(DATE, fetchImpl)).toBeNull()
  })
})
