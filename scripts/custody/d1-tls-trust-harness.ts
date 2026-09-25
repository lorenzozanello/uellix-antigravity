// scripts/custody/d1-tls-trust-harness.ts
//
// THE SERVER-AUTHENTICATION CONTROLS, MEASURED ON REAL TLS (owner decision
// TLS_TRUST_POLICY = VERIFY_FULL_PINNED_CA; operator tool contract OT-18/OT-19).
//
// What runs for real:
//   - node:tls on both ends, with synthetic certificates (synthetic-x509.ts):
//     the right CA, another CA, another host name, an expired certificate and a
//     self-signed one;
//   - the REAL postgres.js 3.4.9 from the repository, which performs the
//     SSLRequest and hands our `ssl` object to tls.connect (measured:
//     connection.js Object.assign(options, ssl), servername = host);
//   - the EXACT trust text both tool templates render (tool-trust-snippet.ts),
//     for the conforming text and for each variant that breaks one guarantee.
//
// The server is a fake PostgreSQL on loopback: after TLS it asks for a
// CLEARTEXT password (the impostor move the recertification measured against
// ssl 'require') and then refuses with 28000. It counts what reached it. No
// tool, no fixture and no real database is involved, so the fake-only guard of
// the tool fixtures stays whole: nothing here can mint or reach a hosted target.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'
import { selfSignedLeaf, syntheticCa, syntheticLeaf, type SyntheticCert } from './synthetic-x509'
import { trustDeclarations, trustPreflight, trustSslExpression, type TrustVariant } from '../../tests/custody/support/tool-trust-snippet'

export type TlsScenario = 'PERMITTED' | 'WRONG_CA' | 'WRONG_HOSTNAME' | 'EXPIRED' | 'UNTRUSTED_SELF_SIGNED' | 'CA_MISSING' | 'CA_MODIFIED' | 'AMBIENT_ENV'
export const TLS_SCENARIOS: readonly TlsScenario[] = ['PERMITTED', 'WRONG_CA', 'WRONG_HOSTNAME', 'EXPIRED', 'UNTRUSTED_SELF_SIGNED', 'CA_MISSING', 'CA_MODIFIED', 'AMBIENT_ENV']

/** The host the synthetic server certificate names (the client connects to it on loopback). */
export const TLS_HARNESS_HOST = 'localhost'
/** Synthetic, never a credential: the fake server asks for it only to show when it would be sent. */
const HARNESS_PASSWORD = 'd1-tls-harness-synthetic-password'

export interface ServerLog {
  connections: number
  sslRequests: number
  tlsEstablished: number
  startupsOverTls: number
  /** PasswordMessages received: the cleartext password reaching whoever asked for it. */
  passwordsReceived: number
}

interface FakeServer {
  readonly port: number
  readonly log: ServerLog
  close(): Promise<void>
}

const errorResponse = (): Buffer => {
  const fields = Buffer.concat([Buffer.from('SFATAL\0'), Buffer.from('VFATAL\0'), Buffer.from('C28000\0'), Buffer.from('Md1 tls harness: no database here\0'), Buffer.from([0])])
  const head = Buffer.alloc(5)
  head.write('E', 0)
  head.writeInt32BE(fields.length + 4, 1)
  return Buffer.concat([head, fields])
}
const cleartextPasswordRequest = (): Buffer => {
  const b = Buffer.alloc(9)
  b.write('R', 0)
  b.writeInt32BE(8, 1)
  b.writeInt32BE(3, 5)
  return b
}

