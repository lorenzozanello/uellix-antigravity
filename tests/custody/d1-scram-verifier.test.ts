// tests/custody/d1-scram-verifier.test.ts
//
// R2-P-1: the client-side SCRAM-SHA-256 derivation, against the RFC 7677
// SCRAM-SHA-256 test exchange (section 3), byte for byte. The disposable
// PostgreSQL proof (scripts/custody/d1-scram-disposable-proof.ts) then shows
// PostgreSQL itself accepts the verifier and authenticates the plaintext.

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SCRAM_ITERATIONS, SCRAM_SALT_BYTES, SCRAM_VERIFIER_PATTERN, deriveScramVerifier, parseVerifier, scramKeys, verifierMatches } from '@/db/custody/scram-verifier'

// RFC 7677, section 3.
const RFC = {
  password: 'pencil',
  salt: 'W22ZaJ0SNY7soEsUEjb6gQ==',
  iterations: 4096,
  clientFirstBare: 'n=user,r=rOprNGfwEbeRWgbNEkqO',
  serverFirst: 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
  clientFinalWithoutProof: 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  clientProof: 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
  serverSignature: '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
}

describe('R2-P-1: SCRAM-SHA-256 against RFC 7677', () => {
  const k = scramKeys(RFC.password, Buffer.from(RFC.salt, 'base64'), RFC.iterations)
  const authMessage = `${RFC.clientFirstBare},${RFC.serverFirst},${RFC.clientFinalWithoutProof}`
  it('reproduces the ClientProof of the RFC exchange', () => {
    const clientSignature = createHmac('sha256', k.storedKey).update(authMessage).digest()
    const proof = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) proof[i] = k.clientKey[i]! ^ clientSignature[i]!
    expect(proof.toString('base64')).toBe(RFC.clientProof)
  })
  it('reproduces the ServerSignature of the RFC exchange', () => {
    expect(createHmac('sha256', k.serverKey).update(authMessage).digest('base64')).toBe(RFC.serverSignature)
  })
})

describe('the PostgreSQL verifier format', () => {
  const pw = 'A_b-9'.repeat(9) // base64url alphabet, 45 chars
  const v = deriveScramVerifier(pw)
  it('is SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey> with the server defaults', () => {
    expect(v).toMatch(SCRAM_VERIFIER_PATTERN)
    const p = parseVerifier(v)!
    expect(p.iterations).toBe(SCRAM_ITERATIONS)
    expect(p.salt.length).toBe(SCRAM_SALT_BYTES)
    expect(p.storedKey.length).toBe(32)
    expect(p.serverKey.length).toBe(32)
  })
  it('matches the plaintext it came from and no other; never contains it', () => {
    expect(verifierMatches(v, pw)).toBe(true)
    expect(verifierMatches(v, `${pw}x`)).toBe(false)
    expect(v.includes(pw)).toBe(false)
  })
  it('uses a fresh salt each time', () => {
    expect(deriveScramVerifier(pw)).not.toBe(v)
  })
  it('refuses a password outside the governed base64url alphabet (SASLprep would not be the identity)', () => {
    expect(() => deriveScramVerifier('pässword')).toThrow()
    expect(() => deriveScramVerifier('has space')).toThrow()
  })
  it('a malformed verifier is not parsed and matches nothing', () => {
    for (const bad of ['md5abc', 'SCRAM-SHA-256$4096:c2FsdA==$short:short', `${v}x`]) {
      expect(parseVerifier(bad)).toBeNull()
      expect(verifierMatches(bad, pw)).toBe(false)
    }
  })
})
