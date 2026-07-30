import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export async function createRunArtifacts(outputRoot: string, runLabel: string): Promise<{ directory: string; runId: string }> {
  const directory = join(outputRoot, `${runLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(directory, { recursive: false })
  return { directory, runId: randomUUID() }
}

export async function initializeRunManifest(directory: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFile(join(directory, 'run-manifest.json'), json(manifest), { encoding: 'utf8', flag: 'wx' })
}
