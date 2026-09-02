import { describe, expect, it } from 'vitest'
import {
  decodeProviderSourceRefIndexes,
  InternalSchemaValidationError,
  ProviderOutputContractError,
  ProviderSourceRefIndexesError,
} from './decode-provider-source-ref-indexes'

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
  for (const indexes of [[-1], [1.5], [2], ['0'], ['outcomes'], ['outcomesSnapshot[0].id'], ['SF001']] as unknown[][]) {
    it('fails closed for invalid index transport', () => {
      expect(() => decodeProviderSourceRefIndexes(raw(indexes), paths)).toThrow(ProviderSourceRefIndexesError)
    })
  }
  // U8: duplicate indexes are deduplicated silently; cardinality is capped.
  it('deduplicates repeated indexes silently while preserving first-seen order', () => {
    const decoded = decodeProviderSourceRefIndexes(raw([1, 0, 1, 0, 0]), paths)
    expect(decoded.findings[0].sourceFields).toEqual(['outcomesSnapshot[0].id', 'narrativeSummary'])
    expect(decoded.suggestions[0].sourceFields).toEqual(['outcomesSnapshot[0].id', 'narrativeSummary'])
  })

  it('rejects more than 8 distinct source references per item', () => {
    const manyPaths = Array.from({ length: 12 }, (_, index) => `outcomesSnapshot[${index}].id`)
    const nine = Array.from({ length: 9 }, (_, index) => index)
    expect(() => decodeProviderSourceRefIndexes(raw(nine), manyPaths)).toThrow(ProviderSourceRefIndexesError)
    const eight = Array.from({ length: 8 }, (_, index) => index)
    expect(decodeProviderSourceRefIndexes(raw(eight), manyPaths).findings[0].sourceFields).toHaveLength(8)
  })

  it('applies the cap to distinct references — duplicates beyond 8 raw entries still decode', () => {
    const manyPaths = Array.from({ length: 12 }, (_, index) => `outcomesSnapshot[${index}].id`)
    const duplicated = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1] // 10 raw, 4 distinct
    expect(decodeProviderSourceRefIndexes(raw(duplicated), manyPaths).findings[0].sourceFields).toHaveLength(4)
  })

  it('rejects provider sourceFields and additional properties', () => {
    expect(() => decodeProviderSourceRefIndexes({ ...raw([]), sourceFields: [] }, paths)).toThrow()
    expect(() => decodeProviderSourceRefIndexes({ ...raw([]), findings: [{ ...raw([]).findings[0], sourceFields: [] }] }, paths)).toThrow()
  })

  // Case A (spec section 12): provider translates a canonical step identifier.
  it('canonicalizes a translated step against the trusted expected step, preserves the raw value, and reports the mismatch', () => {
    const value = { ...raw([0]), step: 'narrativa' }; const before = structuredClone(value)
    const decoded = decodeProviderSourceRefIndexes(value, paths, 'narrative')
    expect(decoded.step).toBe('narrative')
    expect(decoded.stepMismatch).toBe(true)
    expect(value).toEqual(before)
    expect(value.step).toBe('narrativa')
  })

  // Case B: provider step already matches the trusted expected step.
  it('reports no mismatch when the provider step matches the expected step', () => {
    const decoded = decodeProviderSourceRefIndexes(raw([0]), paths, 'outcomes')
    expect(decoded.step).toBe('outcomes')
    expect(decoded.stepMismatch).toBe(false)
  })

  it('never adds a translation dictionary: an unrecognized step falls through to schema validation', () => {
    const value = { ...raw([0]), step: 'narrativa' }
    expect(() => decodeProviderSourceRefIndexes(value, paths)).toThrow(InternalSchemaValidationError)
  })

  // Case E: structurally invalid provider-facing output.
  it('classifies a structurally invalid provider response as a provider output contract error', () => {
    expect(() => decodeProviderSourceRefIndexes({}, paths)).toThrow(ProviderOutputContractError)
    expect(() => decodeProviderSourceRefIndexes('not-an-object', paths)).toThrow(ProviderOutputContractError)
    expect(() => decodeProviderSourceRefIndexes({ ...raw([]), step: 42 }, paths)).toThrow(ProviderOutputContractError)
  })

  // Case F: structurally valid but semantically invalid after canonicalization.
  it('classifies a structurally valid but schema-invalid response as an internal schema error', () => {
    expect(() => decodeProviderSourceRefIndexes({ ...raw([]), requiresHumanReview: false }, paths)).toThrow(InternalSchemaValidationError)
  })
})
