import { describe, it, expect, vi } from 'vitest'
import { convertToUsd, fetchCopTrmRate } from '@/lib/pipeline/fx'

describe('FX conversion', () => {
  it('converts COP to USD correctly', () => {
    const result = convertToUsd('1000', '4150')
    expect(result).toBe('0.2410')
  })

  it('returns original amount when rate is 1 (USD)', () => {
    const result = convertToUsd('100', '1')
    expect(result).toBe('100.0000')
  })

  it('handles very large amounts without precision loss', () => {
    const largeAmount = '999999999999.99'
    const result = convertToUsd(largeAmount, '4150')
    expect(result).toBe('240963855.4217')
  })

  it('rejects zero or negative rates', () => {
    expect(() => convertToUsd('100', '0')).toThrow('rate_to_usd must be > 0')
    expect(() => convertToUsd('100', '-5')).toThrow('rate_to_usd must be > 0')
  })

  it('converts USD back using the same rate (round-trip)', () => {
    const original = '1000'
    const rate = '4150'
    const inUsd = convertToUsd(original, rate)
    // Convert back: inUsd * rate should equal original (within rounding)
    // Note: float precision limits this to ~0.15 error tolerance
    const backValue = parseFloat(inUsd) * parseFloat(rate)
    expect(Math.abs(backValue - parseFloat(original))).toBeLessThan(1)
  })
})

describe('COP TRM fetching', () => {
  it('returns null on HTTP error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })
    const result = await fetchCopTrmRate('2026-07-01', mockFetch as any)
    expect(result).toBeNull()
  })

  it('returns null on empty response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    })
    const result = await fetchCopTrmRate('2026-07-01', mockFetch as any)
    expect(result).toBeNull()
  })

  it('returns null if valor is missing or invalid', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ vigenciadesde: '2026-07-01', vigenciahasta: '2026-07-02' }],
    })
    const result = await fetchCopTrmRate('2026-07-01', mockFetch as any)
    expect(result).toBeNull()
  })

  it('returns null on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const result = await fetchCopTrmRate('2026-07-01', mockFetch as any)
    expect(result).toBeNull()
  })

  it('parses a valid TRM response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          vigenciadesde: '2026-07-01T00:00:00.000',
          vigenciahasta: '2026-07-02T23:59:59.999',
          valor: '4150.25',
        },
      ],
    })
    const result = await fetchCopTrmRate('2026-07-01', mockFetch as any)
    expect(result).not.toBeNull()
    expect(result?.rateToUsd).toBe('4150.25')
    expect(result?.rateDate).toBe('2026-07-01')
    expect(result?.source).toContain('Superintendencia Financiera')
  })

  it('normalizes date input to ISO string', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          valor: '4150',
        },
      ],
    })

    // Test with Date object
    const dateObj = new Date('2026-07-01T12:34:56Z')
    const result = await fetchCopTrmRate(dateObj, mockFetch as any)

    expect(result?.rateDate).toBe('2026-07-01')
    // Verify URL included the ISO date
    expect(mockFetch).toHaveBeenCalled()
    const callUrl = mockFetch.mock.calls[0][0]
    expect(callUrl).toContain('2026-07-01')
  })

  it('constructs correct Socrata query with vigencia bounds', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ valor: '4150' }],
    })

    await fetchCopTrmRate('2026-07-15', mockFetch as any)

    const callUrl = mockFetch.mock.calls[0][0]
    // Verify the query includes vigenciadesde/vigenciahasta bounds
    expect(callUrl).toContain('vigenciadesde')
    expect(callUrl).toContain('vigenciahasta')
    expect(callUrl).toContain('2026-07-15')
  })
})
