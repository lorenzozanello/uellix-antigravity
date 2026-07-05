// lib/stella/context/build-context-hash.ts
// Shared, privacy-safe context fingerprint for the stella_interactions audit
// trail. Hashes only a stable, non-sensitive subset of the project context —
// no PII, no file paths, no financial values — so the same audit column can be
// populated identically by every Stella role (advisor, validator, composer)
// without leaking anything into the hash input.

import { createHash } from 'crypto'
import type { StellaProjectContext } from './types'

export function buildContextHash(context: StellaProjectContext): string {
  // Privacy-safe stable subset — no PII, no file paths, no financial details
  const input = JSON.stringify({
    projectId: context.projectId,
    organizationId: context.organizationId,
    outcomesCount: context.outcomesSnapshot.length,
    indicatorsCount: context.indicatorsSnapshot.length,
    evidenceCount: context.evidenceTotal,
    proxiesCount: context.proxySummary.length,
    hasCalculation: context.calculationSnapshot !== null,
    sroiRatio: context.calculationSnapshot?.sroiRatio ?? null,
  })
  return createHash('sha256').update(input).digest('hex').slice(0, 64)
}
