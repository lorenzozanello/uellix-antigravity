// lib/stella/context/__tests__/context-schema-descriptor.test.ts
// Etapa A1.5 (STL-A15-009) — this is the test that fails if
// StellaProjectContext's shape changes without a matching
// CONTEXT_SCHEMA_VERSION bump + new CONTEXT_SCHEMA_HASH_BY_VERSION entry.

import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import {
  CONTEXT_SCHEMA_DESCRIPTOR,
  computeContextSchemaHash,
  getExpectedContextSchemaHash,
  CONTEXT_SCHEMA_HASH_BY_VERSION,
} from '../context-schema-descriptor'
import { CONTEXT_SCHEMA_VERSION } from '../schema-version'

describe('computeContextSchemaHash', () => {
  it('is deterministic', () => {
    expect(computeContextSchemaHash()).toBe(computeContextSchemaHash())
  })

  it('produces a 64-char hex SHA-256 digest', () => {
    expect(computeContextSchemaHash()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the recorded expected hash for the current CONTEXT_SCHEMA_VERSION', () => {
    expect(computeContextSchemaHash()).toBe(getExpectedContextSchemaHash())
  })

  it('has a CONTEXT_SCHEMA_HASH_BY_VERSION entry for the currently-registered version', () => {
    expect(CONTEXT_SCHEMA_HASH_BY_VERSION[CONTEXT_SCHEMA_VERSION]).toBeDefined()
  })

  it('the descriptor never contains runtime-looking values (only short type labels)', () => {
    // A structural label is short and made of identifier-like characters;
    // real values (narratives, IDs, UUIDs) would not fit this shape. This is
    // a smoke check, not a substitute for the satisfies-based compile-time
    // guarantee (see context-schema-descriptor.ts).
    for (const label of Object.values(CONTEXT_SCHEMA_DESCRIPTOR)) {
      expect(label.length).toBeLessThan(400)
      expect(/^[a-zA-Z0-9_<>{}:,?[\]]+$/.test(label)).toBe(true)
    }
  })

  it('detects drift: a manually altered descriptor no longer matches the recorded hash', () => {
    const tamperedDescriptor = { ...CONTEXT_SCHEMA_DESCRIPTOR, projectId: 'uuid' }
    const tamperedHash = createHash('sha256').update(JSON.stringify(tamperedDescriptor)).digest('hex')
    expect(tamperedHash).not.toBe(getExpectedContextSchemaHash())
  })
})