/** A fake PostgreSQL that speaks SSLRequest -> TLS -> asks for a cleartext password -> 28000. */
export async function startFakeTlsPostgres(server: SyntheticCert): Promise<FakeServer> {
  const log: ServerLog = { connections: 0, sslRequests: 0, tlsEstablished: 0, startupsOverTls: 0, passwordsReceived: 0 }
  const sockets = new Set<Socket>()
  const onConnection = (sock: Socket) => {
    log.connections++
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => undefined)
    sock.once('data', (first: Buffer) => {
      if (first.length < 8 || first.readInt32BE(0) !== 8 || first.readInt32BE(4) !== 80877103) {
        sock.destroy()
        return
      }
      log.sslRequests++
      sock.pause()
      sock.write('S', () => {
        const t = new TLSSocket(sock, { isServer: true, key: server.keyPem, cert: server.certPem })
        t.on('error', () => undefined)
        t.on('secure', () => {
          log.tlsEstablished++
        })
        let startup = false
        t.on('data', (buf: Buffer) => {
          if (!startup) {
            startup = true
            log.startupsOverTls++
            t.write(cleartextPasswordRequest())
            return
          }
          if (buf[0] === 0x70) log.passwordsReceived++ // 'p'
          t.end(errorResponse())
        })
      })
    })
  }
  const srv: Server = createServer(onConnection)
  await new Promise<void>((res, rej) => {
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => res())
  })
  const addr = srv.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    port: addr.port,
    log,
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy()
        srv.close(() => res())
      }),
  }
}

export interface TlsTrustOutcome {
  readonly scenario: TlsScenario
  readonly variant: TrustVariant
  /** REFUSED = the trust preflight stopped before any connection; REJECTED = TLS failed; REACHED = the server got a session. */
  readonly outcome: 'REFUSED' | 'REJECTED' | 'REACHED'
  readonly code: string | null
  readonly server: ServerLog
  readonly seen: { verified: boolean; peer: string | null; anchor: string | null }
  readonly pinnedCaDerSha256: string
}

interface Rendered {
  run(host: string): number | { ssl: unknown; seen: { verified: boolean; peer: string | null; anchor: string | null } }
}

/** Evaluate the trust text exactly as rendered into the tools, with its own process/argument view. */
function renderTrust(variant: TrustVariant, env: Record<string, string>, args: Record<string, string>, refused: { code: string | null }): Rendered {
  const body = `${trustDeclarations(variant)}
function run(host) {
  ${trustPreflight(variant)}
  return { ssl: ${trustSslExpression(variant, 'host')}, seen }
}
return { run }`
  const req = createRequire(__filename)
  const f = new Function('require', 'fs', 'createHash', 'process', 'out', 'argOf', body) as (...a: unknown[]) => Rendered
  return f(
    req,
    fs,
    createHash,
    { env },
    (o: { refused?: string }) => {
      refused.code = o.refused ?? null
    },
    (k: string) => args[k]
  )
}

