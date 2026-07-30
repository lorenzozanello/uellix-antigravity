import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecodedResult, RawResponse, RealRunnerSummary } from './types'
import { checkpointState } from './checkpoint'

const files = ['run-manifest.json', 'run-state.json', 'summary.json', 'raw-responses.json', 'decoded-results.json', 'errors.json'] as const
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export async function createRunArtifacts(outputRoot: string, runLabel: string): Promise<{ directory: string; runId: string }> {
  const directory = join(outputRoot, `${runLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(directory, { recursive: false })
  return { directory, runId: randomUUID() }
}

export async function writeRunArtifacts(directory: string, manifest: Record<string, unknown>, state: Record<string, unknown>, summary: RealRunnerSummary, raw: RawResponse[], decoded: DecodedResult[], errors: unknown[]): Promise<void> {
  await writeFile(join(directory, 'run-manifest.json'), json(manifest), 'utf8')
  await checkpointState(directory, state)
  await writeFile(join(directory, 'summary.json'), json(summary), 'utf8')
  await writeFile(join(directory, 'raw-responses.json'), json(raw), 'utf8')
  await writeFile(join(directory, 'decoded-results.json'), json(decoded), 'utf8')
  await writeFile(join(directory, 'errors.json'), json(errors), 'utf8')
  const hashes = Object.fromEntries(await Promise.all(files.map(async (file) => {
    const data = await import('node:fs/promises').then(({ readFile }) => readFile(join(directory, file)))
    return [file, createHash('sha256').update(data).digest('hex')] as const
  })))
  await writeFile(join(directory, 'hashes.json'), json(hashes), 'utf8')
}
