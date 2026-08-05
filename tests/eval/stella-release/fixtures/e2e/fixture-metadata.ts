// tests/eval/stella-release/fixtures/e2e/fixture-metadata.ts
// RELEASE line — Train 4 (STELLA_RELEASE_LOCAL_END_TO_END_GATE_TRAIN_4).
//
// Identity and expectations for the disposable-database E2E journey
// (scripts/stella-release-e2e-dry-run.sh + tests/eval/stella-release/e2e/**).
//
// Real UUIDs, not the slug-style ids tests/eval/stella-release/fixtures.ts
// uses ('organization-alpha-1') — this fixture pair is inserted into an
// actual disposable Postgres container whose `uuid` columns reject anything
// else. The readable `5e2e...` pattern mirrors scripts/grounding-dry-run.sh's
// own convention: legible when a container's psql log is read by a human,
// distinguishable at a glance from every other fixture id in the repo.
//
// This module holds IDENTITY AND EXPECTATION ONLY — no SQL, no chunk text
// beyond what ingestDocument() itself produces from the real .txt files next
// to it. The two source documents deliberately disagree on one number (how
// many saplings were planted) so the E2E journey has a real, controlled
// contradiction to attribute — see docs/documents/source-*.txt.

import path from 'node:path'

export const E2E_ORGANIZATION_ID = '5e2e0000-0000-4000-8000-000000000001'
export const E2E_USER_ID = '5e2e0000-0000-4000-8000-000000000002'
export const E2E_PROJECT_ID = '5e2e0000-0000-4000-8000-000000000003'
/**
 * Same organization as E2E_PROJECT_ID, a DIFFERENT project. Used to prove
 * retrieval rejects a real, org-authorized caller asking for the wrong
 * project — `uellix_grounding.chunks_in_scope` filters on BOTH
 * organization_id and project_id, and this is the id that must come back
 * empty.
 */
export const E2E_DECOY_PROJECT_ID = '5e2e0000-0000-4000-8000-000000000004'

export const E2E_EVIDENCE_A_ID = '5e2e0000-0000-4000-8000-0000000000a1'
export const E2E_EVIDENCE_B_ID = '5e2e0000-0000-4000-8000-0000000000b1'

export interface E2eSourceDocumentFixture {
  readonly evidenceId: string
  readonly title: string
  readonly filename: string
  readonly mimeType: string
}

/** Repo-root-relative directory holding the two real fixture documents. */
export const E2E_FIXTURE_DOCS_RELATIVE_DIR = path.posix.join(
  'tests', 'eval', 'stella-release', 'fixtures', 'e2e', 'documents',
)

export function e2eFixtureDocsDir(root: string = process.cwd()): string {
  return path.join(root, ...E2E_FIXTURE_DOCS_RELATIVE_DIR.split('/'))
}

export const E2E_SOURCE_DOCUMENTS: readonly E2eSourceDocumentFixture[] = [
  {
    evidenceId: E2E_EVIDENCE_A_ID,
    title: 'Reforestation Program — Field Report Q1 2026',
    filename: 'source-a-field-report.txt',
    mimeType: 'text/plain',
  },
  {
    evidenceId: E2E_EVIDENCE_B_ID,
    title: 'Reforestation Program — Independent Verification Note',
    filename: 'source-b-verification-note.txt',
    mimeType: 'text/plain',
  },
]

/**
 * The controlled contradiction: each source states a different sapling
 * count for the same project and reporting period. The extractive generator
 * (tests/eval/stella-release/e2e/local-extractive-generator.ts) finds these
 * by pattern match over the REAL ingested chunk text — nothing here feeds a
 * generator directly, this is only what the journey asserts the generator
 * SHOULD find.
 */
export const E2E_CONTRADICTING_PLANTING_COUNTS: Readonly<Record<string, number>> = {
  [E2E_EVIDENCE_A_ID]: 1240,
  [E2E_EVIDENCE_B_ID]: 1180,
}

/** Retrieves both sources; the generator must report the contradiction. */
export const E2E_QUERY_WITH_CONTRADICTION =
  'How many native tree saplings were planted in the Rio Verde Watershed Restoration project in Q1 2026?'

/** Matches nothing in either fixture document — exercises abstention. */
export const E2E_QUERY_WITH_NO_MATCH =
  'What is the carbon sequestration rate of the mangrove restoration project?'
