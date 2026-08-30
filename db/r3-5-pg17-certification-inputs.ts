// db/r3-5-pg17-certification-inputs.ts
//
// Immutable integrity metadata for the one MSC-07B R3.5 PostgreSQL 17
// certification profile. This module is deliberately not a SQL runner, not a
// package-order manifest, and accepts no path, package, image, or target from
// a caller.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { R3_4_LOCAL_PHASES, type R3_4LocalPhase } from './r3-4-governed-runner'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const PREPARED_DIRECTORY = resolve(REPOSITORY_ROOT, 'db', 'prepared')
const R8_TERMINAL_PHASE_FILE = 'stella_0004_role_separation.sql'

/** Exact local image observed in MSC-07B.8-R7A; tags alone are not sufficient. */
export const R3_5_PG17_CERTIFICATION_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143'
export const R3_5_PG17_CERTIFICATION_IMAGE_ID =
  'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453'

/** Deterministically names only the frozen R3.5 candidate certification container. */
export const R3_5_PG17_CERTIFICATION_CONTAINER = 'uellix-msc07b-r3-5-pg17-d8fba7f2'
export const R3_5_PG17_CERTIFICATION_OWNER_LABEL = 'io.uellix.certification-profile'
export const R3_5_PG17_CERTIFICATION_OWNER_VALUE = 'msc-07b-r3-5-pg17-d8fba7f2'

/**
 * The sole package-order authority. Kept as a referential export so audit tests
 * prove the certification prefix originates in R3.4 instead of a copied list.
 */
export const R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY = R3_4_LOCAL_PHASES

const r8TerminalIndex = R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY.findIndex(
  (phase) => phase.file === R8_TERMINAL_PHASE_FILE,
)

if (r8TerminalIndex < 0) {
  throw new Error(`R3.5 PG17 certification cannot find required R3.4 phase: ${R8_TERMINAL_PHASE_FILE}`)
}

/**
 * The deterministic R8 prefix, structurally derived from R3.4. There is no
 * second package-order list in this module.
 */
export const R3_5_PG17_CERTIFICATION_PHASES: readonly R3_4LocalPhase[] = Object.freeze(
  R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY.slice(0, r8TerminalIndex + 1),
)

/**
 * Every source byte that the certification applies or rolls back. The two R3.5
 * rollback hashes are carried alongside the fixed forward prefix because the
 * R8 matrix exercises those rollback packages before cleanup.
 */
export const R3_5_PG17_CERTIFICATION_PACKAGE_HASHES = Object.freeze({
  'stella_0002_interactions_hardening.sql': 'cbf860b12d3f32205f2e0efba7c3c1c2d9a4658bafc3ab7949d2de4089e9ec9e',
  'stella_0002b_append_only_truncate_hardening.sql': '3fda2dfd117616e09b86da45b75e6f070bcc7a857e5a1c2da752670a83ac47b5',
  'stella_0001_role_topology_bootstrap.sql': '9f21955e505e5c2a5212fabcb683f7e1e514c6665fbc8726041a1cc631e4f7b3',
  // Repinned MSC-07B.8-R9T: the INSERT-policy verifier at each of the 8
  // brittle sites (1 here, 2 in stella_0004) now proves the canonical
  // WITH CHECK by an observed-vs-observed same-session probe instead of by
  // comparing pg_get_expr(..., true) to a handwritten predicted deparse
  // literal (R9S-X root cause B). CREATE POLICY authority is unchanged.
  'stella_0003_suggestion_decisions.sql': '33bed52967ecdd0f92bc8d5bc804136c709a5485e463167d6597fcd3602e088e',
  // Repinned MSC-07B.8-R10D: the two off-target policy-count verifier
  // predicates (precondition + postcondition) are now scoped to schema
  // public via pg_policy -> pg_class -> pg_namespace, instead of counting
  // pg_policy cluster-wide (which silently included storage.objects'
  // policies). Diagnostic variables only; no WHERE/authority change.
  'stella_0004_role_separation.sql': '7e5c48f32f487edd83dcd2ab40a0b172a1c75662398f29143d13e4b1e7de0792',
  'stella_0001_role_topology_bootstrap_rollback.sql':
    '7db648d44a93abd3bfe545b7301b436303a51d07148c69e07b1c8b1f35154f96',
  'stella_0004_rollback.sql': '22afa4cfddfe407abc6171b452659bf56d2a833663a818bfd55c6fab002f7cb6',
} as const)

export type R3_5Pg17CertificationSourceFile = keyof typeof R3_5_PG17_CERTIFICATION_PACKAGE_HASHES
export type R3_5Pg17CertificationSourceHashes = Readonly<
  Record<R3_5Pg17CertificationSourceFile, string>
>

const certificationPhaseFiles = new Set(R3_5_PG17_CERTIFICATION_PHASES.map((phase) => phase.file))
for (const file of certificationPhaseFiles) {
  if (!(file in R3_5_PG17_CERTIFICATION_PACKAGE_HASHES)) {
    throw new Error(`R3.5 PG17 certification phase is unpinned: ${file}`)
  }
}

function fixedPreparedPath(file: R3_5Pg17CertificationSourceFile): string {
  const candidate = resolve(PREPARED_DIRECTORY, file)
  if (!candidate.startsWith(`${PREPARED_DIRECTORY}${sep}`)) {
    throw new Error(`R3.5 PG17 certification refused an unsafe fixed path: ${file}`)
  }
  return candidate
}

/** Reads only the fixed package set rooted in this repository. */
export function collectR3_5Pg17CertificationSourceHashes(): R3_5Pg17CertificationSourceHashes {
  const observed = {} as Record<R3_5Pg17CertificationSourceFile, string>
  for (const file of Object.keys(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES) as R3_5Pg17CertificationSourceFile[]) {
    observed[file] = createHash('sha256').update(readFileSync(fixedPreparedPath(file))).digest('hex')
  }
  return Object.freeze(observed)
}

/** Fails closed before Docker use when any fixed package byte differs. */
export function assertR3_5Pg17CertificationSourceHashes(
  observed: R3_5Pg17CertificationSourceHashes,
): void {
  for (const [file, expected] of Object.entries(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES) as [
    R3_5Pg17CertificationSourceFile,
    string,
  ][]) {
    if (observed[file] !== expected) {
      throw new Error(`R3.5 PG17 certification SHA-256 mismatch for ${file}`)
    }
  }
}

/** Compares only Docker's observed local image ID to the frozen identity. */
export function assertR3_5Pg17CertificationImageId(observedImageId: string): void {
  if (observedImageId.trim() !== R3_5_PG17_CERTIFICATION_IMAGE_ID) {
    throw new Error(
      `R3.5 PG17 certification image ID mismatch: expected ${R3_5_PG17_CERTIFICATION_IMAGE_ID}, received ${observedImageId.trim() || '<empty>'}`,
    )
  }
}
