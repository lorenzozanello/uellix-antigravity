import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function checkpointState(directory: string, state: Record<string, unknown>): Promise<void> {
  const finalPath = join(directory, 'run-state.json')
  const temporaryPath = `${finalPath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, finalPath)
}

export async function readCheckpoint(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('checkpoint must be an object')
    return parsed as Record<string, unknown>
  } catch { throw new Error('CHECKPOINT_ERROR: invalid checkpoint') }
}
