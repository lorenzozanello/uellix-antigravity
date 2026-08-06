// db/hosted/artefacts.ts
// TRAIN 5B — the library half of hosted artefact generation.
//
// Split from `scripts/hosted-packages.ts` for a reason the repository already
// learned once: `db/client.ts` used to build its client in the module body, and
// 65 modules importing it captured a database target before any guard could
// run. An entry point that DOES something on import is an entry point that does
// it to everyone who imports it — here, the gate suite imported the script and
// got `process.exit(2)`.
//
// So: this file computes, that file decides what to do with the result.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { generateHostedPackage } from './generate-hosted-package'
import { HOSTED_PACKAGE_MANIFEST } from './hosted-package-manifest'

/** Artefact file name for a package. Never the same as the canonical name. */
export function hostedArtefactName(packageName: string): string {
  return `${packageName}.hosted.sql`
}

export interface HostedArtefact {
  readonly packageName: string
  readonly fileName: string
  readonly sql: string
}

export function hostedArtefactDir(root: string = process.cwd()): string {
  return path.join(root, 'db', 'prepared', 'hosted')
}

/** Regenerates every artefact in memory. Reads sources; writes nothing. */
export function buildHostedArtefacts(root: string = process.cwd()): HostedArtefact[] {
  return HOSTED_PACKAGE_MANIFEST.map((entry) => {
    const canonical = readFileSync(path.join(root, 'db', 'prepared', entry.sourceFile), 'utf8')
    const generated = generateHostedPackage(entry, canonical)
    return {
      packageName: entry.name,
      fileName: hostedArtefactName(entry.name),
      sql: generated.sql,
    }
  })
}
