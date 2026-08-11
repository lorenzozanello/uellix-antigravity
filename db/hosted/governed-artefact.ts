// db/hosted/governed-artefact.ts
// COMMIT 5.5 — which artefact an operational path is allowed to name.
//
// ---------------------------------------------------------------------------
// THE INCIDENT
// ---------------------------------------------------------------------------
// T1 was planned correctly against staging and the write failed at
// `grounding_0002_document_versions.hosted.sql:915` with
// «permission denied for schema uellix_grounding». The decision was right; the
// FILE was wrong.
//
// The chain is derived twice, in one direction, and `governed-generator.ts`
// says what each step is for:
//
//   db/prepared/*.sql                            canonical, the source of truth
//     -> rewrite-rules.ts                        what managed Supabase cannot run
//   db/prepared/hosted/*.hosted.sql              the MIDDLE artefact
//     -> governed-generator.ts                   who executes each statement
//   db/prepared/hosted/governed/*.governed.sql   what is applied
//
// The middle artefact keeps the canonical `SET ROLE` / `RESET ROLE`
// bookkeeping, which "assumes a superuser applying the package, which is the
// one thing managed Supabase does not have". It exists so the authority plan
// has something to be resolved AGAINST; it is a derivation input, not a
// deliverable. Fifty-four of its statements — across all nine packages —
// execute DDL as the installer inside a schema owned by uellix_owner. The
// governed artefacts carry none.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A WRAPPER AND NOT A NEW RESOLVER
// ---------------------------------------------------------------------------
// `governed-input.ts` already resolves a governed artefact EXPLICITLY (nine
// ids, no glob), FENCED (refuses any path outside the governed directory) and
// PINNED (refuses bytes that moved after `authority:verify`), and its header
// names this precise hazard: the two files "apply without error against the
// same database, and the difference between them is the entire authority
// model". Commit 5 fenced the certification with it and left the operational
// runners pointing at the middle artefact, deliberately, as deferred work.
//
// This is that deferred work. It adds ONE thing the certification never needed:
// the operational world knows a package by its canonical NAME
// (`grounding_0002_document_versions`) and the governed world knows it by its
// chain POSITION (`T1`). The mapping comes from CHAIN_PACKAGE_FILES, so there
// is no fourth list of package names to drift from the other three.

import {
  GOVERNED_DIRECTORY,
  GovernedInputRefusal,
  resolveGovernedInput,
} from './authority/certification/governed-input'
import { CHAIN_PACKAGE_FILES } from './authority/window-plan'

/** The one directory an operational apply may name. POSIX, repo-relative. */
export const GOVERNED_APPLY_DIRECTORY = GOVERNED_DIRECTORY

export class GovernedArtefactRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'GovernedArtefactRefusal'
  }
}

export interface GovernedApplyTarget {
  /** Chain position, as the authority plan names it: T1..T9. */
  readonly packageId: string
  /** Canonical package name, as the witnesses and the ledger name it. */
  readonly packageName: string
  /** Repo-relative, POSIX. The file the operator applies, unmodified. */
  readonly relativePath: string
  /** SHA-256 of the LF-normalized governed artefact, verified here. */
  readonly digest: string
}

/**
 * The governed artefact for one chain package, or a refusal.
 *
 * Resolution happens BEFORE a plan is issued, so a package whose governed
 * bytes are missing or moved is refused while the operator still has nothing
 * to run — rather than at the moment psql opens a transaction against staging.
 */
export function resolveGovernedApplyTarget(
  packageName: string,
  root: string = process.cwd(),
  readFile?: (absolutePath: string) => string,
): GovernedApplyTarget {
  const entry = CHAIN_PACKAGE_FILES.find((e) => e.sourceFile === `${packageName}.sql`)
  if (entry === undefined) {
    throw new GovernedArtefactRefusal(
      'HOSTED_PACKAGE_NOT_GOVERNED',
      `${packageName} is not one of the nine governed chain packages ` +
        `(${CHAIN_PACKAGE_FILES.map((e) => e.sourceFile.replace(/\.sql$/, '')).join(', ')}). ` +
        `There is no basename fallback and no ungoverned alternative: the middle artefact under ` +
        `db/prepared/hosted/ is a derivation input, and applying it to a managed project runs ` +
        `owner-schema DDL as the installer.`,
    )
  }

  const resolved = resolveGovernedInput(entry.packageId, root, readFile)
  return {
    packageId: resolved.packageId,
    packageName,
    relativePath: resolved.relativePath,
    digest: resolved.actualDigest,
  }
}

/** Re-exported so a caller can catch the fence and pin refusals by type. */
export { GovernedInputRefusal }
