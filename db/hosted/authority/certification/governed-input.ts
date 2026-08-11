// db/hosted/authority/certification/governed-input.ts
// COMMIT 5 — what the engine certification is allowed to execute, and nothing else.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE RESOLVER AND NOT A FLAG ON THE EXISTING RUNNER
// ---------------------------------------------------------------------------
// COMMIT 5.5 — HISTORICAL NOTE, KEPT BECAUSE IT PREDICTED THE INCIDENT.
//
// This header used to say that the operational runners in db/hosted/** still
// resolve `db/prepared/hosted/<name>.hosted.sql` — the UNGOVERNED middle
// artefact — and that leaving them was correct for that commit. The reasoning
// below about WHY that file is dangerous was exactly right; the estimate of how
// long it could safely be deferred was not. The chain operator boundary
// formatted that path, an operator ran it against staging, and T1 died at
// «permission denied for schema uellix_grounding» — the first of fifty-four
// statements that would run owner-schema DDL as the installer.
//
// The operational runners now resolve through `db/hosted/governed-artefact.ts`,
// which delegates here. There is one resolver.
//
// The original point stands and is why: a certification harness that shared the
// operational resolution would
// be one basename away from certifying the wrong file. `.hosted.sql` and
// `.governed.sql` differ by one path segment and one suffix; they apply without
// error against the same database; and the difference between them is the
// entire authority model. A run that silently used the first would produce a
// green report about an artefact nobody is shipping.
//
// So resolution here is:
//
//   * EXPLICIT. Nine package ids, each mapped to one path. No glob, no
//     directory scan, no "find the file whose basename matches".
//   * FENCED. Any path that does not sit under `db/prepared/hosted/governed/`
//     is refused before it is read, let alone executed.
//   * PINNED. The bytes must hash to the digest in GOVERNED_PINS. A file edited
//     on disk after `authority:verify` ran is refused here too, because the
//     gate that regenerates and the harness that executes are different moments
//     and a source pin is what joins them.
//
// Every refusal happens BEFORE any SQL reaches a server. That ordering is the
// property being asserted, not an implementation detail: "it would have failed
// anyway once PostgreSQL saw it" is not a safety argument when the statements
// in question are ownership transfers inside an open transaction.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { GOVERNED_PINS } from '../governed-manifest'
import { governedArtefactName } from '../governed-generator'
import { CHAIN_PACKAGE_FILES } from '../window-plan'

/** The one directory a certification input may come from. POSIX, repo-relative. */
export const GOVERNED_DIRECTORY = 'db/prepared/hosted/governed'

/** The fence. A resolved path must contain this segment, spelled exactly. */
export const GOVERNED_PATH_SEGMENT = '/governed/'

export type GovernedInputRefusalCode =
  | 'CERT_UNKNOWN_PACKAGE'
  | 'CERT_PATH_NOT_GOVERNED'
  | 'CERT_ARTEFACT_UNREADABLE'
  | 'CERT_DIGEST_MISMATCH'
  | 'CERT_PIN_MISSING'

export class GovernedInputRefusal extends Error {
  readonly code: GovernedInputRefusalCode

  constructor(code: GovernedInputRefusalCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'GovernedInputRefusal'
    this.code = code
  }
}

export interface GovernedCertificationInput {
  readonly packageId: string
  /** Repo-relative, POSIX. What the harness prints before it applies. */
  readonly relativePath: string
  /** The pinned SHA-256 of the LF-normalized governed artefact. */
  readonly expectedDigest: string
}

/**
 * The nine inputs, in chain order, derived rather than transcribed.
 *
 * Order comes from CHAIN_PACKAGE_FILES and the digests from GOVERNED_PINS, so
 * there is no fourth list of package names to drift from the other three.
 */
