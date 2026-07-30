import { describe, expect, it } from 'vitest'
import { decodeProviderSourceRefIndexes, ProviderSourceRefIndexesError } from './decode-provider-source-ref-indexes'

const paths = ['narrativeSummary', 'outcomesSnapshot[0].id']
const raw = (indexes: unknown[]) => ({ step: 'outcomes', responseType: 'review', summary: 'Resumen', findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceRefIndexes: indexes }], suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: [], sourceRefIndexes: indexes }], clarifyingQuestions: [], limitations: [], requiresHumanReview: true })

describe('decodeProviderSourceRefIndexes', () => {
  it('maps indexes in order to internal sourceFields without mutating raw output', () => {
    const value = raw([1, 0]); const before = structuredClone(value)
    const decoded = decodeProviderSourceRefIndexes(value, paths)
    expect(decoded.findings[0].sourceFields).toEqual(['outcomesSnapshot[0].id', 'narrativeSummary'])
    expect(decoded.findings[0]).not.toHaveProperty('sourceRefIndexes')
    expect(value).toEqual(before)
  })
  for (const indexes of [[-1], [1.5], [2], ['0'], ['outcomes'], ['outcomesSnapshot[0].id']] as unknown[][]) {
    it('fails closed for invalid index transport', () => {
      expect(() => decodeProviderSourceRefIndexes(raw(indexes), paths)).toThrow(ProviderSourceRefIndexesError)
    })
  }
  it('rejects provider sourceFields and additional properties', () => {
    expect(() => decodeProviderSourceRefIndexes({ ...raw([]), sourceFields: [] }, paths)).toThrow()
    expect(() => decodeProviderSourceRefIndexes({ ...raw([]), findings: [{ ...raw([]).findings[0], sourceFields: [] }] }, paths)).toThrow()
  })
})
