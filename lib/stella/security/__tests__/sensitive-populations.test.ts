// lib/stella/security/__tests__/sensitive-populations.test.ts
// WS3c U1 (RK-08): detector unit corpus — positives per category (ES + EN),
// accent-insensitivity, word-boundary behavior, and no-false-positive cases.

import { describe, it, expect } from 'vitest'
import {
  detectSensitivePopulations,
  SENSITIVE_POPULATION_CATEGORIES,
} from '../sensitive-populations'

function fromText(text: string) {
  return detectSensitivePopulations({ stakeholderTypes: [], texts: [text] })
}

function fromType(type: string) {
  return detectSensitivePopulations({ stakeholderTypes: [type], texts: [] })
}

describe('detectSensitivePopulations', () => {
  // -------------------------------------------------------------------------
  // Positives — minors
  // -------------------------------------------------------------------------
  it('detects minors from "niños" (word start, ñ preserved)', () => {
    expect(fromText('Programa para niños de la comunidad')).toEqual({
      detected: true,
      categories: ['minors'],
    })
  })

  it('detects minors from "niñez"', () => {
    expect(fromText('Protección de la niñez').categories).toEqual(['minors'])
  })

  it('detects minors from "menores de edad"', () => {
    expect(fromText('Atención a menores de edad').categories).toEqual(['minors'])
  })

  it('detects minors from "adolescentes"', () => {
    expect(fromType('adolescentes').categories).toEqual(['minors'])
  })

  it('detects minors from "infancia"', () => {
    expect(fromText('primera infancia').categories).toEqual(['minors'])
  })

  it('detects minors from English "children"', () => {
    expect(fromText('Support for children in rural areas').categories).toEqual(['minors'])
  })

  // -------------------------------------------------------------------------
  // Positives — refugees / displaced
  // -------------------------------------------------------------------------
  it('detects refugees from "refugiados"', () => {
    expect(fromText('Familias refugiadas y refugiados').categories).toEqual(['refugees_displaced'])
  })

  it('detects displaced from "desplazados"', () => {
    expect(fromType('desplazados internos').categories).toEqual(['refugees_displaced'])
  })

  it('detects migrants from "migrantes" and English "migrant"', () => {
    expect(fromText('Población de migrantes').categories).toEqual(['refugees_displaced'])
    expect(fromText('migrant workers program').categories).toEqual(['refugees_displaced'])
  })

  // -------------------------------------------------------------------------
  // Positives — violence victims
  // -------------------------------------------------------------------------
  it('detects violence victims from "víctimas" (accented)', () => {
    expect(fromText('Víctimas del conflicto armado').categories).toEqual(['violence_victims'])
  })

  it('detects violence victims from unaccented "victimas" (accent-insensitive)', () => {
    expect(fromText('victimas de trata').categories).toEqual(['violence_victims'])
  })

  it('detects violence victims from "violencia" and "abuso"', () => {
    expect(fromText('sobrevivientes de violencia intrafamiliar').categories).toEqual(['violence_victims'])
    expect(fromText('prevención del abuso').categories).toEqual(['violence_victims'])
  })

  it('detects violence victims from "GBV" (case-insensitive acronym)', () => {
    expect(fromText('GBV prevention program').categories).toEqual(['violence_victims'])
  })

  // -------------------------------------------------------------------------
  // Positives — health / mental
  // -------------------------------------------------------------------------
  it('detects health from "salud mental" (multi-word, collapsed whitespace)', () => {
    expect(fromText('Apoyo en salud  mental comunitaria').categories).toEqual(['health_conditions'])
  })

  it('detects health from "VIH" and "discapacidad"', () => {
    expect(fromText('Personas con VIH').categories).toEqual(['health_conditions'])
    expect(fromType('personas con discapacidad').categories).toEqual(['health_conditions'])
  })

  it('detects health from "enfermedades"', () => {
    expect(fromText('pacientes con enfermedades crónicas').categories).toEqual(['health_conditions'])
  })

  // -------------------------------------------------------------------------
  // Positives — extreme poverty
  // -------------------------------------------------------------------------
  it('detects extreme poverty from "pobreza extrema"', () => {
    expect(fromText('hogares en pobreza extrema').categories).toEqual(['extreme_poverty'])
  })

  it('detects extreme poverty from "habitante de calle"', () => {
    expect(fromText('atención al habitante de calle').categories).toEqual(['extreme_poverty'])
  })

  // -------------------------------------------------------------------------
  // Multi-category + shape
  // -------------------------------------------------------------------------
  it('returns multiple categories in fixed taxonomy order, deduplicated', () => {
    const result = detectSensitivePopulations({
      stakeholderTypes: ['niños desplazados'],
      texts: ['víctimas de violencia', 'niñez migrante'],
    })
    expect(result.detected).toBe(true)
    expect(result.categories).toEqual(['minors', 'refugees_displaced', 'violence_victims'])
  })

  it('reads signals from stakeholderTypes as well as texts', () => {
    expect(fromType('Niños y adolescentes').detected).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Negatives — no false positives
  // -------------------------------------------------------------------------
  it('does NOT match "campaña" (ñ preserved as distinct letter)', () => {
    expect(fromText('campaña de sensibilización ambiental')).toEqual({
      detected: false,
      categories: [],
    })
  })

  it('does NOT match "ninguna"/"ningún" (accent stripping must not turn niñ into nin)', () => {
    expect(fromText('ninguna organización reportó datos; ningún faltante').detected).toBe(false)
  })

  it('does NOT match keywords mid-word ("compañías", "grandchild-free zone label")', () => {
    expect(fromText('compañías aliadas del sector').detected).toBe(false)
  })

  it('does NOT match generic business text', () => {
    expect(
      fromText('Capacitación en habilidades digitales para emprendedores urbanos').detected,
    ).toBe(false)
  })

  it('does NOT match "empoderamiento" or "comunidades" style prose', () => {
    expect(fromText('Empoderamiento económico de comunidades rurales').detected).toBe(false)
  })

  it('does NOT flag empty, null, or undefined inputs', () => {
    expect(
      detectSensitivePopulations({ stakeholderTypes: [], texts: [null, undefined, ''] }),
    ).toEqual({ detected: false, categories: [] })
    expect(detectSensitivePopulations({ stakeholderTypes: [], texts: [] })).toEqual({
      detected: false,
      categories: [],
    })
  })

  it('is deterministic across repeated calls', () => {
    const a = fromText('niños con VIH en pobreza extrema')
    const b = fromText('niños con VIH en pobreza extrema')
    expect(a).toEqual(b)
    expect(a.categories).toEqual(['minors', 'health_conditions', 'extreme_poverty'])
  })

  it('exports the fixed 5-category taxonomy', () => {
    expect(SENSITIVE_POPULATION_CATEGORIES).toEqual([
      'minors',
      'refugees_displaced',
      'violence_victims',
      'health_conditions',
      'extreme_poverty',
    ])
  })
})
