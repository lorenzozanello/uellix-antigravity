import type { RealRunnerScope } from './types'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface ResumeIdentity { branch: string; head: string; originMainSHA: string; providerMode: string; model: string; caseCatalogHash: string; caseIds: string[]; scope: RealRunnerScope; expectedCalls: number }
export function validateResumeManifest(manifest: Record<string, unknown>, expected: ResumeIdentity): void {
  const keys: Array<keyof ResumeIdentity> = ['branch', 'head', 'originMainSHA', 'providerMode', 'model', 'caseCatalogHash', 'scope', 'expectedCalls']
  for (const key of keys) if (manifest[key] !== expected[key]) throw new Error('RESUME_INTEGRITY_ERROR: incompatible manifest')
  if (!Array.isArray(manifest.caseIds) || manifest.caseIds.join('|') !== expected.caseIds.join('|')) throw new Error('RESUME_INTEGRITY_ERROR: case ids changed')
  if (manifest.schemaProtocol !== 'sourceRefIndexes') throw new Error('RESUME_INTEGRITY_ERROR: schema protocol changed')
  if (manifest.status === 'COMPLETED_PENDING_HUMAN_REVIEW') throw new Error('RESUME_INTEGRITY_ERROR: completed run cannot resume')
  if (typeof manifest.providerCalls !== 'number' || manifest.providerCalls > expected.expectedCalls) throw new Error('RESUME_INTEGRITY_ERROR: provider calls invalid')
}

export interface ResumableArtifacts { manifest: Record<string, unknown>; state: Record<string, unknown>; rawResponses: unknown[]; decodedResults: unknown[]; errors: unknown[] }
async function readObject(path: string): Promise<Record<string, unknown>> {
  try { const value: unknown = JSON.parse(await readFile(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown> } catch { throw new Error('RESUME_INTEGRITY_ERROR: invalid required artifact') }
}
async function readArray(path: string): Promise<unknown[]> {
  try { const value: unknown = JSON.parse(await readFile(path, 'utf8')); if (!Array.isArray(value)) throw new Error(); return value } catch { throw new Error('RESUME_INTEGRITY_ERROR: invalid required artifact') }
}
export async function loadResumableArtifacts(directory: string): Promise<ResumableArtifacts> {
  const root = resolve(directory)
  const [manifest, state, rawResponses, decodedResults, errors] = await Promise.all([
    readObject(join(root, 'run-manifest.json')), readObject(join(root, 'run-state.json')), readArray(join(root, 'raw-responses.json')), readArray(join(root, 'decoded-results.json')), readArray(join(root, 'errors.json')),
  ])
  const seen = new Set<string>()
  for (const item of [...rawResponses, ...decodedResults]) { const id = (item as { caseId?: unknown }).caseId; if (typeof id !== 'string' || seen.has(`${Array.isArray(rawResponses) && rawResponses.includes(item) ? 'raw' : 'decoded'}:${id}`)) throw new Error('RESUME_INTEGRITY_ERROR: duplicate or invalid artifact id'); seen.add(`${Array.isArray(rawResponses) && rawResponses.includes(item) ? 'raw' : 'decoded'}:${id}`) }
  return { manifest, state, rawResponses, decodedResults, errors }
}