export const GOVERNED_CERTIFICATION_INPUTS: readonly GovernedCertificationInput[] =
  CHAIN_PACKAGE_FILES.map((entry) => {
    const pin = GOVERNED_PINS.find((p) => p.packageId === entry.packageId)
    if (pin === undefined) {
      throw new GovernedInputRefusal(
        'CERT_PIN_MISSING',
        `${entry.packageId} is in the chain but has no governed pin. An unpinned package cannot be certified: there would be nothing to compare the bytes against.`,
      )
    }
    return {
      packageId: entry.packageId,
      relativePath: `${GOVERNED_DIRECTORY}/${governedArtefactName(entry.sourceFile)}`,
      expectedDigest: pin.generatedDigest,
    }
  })

export function sha256OfFileContent(contents: string): string {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export interface ResolvedGovernedInput extends GovernedCertificationInput {
  readonly absolutePath: string
  readonly sql: string
  readonly actualDigest: string
}

/**
 * Refuses any path that is not inside the governed directory.
 *
 * Separated out and exported because this is the check section 22 of the
 * certification brief exercises directly: point the harness at
 * `db/prepared/hosted/<package>.hosted.sql` and it must refuse BEFORE SQL
 * execution. Comparing normalized POSIX separators, because on Windows the
 * same path arrives spelled with backslashes and a fence that can be walked
 * around by a separator is not a fence.
 */
export function assertGovernedPath(candidate: string): void {
  const normalized = candidate.replace(/\\/g, '/')
  if (!normalized.includes(GOVERNED_PATH_SEGMENT)) {
    throw new GovernedInputRefusal(
      'CERT_PATH_NOT_GOVERNED',
      `${candidate} is not under ${GOVERNED_DIRECTORY}. The ungoverned artefact under db/prepared/hosted/ applies without error against the same database and carries a DIFFERENT authority model — it is what the operational runners still use, and certifying it would produce a green report about a file nobody is shipping.`,
    )
  }
}

/**
 * Resolves ONE package to bytes that may be executed.
 *
 * `readFile` is a parameter so the refusals can be exercised without writing
 * corrupted artefacts into the repository — the same reason `classifyPackage`
 * takes its registry and `verifyStagingTarget` its denylist.
 */
export function resolveGovernedInput(
  packageId: string,
  root: string = process.cwd(),
  readFile: (absolutePath: string) => string = (p) => readFileSync(p, 'utf8'),
  inputs: readonly GovernedCertificationInput[] = GOVERNED_CERTIFICATION_INPUTS,
): ResolvedGovernedInput {
  const input = inputs.find((i) => i.packageId === packageId)
  if (input === undefined) {
    throw new GovernedInputRefusal(
      'CERT_UNKNOWN_PACKAGE',
      `${packageId} is not one of the nine governed chain packages (${inputs.map((i) => i.packageId).join(', ')}). There is no basename fallback here on purpose.`,
    )
  }

  const absolutePath = path.resolve(root, input.relativePath)
  assertGovernedPath(absolutePath)

  let sql: string
  try {
    sql = readFile(absolutePath)
  } catch (error) {
    throw new GovernedInputRefusal(
      'CERT_ARTEFACT_UNREADABLE',
      `${input.relativePath} could not be read (${error instanceof Error ? error.message : String(error)}). An unreadable artefact is not an absent one, and the harness will not substitute anything for it.`,
    )
  }

  const actualDigest = sha256OfFileContent(sql)
  if (actualDigest !== input.expectedDigest) {
    throw new GovernedInputRefusal(
      'CERT_DIGEST_MISMATCH',
      `${input.relativePath} does not match its pin.\n  pinned: ${input.expectedDigest}\n  actual: ${actualDigest}\nThe artefact on disk moved after it was generated and verified. Re-run \`pnpm authority:verify\`; do not apply this.`,
    )
  }

  return { ...input, absolutePath, sql, actualDigest }
}

/** Resolves the whole chain, in order, before a single package is applied. */
export function resolveGovernedChainInputs(
  root: string = process.cwd(),
  readFile?: (absolutePath: string) => string,
): ResolvedGovernedInput[] {
  return GOVERNED_CERTIFICATION_INPUTS.map((i) => resolveGovernedInput(i.packageId, root, readFile))
}
