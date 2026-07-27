// lib/stella/context/__tests__/schema-version.test.ts
// Etapa A1 (STL-A1-003)

import { describe, it, expect } from 'vitest'
import { CONTEXT_SCHEMA_VERSION } from '../schema-version'

describe('CONTEXT_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(CONTEXT_SCHEMA_VERSION)).toBe(true)
    expect(CONTEXT_SCHEMA_VERSION).toBeGreaterThan(0)
  })
})
