// db/custody/scram-verifier.ts
//
// CLIENT-SIDE POSTGRESQL SCRAM-SHA-256 VERIFIER (owner decision
// N11_PASSWORD_TRANSPORT = CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER).
//
// The route-B mint used to send the new plaintext to the server, which the
// server then hashed. The independent recertification measured that plaintext
// in the CONTEXT line of any LOG message emitted during the nested EXECUTE.
// The fix removes the plaintext from the server boundary: the tool derives the
// verifier PostgreSQL itself would store, and sends ONLY that.
//
// PostgreSQL format (src/common/scram-common.c scram_build_secret):
//   SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>
// with (RFC 5802 / RFC 7677):
//   SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations, 32)
//   ClientKey      = HMAC(SaltedPassword, "Client Key");  StoredKey = SHA-256(ClientKey)
//   ServerKey      = HMAC(SaltedPassword, "Server Key")
//
// WHY THE VERIFIER IS NOT A DIRECTLY USABLE CREDENTIAL. To authenticate, a
// client must send ClientProof = ClientKey XOR HMAC(StoredKey, AuthMessage).
// The verifier holds StoredKey = H(ClientKey), not ClientKey, so it cannot
// produce a proof by itself (preimage of SHA-256). It is NOT a pass-the-hash
// credential the way an md5 verifier is. Two stated limits: (1) StoredKey plus
// a CAPTURED exchange reveals ClientKey (ClientKey = ClientProof XOR
// ClientSignature), and (2) ServerKey lets its holder impersonate the SERVER.
// Measured on disposable PostgreSQL: the verifier string used as a password
// fails (scripts/custody/d1-scram-disposable-proof.ts).
//
// Offline recovery of the plaintext from a disclosed verifier is a brute
// force of PBKDF2 over the plaintext space; the governed entropy is at least
// 32 CSPRNG bytes (capability SECRET_GENERATION_CONTRACT), i.e. >= 2^256.
//
// SASLprep: PostgreSQL normalizes the password with SASLprep before hashing.
// The governed encoding is base64url ([A-Za-z0-9_-]), on which SASLprep is the
// identity; derive() refuses anything else rather than implementing SASLprep.

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

/** PostgreSQL's default (scram_iterations; SCRAM_SHA_256_DEFAULT_ITERATIONS). The server would use this for a plaintext it hashed itself. */
export const SCRAM_ITERATIONS = 4096
/** PostgreSQL's SCRAM_DEFAULT_SALT_LEN. */
export const SCRAM_SALT_BYTES = 16

export const SCRAM_VERIFIER_PATTERN = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/

const hmac = (key: Buffer, msg: string | Buffer): Buffer => createHmac('sha256', key).update(msg).digest()
const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest()

export interface ScramKeys {
  readonly saltedPassword: Buffer
  readonly clientKey: Buffer
  readonly storedKey: Buffer
  readonly serverKey: Buffer
}

/** A password the derivation accepts: base64url only (SASLprep is the identity on it). */
export function assertSaslprepIdentity(password: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new Error('The password is not in the governed base64url alphabet; SASLprep would not be the identity.')
}

export function scramKeys(password: string, salt: Buffer, iterations: number): ScramKeys {
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256')
  const clientKey = hmac(saltedPassword, 'Client Key')
  return { saltedPassword, clientKey, storedKey: sha256(clientKey), serverKey: hmac(saltedPassword, 'Server Key') }
}

export function buildVerifier(salt: Buffer, iterations: number, storedKey: Buffer, serverKey: Buffer): string {
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

/** Derive the verifier PostgreSQL would store for `password`. The salt is fresh CSPRNG bytes unless one is given (tests only). */
export function deriveScramVerifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  assertSaslprepIdentity(password)
  const salt = opts.salt ?? randomBytes(SCRAM_SALT_BYTES)
  const iterations = opts.iterations ?? SCRAM_ITERATIONS
  const k = scramKeys(password, salt, iterations)
  const v = buildVerifier(salt, iterations, k.storedKey, k.serverKey)
  k.saltedPassword.fill(0)
  k.clientKey.fill(0)
  return v
}

export interface ParsedVerifier {
  readonly iterations: number
  readonly salt: Buffer
  readonly storedKey: Buffer
  readonly serverKey: Buffer
}

export function parseVerifier(v: string): ParsedVerifier | null {
  const m = SCRAM_VERIFIER_PATTERN.exec(v)
  if (m === null) return null
  const salt = Buffer.from(m[2]!, 'base64')
  const storedKey = Buffer.from(m[3]!, 'base64')
  const serverKey = Buffer.from(m[4]!, 'base64')
  if (storedKey.length !== 32 || serverKey.length !== 32 || salt.length === 0) return null
  return { iterations: Number(m[1]), salt, storedKey, serverKey }
}

/** Does `password` match `verifier` (recomputing StoredKey and ServerKey)? */
export function verifierMatches(verifier: string, password: string): boolean {
  const p = parseVerifier(verifier)
  if (p === null) return false
  const k = scramKeys(password, p.salt, p.iterations)
  return timingSafeEqual(k.storedKey, p.storedKey) && timingSafeEqual(k.serverKey, p.serverKey)
}
