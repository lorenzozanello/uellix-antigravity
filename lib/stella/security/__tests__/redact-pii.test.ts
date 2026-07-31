// lib/stella/security/__tests__/redact-pii.test.ts
// WS3 (Fable Moonshot): exhaustive unit tests for the PII redactor,
// including no-false-positive cases (years, amounts, percentages).

import { describe, it, expect } from 'vitest'
import { redactPii } from '../redact-pii'

function kinds(result: ReturnType<typeof redactPii>): Record<string, number> {
  return Object.fromEntries(result.redactions.map((r) => [r.kind, r.count]))
}

describe('redactPii — emails', () => {
  it('redacts a single email address', () => {
    const result = redactPii('Contacto: maria.lopez@ong.org para más datos')
    expect(result.text).not.toContain('maria.lopez@ong.org')
    expect(result.text).toContain('[REDACTED:email]')
    expect(kinds(result)).toEqual({ email: 1 })
  })

  it('redacts multiple emails and counts them', () => {
    const result = redactPii('a@b.com y c.d+tag@sub.dominio.co')
    expect(result.text).not.toContain('a@b.com')
    expect(result.text).not.toContain('c.d+tag@sub.dominio.co')
    expect(kinds(result).email).toBe(2)
  })

  // FIX 4 (audit): non-ASCII local parts and IDN domains.
  it.each([
    'josé.muñoz@fundación.co',
    'ñoño@ejemplo.org',
    'maría-pérez@correo.es',
    'übung@münchen.de',
  ])('redacts unicode email %s', (email) => {
    const result = redactPii(`Escribir a ${email} para coordinar`)
    expect(result.text).not.toContain(email)
    expect(result.text).toContain('[REDACTED:email]')
    expect(kinds(result).email).toBe(1)
  })
})

describe('redactPii — phone numbers', () => {
  it.each([
    '+57 300 123 4567',
    '+573001234567',
    '+57 300-123-4567',
    '+1 555 123 4567',
    '+34 91 123 45 67',
    '(300) 123-4567',
    '300-123-4567',
    '310 456 7890',
  ])('redacts phone %s', (phone) => {
    const result = redactPii(`Llamar al ${phone} en horario laboral`)
    expect(result.text).not.toContain(phone)
    expect(result.text).toContain('[REDACTED:phone]')
    expect(kinds(result).phone).toBe(1)
  })
})

describe('redactPii — Colombian cédulas / NITs / contextual IDs', () => {
  it.each([
    'cédula 1.234.567.890',
    'cedula de ciudadanía 12345678',
    'CC 79456123',
    'C.C. 1032456789',
    'NIT 900.123.456-7',
    'NIT: 900123456',
    'documento 12345678',
    'documento de identidad No. 1020304050',
    'identificación: 1032456789',
    'DNI 12345678',
    'pasaporte AB1234567'.replace('AB', ''), // digits-only passport number with context
    'documento 123456789012',
  ])('redacts %s keeping the context word', (input) => {
    const result = redactPii(`Beneficiario con ${input} registrado`)
    expect(result.text).toContain('[REDACTED:id]')
    expect(result.text).not.toMatch(/\d{6,}/)
    expect(kinds(result).id).toBe(1)
  })

  it('does NOT redact a bare 8-digit number without a context word', () => {
    const result = redactPii('El programa atendió a familias del sector 12345678')
    expect(result.text).toContain('12345678')
    expect(result.redactions).toEqual([])
  })

  // FIX 8 (audit): bare "id" is NOT an identifying context word — internal
  // entity references like "El id 123456 del outcome" must survive.
  it.each([
    'El id 123456 del outcome',
    'el ID 98765432 de la evidencia quedó archivado',
    'run id 20260731123456',
  ])('does NOT redact generic entity id in %j', (input) => {
    const result = redactPii(input)
    expect(result.text).toBe(input)
    expect(result.redactions).toEqual([])
  })
})

describe('redactPii — URLs with credentials', () => {
  it('redacts a URL with embedded user:password', () => {
    const result = redactPii('Datos en https://admin:hunter2@repo.example.com/data.csv archivados')
    expect(result.text).not.toContain('hunter2')
    expect(result.text).toContain('[REDACTED:url-credentials]')
    expect(kinds(result)).toEqual({ 'url-credentials': 1 })
  })

  it('does NOT redact a URL without credentials', () => {
    const result = redactPii('Ver informe en https://example.com/informe-2026')
    expect(result.text).toContain('https://example.com/informe-2026')
    expect(result.redactions).toEqual([])
  })
})

describe('redactPii — no false positives', () => {
  it.each([
    'El proyecto inició en 2026 y termina en 2028',
    'Inversión total de $1.000.000 COP',
    'USD 700000.50 de valor social neto',
    'Un deadweight de 45% y atribución de 30%',
    'Puntaje de preparación: 85/100',
    'SROI 2.96:1 según el motor determinístico',
    'Entre 2020 y 2024 hubo 1200 beneficiarios',
    'La línea 3 del metro transporta 450000 pasajeros',
    'Resolución 2021-0456 del ministerio',
  ])('leaves %j untouched', (input) => {
    const result = redactPii(input)
    expect(result.text).toBe(input)
    expect(result.redactions).toEqual([])
  })
})

describe('redactPii — combinations and edges', () => {
  it('handles multiple kinds at once with aggregated counts', () => {
    const input =
      'María (maria@ong.org, +57 300 123 4567, cédula 1.234.567.890) subió https://user:pass@files.org/x'
    const result = redactPii(input)
    expect(result.text).not.toContain('maria@ong.org')
    expect(result.text).not.toContain('300 123 4567')
    expect(result.text).not.toContain('1.234.567.890')
    expect(result.text).not.toContain('user:pass')
    const k = kinds(result)
    expect(k.email).toBe(1)
    expect(k.phone).toBe(1)
    expect(k.id).toBe(1)
    expect(k['url-credentials']).toBe(1)
  })

  it('returns empty result for empty input', () => {
    expect(redactPii('')).toEqual({ text: '', redactions: [] })
  })

  it('preserves surrounding text exactly', () => {
    const result = redactPii('Antes maria@ong.org después')
    expect(result.text).toBe('Antes [REDACTED:email] después')
  })
})