/** One scenario: the fake server, the rendered trust text, and the REAL postgres.js. */
export async function runTlsTrustScenario(root: string, variant: TrustVariant, scenario: TlsScenario): Promise<TlsTrustOutcome> {
  const ca = syntheticCa('d1 tls harness pinned ca')
  const other = syntheticCa('d1 tls harness other ca')
  const leaf =
    scenario === 'WRONG_CA'
      ? syntheticLeaf(other, [TLS_HARNESS_HOST])
      : scenario === 'WRONG_HOSTNAME'
        ? syntheticLeaf(ca, ['db.other-host.invalid'])
        : scenario === 'EXPIRED'
          ? syntheticLeaf(ca, [TLS_HARNESS_HOST], { notBefore: new Date('2020-01-01T00:00:00Z'), notAfter: new Date('2020-01-02T00:00:00Z') })
          : scenario === 'UNTRUSTED_SELF_SIGNED'
            ? selfSignedLeaf([TLS_HARNESS_HOST])
            : syntheticLeaf(ca, [TLS_HARNESS_HOST])
  const dir = mkdtempSync(join(tmpdir(), 'd1-tls-harness-'))
  const caFile = join(dir, 'project-ca.crt')
  if (scenario === 'CA_MODIFIED') writeFileSync(caFile, other.certPem)
  else if (scenario !== 'CA_MISSING') writeFileSync(caFile, ca.certPem)
  const pin = createHash('sha256').update(ca.certPem).digest('hex')
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(scenario === 'AMBIENT_ENV' ? { PGAPPNAME: 'hostile', PGSSLMODE: 'disable', NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}) }
  const refused = { code: null as string | null }
  const trust = renderTrust(variant, env, { '--ca-file=': caFile, '--ca-sha256=': pin }, refused)

  const server = await startFakeTlsPostgres(leaf)
  try {
    const r = trust.run(TLS_HARNESS_HOST)
    if (typeof r === 'number') {
      return { scenario, variant, outcome: 'REFUSED', code: refused.code, server: { ...server.log }, seen: { verified: false, peer: null, anchor: null }, pinnedCaDerSha256: ca.derSha256 }
    }
    const postgres = createRequire(join(root, 'package.json'))('postgres') as (o: Record<string, unknown>) => {
      (s: TemplateStringsArray): Promise<unknown>
      end(o: { timeout: number }): Promise<void>
    }
    const sql = postgres({ host: TLS_HARNESS_HOST, port: server.port, database: 'postgres', username: 'postgres', password: HARNESS_PASSWORD, max: 1, prepare: false, ssl: r.ssl, onnotice: () => undefined, connect_timeout: 10 })
    let code: string | null = null
    try {
      await sql`SELECT 1`
    } catch (e) {
      code = String((e as { code?: string }).code ?? 'UNKNOWN')
    } finally {
      await sql.end({ timeout: 1 }).catch(() => undefined)
    }
    await new Promise((res) => setTimeout(res, 50))
    const outcome = server.log.startupsOverTls > 0 ? 'REACHED' : 'REJECTED'
    return { scenario, variant, outcome, code, server: { ...server.log }, seen: { ...r.seen }, pinnedCaDerSha256: ca.derSha256 }
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** What the CONFORMING text must do in each scenario. */
export function expectedOutcome(scenario: TlsScenario): TlsTrustOutcome['outcome'] {
  return scenario === 'PERMITTED' ? 'REACHED' : scenario === 'CA_MISSING' || scenario === 'CA_MODIFIED' || scenario === 'AMBIENT_ENV' ? 'REFUSED' : 'REJECTED'
}

/** Reasons an outcome breaks OT-18/OT-19 (empty = conforms). The password must reach ONLY the authenticated server. */
export function tlsOutcomeReasons(o: TlsTrustOutcome): string[] {
  const r: string[] = []
  const want = expectedOutcome(o.scenario)
  if (o.outcome !== want) r.push(`${o.scenario}: ${o.outcome}, expected ${want}`)
  if (want === 'REACHED') {
    if (!o.seen.verified || o.seen.anchor !== o.pinnedCaDerSha256) r.push(`${o.scenario}: the verified anchor is not the pinned CA`)
    if (o.server.passwordsReceived !== 1) r.push(`${o.scenario}: the authenticated server did not receive the password exactly once`)
  } else {
    if (o.server.passwordsReceived !== 0) r.push(`${o.scenario}: the password reached an unauthenticated server`)
    if (o.server.startupsOverTls !== 0) r.push(`${o.scenario}: a startup message reached an unauthenticated server`)
  }
  if (want === 'REFUSED' && o.server.connections !== 0) r.push(`${o.scenario}: a connection was opened after the trust preflight should have refused`)
  return r
}

/**
 * R4-N-O456: the trust text's preflight alone, for ONE environment (the pinned CA present and right), so each
 * OT-19 alternative is measured by itself: returns the refusal code, or null when the preflight lets it pass.
 */
export function trustPreflightRefusal(variant: TrustVariant, env: Record<string, string>): string | null {
  const ca = syntheticCa('d1 tls preflight ca')
  const dir = mkdtempSync(join(tmpdir(), 'd1-tls-preflight-'))
  try {
    const caFile = join(dir, 'project-ca.crt')
    writeFileSync(caFile, ca.certPem)
    const refused = { code: null as string | null }
    const r = renderTrust(variant, env, { '--ca-file=': caFile, '--ca-sha256=': createHash('sha256').update(ca.certPem).digest('hex') }, refused).run(TLS_HARNESS_HOST)
    return typeof r === 'number' ? refused.code : null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * D (R5): PMR-16 must behaviorally PROVE hostname verification, not merely that a checkServerIdentity
 * function exists. The built function is invoked with a certificate whose names match the host (it must
 * accept: return falsy) and one whose names do not (it must reject: return truthy). A function that always
 * accepts the peer hostname fails PMR-16.
 */
export function hostnameVerificationReasons(checkServerIdentity: unknown, host: string): string[] {
  if (typeof checkServerIdentity !== 'function') return ['the trust text does not verify the server name (no checkServerIdentity)']
  const call = (cert: Record<string, unknown>): unknown => {
    try {
      return (checkServerIdentity as (h: string, c: unknown) => unknown)(host, cert)
    } catch (e) {
      return e
    }
  }
  const r: string[] = []
  if (call({ subject: { CN: host }, subjectaltname: `DNS:${host}` })) r.push('the trust text rejects a certificate whose name matches the host')
  if (!call({ subject: { CN: 'wrong.d1.invalid' }, subjectaltname: 'DNS:wrong.d1.invalid' })) r.push('the trust text accepts a certificate whose name does not match the host (hostname not verified)')
  return r
}

/**
 * PMR-16: what the CONFORMING trust text DOES with a given CA file and pin (sync, no connection): with the
 * right pin it hands the driver verify-full options whose only anchor is that file; with another pin, or an
 * ambient PG* variable, it refuses. Returns the reasons it does not (empty = it does).
 */
export function trustTextBehaviourReasons(caFile: string, caSha256: string, host: string): string[] {
  const r: string[] = []
  const ok = { code: null as string | null }
  const res = renderTrust('CONFORMING', { PATH: '/bin' }, { '--ca-file=': caFile, '--ca-sha256=': caSha256 }, ok).run(host)
  if (typeof res === 'number') r.push(`the trust text refused the pinned CA (${String(ok.code)})`)
  else {
    const s = res.ssl as { ca?: unknown[]; rejectUnauthorized?: unknown; servername?: unknown; minVersion?: unknown; checkServerIdentity?: unknown }
    const bytes = fs.readFileSync(caFile)
    if (!Array.isArray(s.ca) || s.ca.length !== 1 || !Buffer.isBuffer(s.ca[0]) || !(s.ca[0] as Buffer).equals(bytes)) r.push('the trust text does not hand the driver the pinned CA as its only anchor')
    if (s.rejectUnauthorized !== true) r.push('the trust text does not require a verified chain')
    if (s.servername !== host) r.push('the trust text does not set the server name')
    r.push(...hostnameVerificationReasons(s.checkServerIdentity, host))
    if (s.minVersion !== 'TLSv1.2') r.push('the trust text does not require TLS 1.2 or later')
  }
  const wrong = { code: null as string | null }
  if (renderTrust('CONFORMING', { PATH: '/bin' }, { '--ca-file=': caFile, '--ca-sha256=': 'f'.repeat(64) }, wrong).run(host) !== 2 || wrong.code !== 'CA_PIN_MISMATCH') r.push('the trust text does not refuse a CA file that is not the pinned bytes')
  const amb = { code: null as string | null }
  if (renderTrust('CONFORMING', { PATH: '/bin', PGHOST: 'x' }, { '--ca-file=': caFile, '--ca-sha256=': caSha256 }, amb).run(host) !== 2 || amb.code !== 'AMBIENT_ENVIRONMENT') r.push('the trust text does not refuse an ambient PG* variable')
  return r
}
