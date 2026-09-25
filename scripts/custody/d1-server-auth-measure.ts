// scripts/custody/d1-server-auth-measure.ts
//
// PMR-16 (DAG v1.0.10; owner R4 D): whether the operator channel authenticates
// the PostgreSQL server, MEASURED rather than read from a declaration:
//   - the trust text the pinned tools are rendered from, given the repository
//     copy of the project certificate and its pin, hands the driver verify-full
//     options whose only anchor is that certificate, and refuses another pin or
//     an ambient PG* variable (d1-tls-trust-harness.ts trustTextBehaviourReasons);
//   - the launcher's OC-13 check accepts the pinned bytes and refuses other bytes
//     and a missing file (checkPlannedCa, the function runLauncher calls).
// The certificate's own bytes/DER/SPKI are measured by caFileReasons. What stays
// DECLARED, not measured (the policy name in CHANNEL_BINDING, the authority's
// TLS_TRUST_POLICY statement, the clause ids OC-13/OC-14) is not part of PMR-16:
// PMR-10 (AC-8 mapping) and PMR-11 (clause ids) still compare those declarations.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelBinding } from './d1-mint-operator-evidence'
import { checkPlannedCa } from './d1-mint-operator-launcher'
import { trustTextBehaviourReasons } from './d1-tls-trust-harness'

/** What is measured; production passes nothing (the real functions). A test passes a broken one to prove the measurement sees it. */
export interface ServerAuthSubjects {
  readonly checkCa: typeof checkPlannedCa
  readonly trustText: typeof trustTextBehaviourReasons
}
const REAL_SUBJECTS: ServerAuthSubjects = { checkCa: checkPlannedCa, trustText: trustTextBehaviourReasons }

export function measureServerAuthentication(root: string, binding: ChannelBinding | null, targetHost: string | null, subjects: ServerAuthSubjects = REAL_SUBJECTS): string[] {
  if (binding === null || binding.tls === undefined) return ['PMR-16: no pinned trust root to measure against']
  const caFile = join(root, binding.tls.ca_file)
  const pin = binding.tls.ca_raw_sha256
  const r = subjects.trustText(caFile, pin, targetHost ?? 'db.pmr16.invalid').map((x) => `PMR-16: ${x}`)
  const codeOf = (f: () => void): string | null => {
    try {
      f()
      return null
    } catch (e) {
      return String((e as { code?: string }).code ?? 'UNKNOWN')
    }
  }
  if (codeOf(() => subjects.checkCa({ caFile, caSha256: pin }, (p) => readFileSync(p))) !== null) r.push('PMR-16: the launcher refuses the pinned project certificate')
  if (codeOf(() => subjects.checkCa({ caFile, caSha256: 'f'.repeat(64) }, (p) => readFileSync(p))) !== 'CHANNEL_CA_MISMATCH') r.push('PMR-16: the launcher accepts CA bytes that are not the pin')
  const empty = mkdtempSync(join(tmpdir(), 'd1-pmr16-'))
  try {
    if (codeOf(() => subjects.checkCa({ caFile: join(empty, 'absent.crt'), caSha256: pin }, (p) => readFileSync(p))) !== 'CHANNEL_CA_MISSING') r.push('PMR-16: the launcher accepts a missing CA file')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
  return r
}
