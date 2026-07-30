import type { RealRunnerScope } from './types'

interface ResumeIdentity { branch: string; head: string; originMainSHA: string; providerMode: string; model: string; caseCatalogHash: string; caseIds: string[]; scope: RealRunnerScope; expectedCalls: number }
export function validateResumeManifest(manifest: Record<string, unknown>, expected: ResumeIdentity): void {
  const keys: Array<keyof ResumeIdentity> = ['branch', 'head', 'originMainSHA', 'providerMode', 'model', 'caseCatalogHash', 'scope', 'expectedCalls']
  for (const key of keys) if (manifest[key] !== expected[key]) throw new Error('RESUME_INTEGRITY_ERROR: incompatible manifest')
  if (!Array.isArray(manifest.caseIds) || manifest.caseIds.join('|') !== expected.caseIds.join('|')) throw new Error('RESUME_INTEGRITY_ERROR: case ids changed')
  if (manifest.schemaProtocol !== 'sourceRefIndexes') throw new Error('RESUME_INTEGRITY_ERROR: schema protocol changed')
  if (manifest.status === 'COMPLETED_PENDING_HUMAN_REVIEW') throw new Error('RESUME_INTEGRITY_ERROR: completed run cannot resume')
  if (typeof manifest.providerCalls !== 'number' || manifest.providerCalls > expected.expectedCalls) throw new Error('RESUME_INTEGRITY_ERROR: provider calls invalid')
}
