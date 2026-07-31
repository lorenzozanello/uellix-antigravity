import { describe, expect, it } from 'vitest'
import {
  ContextualIndexTokenLeakError,
  collectAdvisorOutputTextFields,
  findBareIndexReferenceTokens,
  validateNoIndexReferenceTokens,
} from './validate-no-index-reference-tokens'
import { decodeProviderSourceRefIndexes } from './decode-provider-source-ref-indexes'

const output = (patch: Partial<Record<string, unknown>> = {}) => ({
  step: 'outcomes',
  responseType: 'review',
  summary: 'Resumen sin fugas.',
  findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceFields: [] }],
  suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: [], sourceFields: [] }],
  clarifyingQuestions: [],
  limitations: [],
  requiresHumanReview: true,
  ...patch,
})

describe('findBareIndexReferenceTokens (R4)', () => {
  it.each([
    ['(0)', 'según (0) el outcome está registrado'],
    ['(13)', 'ver (13) para más detalle'],
    ['[2]', 'la evidencia [2] lo indica'],
    ['( 3 )', 'como muestra ( 3 ) arriba'],
  ])('detects the bare token %s when it is a valid catalog index', (_token, text) => {
    expect(findBareIndexReferenceTokens(text, 20).length).toBeGreaterThan(0)
  })

  it('detects mentions of the transport field name itself', () => {
    expect(findBareIndexReferenceTokens('ver sourceRefIndexes para la cita', 0)).toContain('sourceRefIndexes')
  })

  it('ignores parenthesized integers outside the catalog index range (e.g. years)', () => {
    expect(findBareIndexReferenceTokens('Encuesta (2026) registrada', 20)).toEqual([])
    expect(findBareIndexReferenceTokens('ver (5)', 3)).toEqual([])
  })

  it('ignores ordinary text, percentages, and decimals', () => {
    expect(findBareIndexReferenceTokens('El deadweight registrado es 10% (ver evidencia).', 20)).toEqual([])
    expect(findBareIndexReferenceTokens('(1.5) no es un índice', 20)).toEqual([])
    expect(findBareIndexReferenceTokens('', 20)).toEqual([])
  })

  // FIX 3 (option a): unbracketed Spanish index-reference phrasings.
  it.each([
    ['índice 3', 'según el índice 3 hay evidencia'],
    ['indice 3', 'segun el indice 3 hay evidencia'],
    ['fuente 0', 'la fuente 0 respalda esta afirmación'],
    ['referencia 2', 'ver referencia 2 del catálogo'],
    ['Fuente 1', 'Fuente 1 confirma el dato'],
  ])('detects the unbracketed phrase %s when it is a valid catalog index', (_token, text) => {
    expect(findBareIndexReferenceTokens(text, 20).length).toBeGreaterThan(0)
  })

  it('never flags legitimate prose around those words without an in-range integer', () => {
    expect(findBareIndexReferenceTokens('El proxy proviene de una fuente oficial verificable.', 20)).toEqual([])
    expect(findBareIndexReferenceTokens('Se registraron 3 fuentes y 2 referencias.', 20)).toEqual([])
    expect(findBareIndexReferenceTokens('La fuente 2026 del anuario no aplica.', 20)).toEqual([])
    expect(findBareIndexReferenceTokens('ver fuente 5', 3)).toEqual([])
    expect(findBareIndexReferenceTokens('el índice de precios subió', 20)).toEqual([])
  })
})

describe('validateNoIndexReferenceTokens (R4)', () => {
  it('accepts a clean output', () => {
    expect(() => validateNoIndexReferenceTokens(output(), 10)).not.toThrow()
  })

  it.each([
    ['summary', output({ summary: 'Como se ve en (0), falta evidencia.' })],
    ['findings[0].title', output({ findings: [{ id: 'f', severity: 'warning', title: 'Hallazgo (1)', explanation: 'Texto', sourceFields: [] }] })],
    ['findings[0].explanation', output({ findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'La fuente (2) lo confirma.', sourceFields: [] }] })],
    ['suggestions[0].proposedText', output({ suggestions: [{ id: 's', proposedText: 'Usar (0) como referencia.', rationale: 'Razón', missingInformation: [], sourceFields: [] }] })],
    ['suggestions[0].rationale', output({ suggestions: [{ id: 's', proposedText: null, rationale: 'Basado en (3).', missingInformation: [], sourceFields: [] }] })],
    ['suggestions[0].missingInformation[0]', output({ suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: ['Falta (1)'], sourceFields: [] }] })],
    ['clarifyingQuestions[0]', output({ clarifyingQuestions: ['¿Se refiere a (0)?'] })],
    ['limitations[0]', output({ limitations: ['Limitado por (4).'] })],
  ])('rejects a leaked index token in %s', (location, fixture) => {
    let thrown: unknown
    try {
      validateNoIndexReferenceTokens(fixture, 10)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ContextualIndexTokenLeakError)
    expect((thrown as ContextualIndexTokenLeakError).location).toBe(location)
  })

  it('never rejects sourceFields content itself — only free text', () => {
    const fixture = output({
      findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceFields: ['outcomesSnapshot[0].id'] }],
    })
    expect(() => validateNoIndexReferenceTokens(fixture, 10)).not.toThrow()
  })
})

describe('collectAdvisorOutputTextFields', () => {
  it('collects every free-text field with its location', () => {
    const fixture = output({
      clarifyingQuestions: ['¿Pregunta?'],
      limitations: ['Limitación'],
      suggestions: [{ id: 's', proposedText: 'Propuesta', rationale: 'Razón', missingInformation: ['Falta algo'], sourceFields: [] }],
    })
    const locations = collectAdvisorOutputTextFields(fixture).map((entry) => entry.location)
    expect(locations).toEqual([
      'summary',
      'findings[0].title',
      'findings[0].explanation',
      'suggestions[0].proposedText',
      'suggestions[0].rationale',
      'suggestions[0].missingInformation[0]',
      'clarifyingQuestions[0]',
      'limitations[0]',
    ])
  })
})

describe('decodeProviderSourceRefIndexes — post-decode leak gate (R4)', () => {
  const paths = ['narrativeSummary', 'outcomesSnapshot[0].id']
  const raw = (summary: string) => ({
    step: 'outcomes',
    responseType: 'review',
    summary,
    findings: [{ id: 'f', severity: 'warning', title: 'Título', explanation: 'Texto', sourceRefIndexes: [0] }],
    suggestions: [{ id: 's', proposedText: null, rationale: 'Razón', missingInformation: [], sourceRefIndexes: [0] }],
    clarifyingQuestions: [],
    limitations: [],
    requiresHumanReview: true,
  })

  it('rejects an otherwise valid response whose free text leaks an index token', () => {
    expect(() => decodeProviderSourceRefIndexes(raw('La fuente (0) respalda esto.'), paths, 'outcomes'))
      .toThrow(ContextualIndexTokenLeakError)
  })

  it('accepts the same response without the leak', () => {
    expect(() => decodeProviderSourceRefIndexes(raw('La fuente citada respalda esto.'), paths, 'outcomes')).not.toThrow()
  })
})
