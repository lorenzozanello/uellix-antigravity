// lib/security/__tests__/deep-redact.test.ts
//
// The walker's two jobs, in tension: reach EVERY string, and change NOTHING
// else. The second is what keeps the Stella citation catalog valid and what
// keeps a Sentry event groupable.

import { describe, it, expect } from 'vitest'
import {
  deepRedact,
  DEEP_REDACT_CIRCULAR_TOKEN,
  DEEP_REDACT_DEPTH_TOKEN,
  DEEP_REDACT_ERROR_TOKEN,
} from '../deep-redact'

const upper = { transform: (text: string) => text.toUpperCase() }

describe('deepRedact — reaches every string', () => {
  it('transforms a bare string', () => {
    expect(deepRedact('hola', upper)).toBe('HOLA')
  })

  it('transforms strings inside nested objects', () => {
    expect(deepRedact({ a: { b: { c: 'hola' } } }, upper)).toEqual({ a: { b: { c: 'HOLA' } } })
  })

  it('transforms strings inside arrays, including arrays of objects', () => {
    const input = { xs: ['uno', { y: 'dos' }, ['tres']] }
    expect(deepRedact(input, upper)).toEqual({ xs: ['UNO', { y: 'DOS' }, ['TRES']] })
  })

  it('transforms the same value in two branches (not treated as a cycle)', () => {
    // A shared reference in a TREE must be redacted at both sites. An
    // implementation that marks nodes permanently as "seen" would emit a
    // circular token for the second, silently dropping real content.
    const shared = { v: 'hola' }
    const out = deepRedact({ left: shared, right: shared }, upper) as {
      left: { v: string }
      right: { v: string }
    }
    expect(out.left.v).toBe('HOLA')
    expect(out.right.v).toBe('HOLA')
  })
})

describe('deepRedact — changes nothing else', () => {
  it('preserves keys, array length, and non-string scalars', () => {
    const input = {
      id: 'abc',
      count: 42,
      ratio: 2.4,
      ok: true,
      missing: null,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
    }
    const out = deepRedact(input, { transform: () => '[X]' })
    expect(out).toEqual({
      id: '[X]',
      count: 42,
      ratio: 2.4,
      ok: true,
      missing: null,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
    })
    expect(Object.keys(out)).toEqual(['id', 'count', 'ratio', 'ok', 'missing', 'items'])
    expect(out.items).toHaveLength(3)
  })

  it('does not mutate the input', () => {
    const input = { a: 'hola', nested: { b: 'chau' } }
    deepRedact(input, upper)
    expect(input).toEqual({ a: 'hola', nested: { b: 'chau' } })
  })

  it('returns non-plain objects by reference rather than reshaping them', () => {
    // A Date walked as a record would come back as `{}`. Sentry timestamps and
    // any Date on a context object have to survive intact.
    const date = new Date('2026-08-16T00:00:00.000Z')
    const out = deepRedact({ at: date }, upper) as { at: Date }
    expect(out.at).toBe(date)
  })

  it('round-trips through JSON with an identical shape', () => {
    const input = { a: 'x', b: [1, 'y', { c: 'z' }], d: null }
    const out = deepRedact(input, upper)
    expect(Object.keys(JSON.parse(JSON.stringify(out)))).toEqual(Object.keys(input))
  })
})

describe('deepRedact — fails closed', () => {
  it('tokenises a leaf whose transform throws, and keeps walking', () => {
    const out = deepRedact(
      { bad: 'boom', good: 'hola' },
      {
        transform: (text) => {
          if (text === 'boom') throw new Error('transform exploded')
          return text.toUpperCase()
        },
      }
    )
    // The raw value must NOT survive, and the rest of the walk must complete.
    expect(out).toEqual({ bad: DEEP_REDACT_ERROR_TOKEN, good: 'HOLA' })
  })

  it('never throws, whatever the transform does', () => {
    expect(() =>
      deepRedact({ a: 'x' }, {
        transform: () => {
          throw new Error('always')
        },
      })
    ).not.toThrow()
  })

  it('tokenises a non-string transform result instead of forwarding it', () => {
    const out = deepRedact({ a: 'x' }, { transform: () => undefined as unknown as string })
    expect(out).toEqual({ a: DEEP_REDACT_ERROR_TOKEN })
  })

  it('breaks cycles', () => {
    const cyclic: Record<string, unknown> = { name: 'raíz' }
    cyclic.self = cyclic
    const out = deepRedact(cyclic, upper) as Record<string, unknown>
    expect(out.name).toBe('RAÍZ')
    expect(out.self).toBe(DEEP_REDACT_CIRCULAR_TOKEN)
  })

  it('bounds depth', () => {
    let deep: Record<string, unknown> = { leaf: 'fondo' }
    for (let i = 0; i < 40; i += 1) deep = { next: deep }
    const out = deepRedact(deep, { ...upper, maxDepth: 5 })
    expect(JSON.stringify(out)).toContain(DEEP_REDACT_DEPTH_TOKEN)
    // Crucially the raw leaf did not survive the cap.
    expect(JSON.stringify(out)).not.toContain('fondo')
  })
})

describe('deepRedact — key-based redaction', () => {
  it('replaces a value wholesale based on its key name', () => {
    const out = deepRedact(
      { authorization: 'anything at all', role: 'advisor' },
      { transform: (t) => t, redactKey: (k) => (k === 'authorization' ? '[GONE]' : null) }
    )
    expect(out).toEqual({ authorization: '[GONE]', role: 'advisor' })
  })

  it('applies at any depth and to non-string values', () => {
    const out = deepRedact(
      { request: { headers: { cookie: { parsed: ['a', 'b'] } } } },
      { transform: (t) => t, redactKey: (k) => (k === 'cookie' ? '[GONE]' : null) }
    )
    expect(out).toEqual({ request: { headers: { cookie: '[GONE]' } } })
  })
})
