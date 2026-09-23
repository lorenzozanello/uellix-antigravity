// @vitest-environment node
// tests/custody/base64-bytes.test.ts
//
// The byte-to-byte base64 codec is on the path of every deposit and every
// retrieval, so it is held to Node's own codec on every length that exercises
// a padding case, and its decoder is shown to REFUSE rather than guess.

import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeBase64Bytes, encodeBase64Bytes } from '@/db/custody/base64-bytes'

describe('encodeBase64Bytes agrees with Node byte for byte', () => {
  it.each([0, 1, 2, 3, 4, 5, 31, 32, 33, 100, 101, 102, 4096])('on %i random bytes', (n) => {
    const input = randomBytes(n)
    expect(encodeBase64Bytes(input).toString('ascii')).toBe(input.toString('base64'))
  })
})

describe('decodeBase64Bytes round-trips and refuses', () => {
  it.each([0, 1, 2, 3, 64, 97])('round-trips %i random bytes', (n) => {
    const input = randomBytes(n)
    expect(decodeBase64Bytes(encodeBase64Bytes(input)).equals(input)).toBe(true)
  })

  it.each([
    ['a length that is not a multiple of four', 'QUJD='],
    ['a character outside the alphabet', 'QU*D'],
    ['padding in the middle', 'QQ==QUJD'],
    ['padding in the third slot with data after it', 'QQ=A'],
  ])('refuses %s', (_label, text) => {
    expect(() => decodeBase64Bytes(Buffer.from(text, 'ascii'))).toThrow()
  })
})
