import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/**
 * H1 — `recursive: true`, and the reason is a real failure, not tidiness.
 *
 * This was `recursive: false`, which creates the run directory only when its
 * PARENT already exists. `artifacts/stella-contextual-real-runs/` is generated
 * output and is not in the tracked tree, so on a fresh checkout the first real
 * G1-A attempt died with ENOENT before a single provider call — the run failed
 * at the one moment it was hardest to diagnose, after the operator had already
 * exported the acknowledgements.
 *
 * `recursive: true` still does NOT weaken the collision guarantee that
 * `recursive: false` was carrying: the leaf name embeds an ISO timestamp to
 * millisecond precision, and `initializeRunManifest` writes the manifest with
 * `flag: 'wx'`, so re-entering an existing run directory fails there instead of
 * silently appending to someone else's evidence.
 */
export async function createRunArtifacts(outputRoot: string, runLabel: string): Promise<{ directory: string; runId: string }> {
  const directory = join(outputRoot, `${runLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(directory, { recursive: true })
  return { directory, runId: randomUUID() }
}

export async function initializeRunManifest(directory: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFile(join(directory, 'run-manifest.json'), json(manifest), { encoding: 'utf8', flag: 'wx' })
}
