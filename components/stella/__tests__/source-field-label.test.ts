// components/stella/__tests__/source-field-label.test.ts
// WS2 (Moonshot) — pure mapper tests: canonical paths → Spanish labels.

import { describe, it, expect } from 'vitest'
import { sourceFieldLabel } from '../source-field-label'

describe('sourceFieldLabel', () => {
  describe('top-level sections', () => {
    it('maps a scalar root path', () => {
      expect(sourceFieldLabel('narrativeSummary')).toBe('Resumen narrativo')
    })

    it('maps projectName', () => {
      expect(sourceFieldLabel('projectName')).toBe('Nombre del proyecto')
    })

    it('maps stakeholderCount', () => {
      expect(sourceFieldLabel('stakeholderCount')).toBe('Cantidad de grupos de interés')
    })
  })

  describe('indexed collection paths', () => {
    it('maps an indexed leaf with 1-based numbering', () => {
      expect(sourceFieldLabel('outcomesSnapshot[0].name')).toBe('Resultados › n.º 1 › nombre')
    })

    it('maps a later index', () => {
      expect(sourceFieldLabel('indicatorsSnapshot[2].unit')).toBe('Indicadores › n.º 3 › unidad')
    })

    it('maps nested object paths', () => {
      expect(sourceFieldLabel('calculationSnapshot.sroiRatio')).toBe('Cálculo › ratio SROI')
    })

    it('maps calculationReadiness branches', () => {
      expect(sourceFieldLabel('calculationReadiness.blockingReasons[0]')).toBe(
        'Preparación del cálculo › razones bloqueantes › n.º 1'
      )
    })

    it('maps proxy fields', () => {
      expect(sourceFieldLabel('proxySummary[1].methodologicalRisk')).toBe(
        'Proxies › n.º 2 › riesgo metodológico'
      )
    })
  })

  describe('.empty sentinel (R1)', () => {
    it('labels an empty root collection as absence', () => {
      expect(sourceFieldLabel('outcomesSnapshot.empty')).toBe('sin datos registrados en Resultados')
    })

    it('labels an empty nested collection as absence', () => {
      expect(sourceFieldLabel('calculationReadiness.warnings.empty')).toBe(
        'sin datos registrados en Preparación del cálculo › advertencias'
      )
    })

    it('labels an empty indexed container', () => {
      expect(sourceFieldLabel('outcomesSnapshot[0].stakeholderGroups.empty')).toBe(
        'sin datos registrados en Resultados › n.º 1 › grupos de interés'
      )
    })
  })

  describe('graceful fallback', () => {
    it('falls back to the raw path for an unknown root', () => {
      expect(sourceFieldLabel('unknownRoot[0].field')).toBe('unknownRoot[0].field')
    })

    it('keeps unknown nested field names verbatim inside a known root', () => {
      expect(sourceFieldLabel('outcomesSnapshot[0].mysteryField')).toBe(
        'Resultados › n.º 1 › mysteryField'
      )
    })

    it('falls back for malformed paths', () => {
      expect(sourceFieldLabel('outcomesSnapshot..name')).toBe('outcomesSnapshot..name')
      expect(sourceFieldLabel('[0].name')).toBe('[0].name')
      expect(sourceFieldLabel('outcomesSnapshot.')).toBe('outcomesSnapshot.')
    })

    it('falls back for the empty string', () => {
      expect(sourceFieldLabel('')).toBe('')
    })

    it('never throws for arbitrary strings', () => {
      expect(() => sourceFieldLabel('a b c $ % &')).not.toThrow()
      expect(sourceFieldLabel('a b c $ % &')).toBe('a b c $ % &')
    })
  })
})
