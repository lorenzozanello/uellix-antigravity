// scripts/custody/synthetic-x509.ts
//
// SYNTHETIC X.509 FOR THE TLS-TRUST CONTROLS (owner decision TLS_TRUST_POLICY =
// VERIFY_FULL_PINNED_CA). A minimal DER builder over node:crypto, so the
// controls can present a server certificate that is correct, from another CA,
// for another host, expired or self-signed, with no dependency and no file of
// key material in the repository: every key is generated in memory per run.
//
// It is scaffolding for tests and for the disposable-PostgreSQL proof. It never
// produces or reads the governed trust root, which is the owner-supplied
// project certificate pinned in the channel authority.

import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n])
  if (n < 0x100) return Buffer.from([0x81, n])
  if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff])
  throw new Error('DER length out of range')
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...x: Buffer[]): Buffer => tlv(0x30, Buffer.concat(x))
const set = (...x: Buffer[]): Buffer => tlv(0x31, Buffer.concat(x))
const int = (buf: Buffer): Buffer => {
  let b = buf
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1)
  if ((b[0]! & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}
const oid = (s: string): Buffer => {
  const p = s.split('.').map(Number)
  const out = [40 * p[0]! + p[1]!]
  for (const n of p.slice(2)) {
    const st: number[] = [n & 0x7f]
    let v = n
    while ((v >>= 7) > 0) st.unshift((v & 0x7f) | 0x80)
    out.push(...st)
  }
  return tlv(0x06, Buffer.from(out))
}
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const bool = (b: boolean): Buffer => tlv(0x01, Buffer.from([b ? 0xff : 0]))
const octet = (b: Buffer): Buffer => tlv(0x04, b)
const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]))
const explicit = (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body)
const time = (d: Date): Buffer => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  const y = d.getUTCFullYear()
  return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${p(y, 4)}${rest}`))
}
const name = (cn: string): Buffer => seq(set(seq(oid('2.5.4.3'), utf8(cn))))
const ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const ext = (id: string, critical: boolean, value: Buffer): Buffer => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value))

export interface SyntheticCert {
  readonly cn: string
  readonly certPem: string
  readonly keyPem: string
  readonly cert: X509Certificate
  readonly key: KeyObject
  /** SHA-256 of the DER certificate, lower-case hex. */
  readonly derSha256: string
}

function pem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n$/, '')
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
}

interface Issue {
  readonly cn: string
  readonly ca: boolean
  readonly dnsNames?: readonly string[]
  readonly notBefore?: Date
  readonly notAfter?: Date
  /** The issuer; absent = self-signed. */
  readonly issuer?: SyntheticCert
}

function issue(o: Issue): SyntheticCert {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  // SubjectKeyIdentifier: SHA-1 of the subjectPublicKey bits (RFC 5280 method 1); the last
  // 65 bytes of a P-256 SPKI are the uncompressed point.
  const ski = createHash('sha1').update(spki.subarray(spki.length - 65)).digest()
  const signer = o.issuer?.key ?? privateKey
  const issuerName = name(o.issuer?.cn ?? o.cn)
  const aki = o.issuer === undefined ? ski : createHash('sha1').update(o.issuer.cert.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)).digest()
  const now = Date.now()
  const nb = o.notBefore ?? new Date(now - 60 * 60 * 1000)
  const na = o.notAfter ?? new Date(now + 24 * 60 * 60 * 1000)
  const extensions = [
    ext('2.5.29.19', true, o.ca ? seq(bool(true)) : seq()),
    // keyUsage: CA = keyCertSign|cRLSign (0x06, 1 unused bit); leaf = digitalSignature (0x80, 7 unused).
    ext('2.5.29.15', true, o.ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
    ext('2.5.29.14', false, octet(ski)),
    ext('2.5.29.35', false, seq(tlv(0x80, aki))),
    ...(o.ca ? [] : [ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1')))]),
    ...(o.dnsNames !== undefined && o.dnsNames.length > 0 ? [ext('2.5.29.17', false, seq(...o.dnsNames.map((d) => tlv(0x82, Buffer.from(d, 'ascii')))))] : []),
  ]
  const tbs = seq(explicit(0, int(Buffer.from([2]))), int(randomBytes(16)), seq(oid(ECDSA_SHA256)), issuerName, seq(time(nb), time(na)), name(o.cn), spki, explicit(3, seq(...extensions)))
  const signature = sign('sha256', tbs, signer)
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), bits(signature))
  const certPem = pem(der)
  return {
    cn: o.cn,
    certPem,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: new X509Certificate(certPem),
    key: privateKey,
    derSha256: createHash('sha256').update(der).digest('hex'),
  }
}

/** A self-signed CA. */
export const syntheticCa = (cn: string, o: { notBefore?: Date; notAfter?: Date } = {}): SyntheticCert => issue({ cn, ca: true, ...o })
/** A server certificate for `dnsNames`, issued by `issuer`. */
export const syntheticLeaf = (issuer: SyntheticCert, dnsNames: readonly string[], o: { notBefore?: Date; notAfter?: Date } = {}): SyntheticCert =>
  issue({ cn: dnsNames[0] ?? 'leaf', ca: false, dnsNames, issuer, ...o })
/** A self-signed server certificate (no CA vouches for it). */
export const selfSignedLeaf = (dnsNames: readonly string[]): SyntheticCert => issue({ cn: dnsNames[0] ?? 'leaf', ca: false, dnsNames })
