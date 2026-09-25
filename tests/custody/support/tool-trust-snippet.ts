// tests/custody/support/tool-trust-snippet.ts
//
// THE TRUST CODE BOTH TOOL TEMPLATES SHARE (owner decisions TLS_TRUST_POLICY =
// VERIFY_FULL_PINNED_CA and CA_TRUST_ROOT_SOURCE = PROJECT_SPECIFIC_SUPABASE_
// CERTIFICATE; operator tool contract OT-18 / OT-19). One text, rendered into
// the mint and the probe template, so the pinned outside tools cannot drift
// apart on how they authenticate the server.
//
//   OT-18  the ONE CA file is read from --ca-file and must match --ca-sha256
//          byte for byte, hold exactly one CA certificate, and be the ONLY
//          trust anchor (`ca` replaces the system store); rejectUnauthorized is
//          true; the hostname is checked by tls.checkServerIdentity; nothing is
//          downloaded.
//   OT-19  the tool refuses to start its work when any ambient variable that
//          steers postgres.js (PG*) or Node's TLS stack is present.
//
// Each TRUST VARIANT breaks exactly one of those, so the TLS harness is shown
// able to fail on each.

export type TrustVariant =
  | 'CONFORMING'
  /** OT-18 broken: ssl 'require' (encrypted, server not authenticated). */
  | 'TLS_REQUIRE'
  /** OT-18 broken: the pinned CA is passed but rejectUnauthorized is false. */
  | 'TLS_NO_VERIFY'
  /** OT-18 broken: the hostname is not verified. */
  | 'TLS_NO_HOSTNAME'
  /** OT-18 broken: no `ca`, so the system trust store decides. */
  | 'TLS_SYSTEM_TRUST'
  /** OT-18 broken: the CA file is used without comparing it with the pin. */
  | 'NO_CA_PIN_CHECK'
  /** OT-19 broken: ambient PG* / TLS variables are not refused. */
  | 'NO_AMBIENT_ENV_CHECK'

export const TRUST_VARIANTS: readonly TrustVariant[] = ['TLS_REQUIRE', 'TLS_NO_VERIFY', 'TLS_NO_HOSTNAME', 'TLS_SYSTEM_TRUST', 'NO_CA_PIN_CHECK', 'NO_AMBIENT_ENV_CHECK']

/** The ambient variables OT-19 refuses (case-insensitive: Windows environment names are). */
export const HOSTILE_AMBIENT_ENV_SOURCE = '^(PG[A-Z0-9_]*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_CONF|OPENSSL_MODULES)$'

/** Declarations: the ambient check, the pinned-CA loader and the TLS options builder. */
export function trustDeclarations(variant: TrustVariant): string {
  const v = (name: TrustVariant, yes: string, no: string): string => (variant === name ? yes : no)
  return `const tls = require('node:tls')
const { X509Certificate } = require('node:crypto')
const HOSTILE_ENV = new RegExp(${JSON.stringify(HOSTILE_AMBIENT_ENV_SOURCE)}, 'i')
const ambientEnvironment = () => Object.keys(process.env).filter((k) => HOSTILE_ENV.test(k)).sort()
const hexOf = (fp) => String(fp || '').replace(/:/g, '').toLowerCase()
function loadPinnedCa(file, pin) {
  let bytes
  try { bytes = fs.readFileSync(file) } catch { return { refused: 'CA_FILE_MISSING' } }
  ${v('NO_CA_PIN_CHECK', '', "if (!/^[0-9a-f]{64}$/.test(pin) || createHash('sha256').update(bytes).digest('hex') !== pin) return { refused: 'CA_PIN_MISMATCH' }")}
  if ((bytes.toString('latin1').match(/-----BEGIN CERTIFICATE-----/g) || []).length !== 1) return { refused: 'CA_NOT_EXACTLY_ONE_CERTIFICATE' }
  let x
  try { x = new X509Certificate(bytes) } catch { return { refused: 'CA_UNPARSEABLE' } }
  if (!x.ca) return { refused: 'CA_NOT_A_CA' }
  return { ca: bytes, anchor: hexOf(x.fingerprint256) }
}
function pinnedTls(ca, host, seen) {
  return {
    ${v('TLS_SYSTEM_TRUST', '', 'ca: [ca],')}
    rejectUnauthorized: ${v('TLS_NO_VERIFY', 'false', 'true')},
    servername: host,
    minVersion: 'TLSv1.2',
    checkServerIdentity: (h, cert) => {
      const e = ${v('TLS_NO_HOSTNAME', 'undefined', 'tls.checkServerIdentity(h, cert)')}
      if (e) return e
      let c = cert
      while (c.issuerCertificate && c.issuerCertificate !== c && c.issuerCertificate.fingerprint256 !== c.fingerprint256) c = c.issuerCertificate
      seen.verified = true
      seen.peer = hexOf(cert.fingerprint256)
      seen.anchor = hexOf(c.fingerprint256)
      return undefined
    },
  }
}`
}

/** Statements at the start of main(), after the argument checks: OT-19 then OT-18. Returns 2 on refusal. */
export function trustPreflight(variant: TrustVariant): string {
  const v = (name: TrustVariant, yes: string, no: string): string => (variant === name ? yes : no)
  return `${v('NO_AMBIENT_ENV_CHECK', '', "const ambient = ambientEnvironment(); if (ambient.length > 0) { out({ refused: 'AMBIENT_ENVIRONMENT', names: ambient }); return 2 }")}
  const pinned = loadPinnedCa(argOf('--ca-file=') || '', argOf('--ca-sha256=') || '')
  if (pinned.refused) { out({ refused: pinned.refused }); return 2 }
  const seen = { verified: false, peer: null, anchor: null }`
}

/** The `ssl` option expression the driver is constructed with. */
export function trustSslExpression(variant: TrustVariant, hostExpr: string): string {
  return variant === 'TLS_REQUIRE' ? "'require'" : `pinnedTls(pinned.ca, ${hostExpr}, seen)`
}
