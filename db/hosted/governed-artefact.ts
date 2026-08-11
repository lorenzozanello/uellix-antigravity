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
  sha256OfFileContent,
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

/* -------------------------------------------------------------------------- */
/* The one exception, bound to an identity                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY package an operational path may apply from the middle artefact.
 *
 * COMMIT 5.6 (Fable MEDIUM-1). The first version of this rule was a
 * fall-through — "if the package is not in the governed chain, use the
 * `.hosted.sql`" — and a fall-through is a rule about the DEFAULT rather than
 * about the exception. It gives the ungoverned artefact to anything the
 * governed side fails to recognise, which includes the case that matters: a
 * tenth chain package added before its governed artefact is generated. The
 * comment beside it claimed the bootstrap was "named explicitly"; the code did
 * not name it at all.
 *
 * It is an exception on the merits, not a category:
 *   * it has no governed variant, because there is nothing to govern — it is
 *     applied by `postgres` against a project where `uellix_owner` owns nothing
 *     yet, so there is no owner-schema DDL to place in a window;
 *   * it is the package that ends by handing `uellix_bootstrap` over, which is
 *     why its own second pass is PROHIBITED.
 */
export const FIRST_PROVISION_BOOTSTRAP = 'stella_hosted_0001_managed_role_bootstrap'

export type OperationalApplyTarget =
  | {
      readonly kind: 'governed'
      readonly packageName: string
      readonly packageId: string
      readonly relativePath: string
      readonly digest: string
    }
  | {
      readonly kind: 'first-provision-bootstrap'
      readonly packageName: typeof FIRST_PROVISION_BOOTSTRAP
      readonly relativePath: string
    }

/**
 * The file an operational path may name for ONE package — or a refusal.
 *
 * FAIL-CLOSED. There is exactly one branch that yields a non-governed path and
 * it is guarded by string equality against a single constant. Every other
 * package goes through the fenced, pinned resolver, and every way that resolver
 * can fail — unknown package, unreadable file, moved bytes — throws. No failure
 * mode produces the middle artefact.
 */
export function resolveOperationalApplyTarget(
  packageName: string,
  root: string = process.cwd(),
  readFile?: (absolutePath: string) => string,
): OperationalApplyTarget {
  if (packageName === FIRST_PROVISION_BOOTSTRAP) {
    return {
      kind: 'first-provision-bootstrap',
      packageName: FIRST_PROVISION_BOOTSTRAP,
      relativePath: `db/prepared/hosted/${FIRST_PROVISION_BOOTSTRAP}.hosted.sql`,
    }
  }
  const governed = resolveGovernedApplyTarget(packageName, root, readFile)
  return {
    kind: 'governed',
    packageName: governed.packageName,
    packageId: governed.packageId,
    relativePath: governed.relativePath,
    digest: governed.digest,
  }
}

/* -------------------------------------------------------------------------- */
/* Bytes, and nothing else (HARDENING-1)                                       */
/* -------------------------------------------------------------------------- */

export type ArtefactDigestRefusalCode =
  | 'ARTEFACT_DIGEST_MALFORMED'
  | 'ARTEFACT_UNREADABLE'
  | 'ARTEFACT_DIGEST_MISMATCH'

export type ArtefactDigestVerdict =
  | { readonly ok: true; readonly relativePath: string; readonly digest: string }
  | {
      readonly ok: false
      readonly code: ArtefactDigestRefusalCode
      readonly detail: string
    }

/**
 * Whether the bytes on disk are still the bytes the plan authorised.
 *
 * COMMIT 5.6 (Fable HARDENING-1). The plan prints PACKAGE_PATH and
 * PACKAGE_DIGEST, and then a human runs psql — and between those two moments
 * the file is just a file. A regeneration, a stash pop, a half-finished edit or
 * a checkout of another branch all change it silently, and the operator would
 * apply whatever is there against staging inside one transaction.
 *
 * This answers ONE question and returns no authority. There is deliberately no
 * package id in the result, no path resolution, no ledger, no command to run
 * next: a helper that could say "and therefore you may apply it" would be a
 * second place authorisation lives. The digest is compared against a value the
 * CALLER supplies — the one the plan issued — so this cannot re-derive an
 * expectation and agree with itself.
 *
 * LF-normalized, via the same `sha256OfFileContent` the pin uses, so a CRLF
 * checkout does not report a mismatch that is not one.
 */
export function verifyArtefactDigest(inputs: {
  readonly relativePath: string
  readonly expectedDigest: string
  readonly readFile: (relativePath: string) => string
}): ArtefactDigestVerdict {
  if (!/^[0-9a-f]{64}$/.test(inputs.expectedDigest)) {
    return {
      ok: false,
      code: 'ARTEFACT_DIGEST_MALFORMED',
      detail:
        `${JSON.stringify(inputs.expectedDigest)} is not a SHA-256. Copy PACKAGE_DIGEST from the ` +
        `plan exactly; a truncated digest that happened to compare equal would be a check that ` +
        `passes for the wrong reason.`,
    }
  }

  let contents: string
  try {
    contents = inputs.readFile(inputs.relativePath)
  } catch (error) {
    return {
      ok: false,
      code: 'ARTEFACT_UNREADABLE',
      detail:
        `${inputs.relativePath} could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}). An unreadable artefact is not ` +
        `an unchanged one.`,
    }
  }

  const actual = sha256OfFileContent(contents)
  if (actual !== inputs.expectedDigest) {
    return {
      ok: false,
      code: 'ARTEFACT_DIGEST_MISMATCH',
      detail:
        `${inputs.relativePath} no longer hashes to the digest the plan authorised.\n` +
        `  authorised: ${inputs.expectedDigest}\n  on disk:    ${actual}\n` +
        `The file changed after the plan was issued. Do NOT apply it. Re-run authority:verify, ` +
        `then open a NEW attempt and re-measure — a plan authorises specific bytes, not a filename.`,
    }
  }

  return { ok: true, relativePath: inputs.relativePath, digest: actual }
}

/** Re-exported so a caller can catch the fence and pin refusals by type. */
export { GovernedInputRefusal }
