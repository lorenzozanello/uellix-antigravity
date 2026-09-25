// tests/custody/d1-tls-trust-root.test.ts
//
// R3-P-CA (manifest amendment v1.0.2; owner decision AC-8,
// CA_TRUST_ROOT_SOURCE = PROJECT_SPECIFIC_SUPABASE_CERTIFICATE). The repository
// copy of the project certificate is the governed trust anchor: exactly the
// bytes, DER and key the owner's download measured, and the ONLY certificate
// the channel binding names. Public material, not a secret.

import { X509Certificate, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { caFileReasons, readChannelBinding } from '@/scripts/custody/d1-mint-operator-evidence'

const ROOT = process.cwd()
const FILE = 'docs/ops/release/FIBDB053_D1_AUDITOR_TLS_TRUST_ROOT_bvyzblhqymxruxdguaee_v1.0.0.crt'
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('R3-P-CA: the pinned project certificate', () => {
  const bytes = readFileSync(join(ROOT, FILE))
  const x = new X509Certificate(bytes)
  it('is byte-for-byte what the owner supplied (raw, DER and SPKI sha256 as measured)', () => {
    expect(sha(bytes)).toBe('700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7')
    expect(sha(x.raw)).toBe('807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa')
    expect(sha(x.publicKey.export({ type: 'spki', format: 'der' }))).toBe('ba332649230ce9a764e4eaf70368f1a9de9ce64bd38424769e24c3fbf8e57acb')
    // LF only: docs/** is eol=lf, so no checkout rewrites the pinned bytes.
    expect(bytes.includes(0x0d)).toBe(false)
  })
  it('is exactly one self-signed CA certificate: Supabase Root 2021 CA, valid until 2031-04-26', () => {
    expect((bytes.toString('latin1').match(/-----BEGIN CERTIFICATE-----/g) ?? []).length).toBe(1)
    expect(x.ca).toBe(true)
    expect(x.subject).toBe(x.issuer)
    expect(x.subject).toContain('CN=Supabase Root 2021 CA')
    expect(x.verify(x.publicKey)).toBe(true)
    expect(new Date(x.validTo).toISOString()).toBe('2031-04-26T10:56:53.000Z')
  })
  it('is what the effective CHANNEL_BINDING pins, and caFileReasons accepts it', () => {
    const { binding, reasons } = readChannelBinding(ROOT)
    expect(reasons).toEqual([])
    expect(binding!.tls).toEqual({
      policy: 'VERIFY_FULL_PINNED_CA',
      ca_file: FILE,
      ca_raw_sha256: sha(bytes),
      ca_der_sha256: sha(x.raw),
      ca_spki_sha256: sha(x.publicKey.export({ type: 'spki', format: 'der' })),
    })
    expect(caFileReasons(ROOT, binding)).toEqual([])
  })
  it('caFileReasons refuses another pin, another file and a missing file', () => {
    const { binding } = readChannelBinding(ROOT)
    expect(caFileReasons(ROOT, { ...binding!, tls: { ...binding!.tls, ca_raw_sha256: 'f'.repeat(64) } }).join(' ')).toMatch(/bytes are not the pinned ones/)
    expect(caFileReasons(ROOT, { ...binding!, tls: { ...binding!.tls, ca_der_sha256: 'f'.repeat(64) } }).join(' ')).toMatch(/DER is not the pinned one/)
    expect(caFileReasons(ROOT, { ...binding!, tls: { ...binding!.tls, ca_spki_sha256: 'f'.repeat(64) } }).join(' ')).toMatch(/key is not the pinned one/)
    expect(caFileReasons(ROOT, { ...binding!, tls: { ...binding!.tls, ca_file: 'docs/ops/release/FIBDB053_D1_AUDITOR_TLS_TRUST_ROOT_absent_v9.9.9.crt' } }).join(' ')).toMatch(/is absent/)
    expect(caFileReasons(ROOT, null)).toEqual(['AC-8: no pinned trust root in CHANNEL_BINDING'])
  })
})
