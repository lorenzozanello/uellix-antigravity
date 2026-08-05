// tests/cross-workstream/capabilities-to-grounding.test.ts
// INTEGRATION (Stella parallel train 2) — the CAPABILITIES → GROUNDING seam.
//
// GR-001 and GR-002 were written by GROUNDING and answered by CAPABILITIES in
// separate worktrees. Both sides believe the contract is satisfied. These tests
// are the only place where that belief is checked against the OTHER side's
// definition of the requirement rather than its own.
//
// Deliberately built on `tests/helpers/grounding-gates.ts` — CAPABILITIES' own
// parser — instead of a second SQL reader written here. A second parser is a
// second opinion about what the file says, and the day the two disagree the
// failure is in the reader, not in the schema.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  FORWARD,
  GR001_PROVENANCE_COLUMNS,
  GR002_HISTORY_COLUMNS,
  GROUNDING_SQL_FILES,
  evaluateGroundingGates,
  type Sources,
} from '@/tests/helpers/grounding-gates'
import { PIPELINE_VERSIONS } from '@/lib/grounding/contracts'

const PREPARED = path.join(process.cwd(), 'db/prepared')

const SOURCES: Sources = Object.fromEntries(
  GROUNDING_SQL_FILES.map((f) => [f, readFileSync(path.join(PREPARED, f), 'utf8')]),
)

const VERSIONS_SQL = SOURCES[FORWARD.VERSIONS]
const CHUNKS_SQL = SOURCES[FORWARD.CHUNKS]

/** The `CREATE TABLE` body only — a column named in a comment is not a column. */
function tableBody(sql: string, table: string): string {
  const open = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`)
  expect(open, `no CREATE TABLE for public.${table}`).toBeGreaterThan(-1)
  const close = sql.indexOf('\n);', open)
  expect(close, `unterminated CREATE TABLE for public.${table}`).toBeGreaterThan(open)
  return sql.slice(open, close)
}

const CHUNKS_TABLE = tableBody(CHUNKS_SQL, 'evidence_chunks')
const VERSIONS_TABLE = tableBody(VERSIONS_SQL, 'evidence_document_versions')

// ---------------------------------------------------------------------------
// 1. The delivered shape satisfies the requesting line's acceptance criteria
// ---------------------------------------------------------------------------

describe('CAPABILITIES → GROUNDING: GR-001 acceptance criterion §5', () => {
  it('every gate CAPABILITIES defined for its own packages passes on the integrated tree', () => {
    expect(evaluateGroundingGates(SOURCES)).toEqual([])
  })

  it('delivers all six provenance columns GROUNDING made acceptance conditional on', () => {
    for (const column of GR001_PROVENANCE_COLUMNS) {
      expect(CHUNKS_TABLE, `evidence_chunks is missing ${column}`).toMatch(
        new RegExp(`^\\s*${column}\\s`, 'm'),
      )
    }
  })

  it('makes all six NOT NULL — a nullable provenance column is provenance that can be absent', () => {
    for (const column of GR001_PROVENANCE_COLUMNS) {
      const line = CHUNKS_TABLE.split('\n').find((l) => new RegExp(`^\\s*${column}\\s`).test(l))
      expect(line, `no column line for ${column}`).toBeTruthy()
      expect(line, `${column} is nullable`).toMatch(/NOT NULL/)
    }
  })

  it('has a shape guard that DEMANDS them, so applying an older table aborts instead of drifting', () => {
    for (const column of GR001_PROVENANCE_COLUMNS) {
      expect(CHUNKS_SQL).toContain(`'${column}'`)
    }
    expect(CHUNKS_SQL).toMatch(/RAISE EXCEPTION[^\n]*grounding_0003 aborted/)
  })

  it('stays out of the undecided pgvector gate: no extension, no vector type, no ANN index', () => {
    // GR-001 §4 places vector work outside the request. `grounding_0001` coupled
    // to it, which is one of the three reasons it was superseded.
    const code = CHUNKS_SQL.split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    expect(code).not.toMatch(/CREATE EXTENSION/i)
    expect(code).not.toMatch(/\bvector\s*\(/i)
    expect(code).not.toMatch(/USING\s+(ivfflat|hnsw)/i)
  })
})

describe('CAPABILITIES → GROUNDING: GR-002 shape', () => {
  it('delivers every column GR-002 §2 asked the version table to carry', () => {
    for (const column of GR002_HISTORY_COLUMNS) {
      expect(VERSIONS_TABLE, `evidence_document_versions is missing ${column}`).toMatch(
        new RegExp(`^\\s*${column}\\s`, 'm'),
      )
    }
  })

  it('keeps the two uniqueness guarantees GR-002 named', () => {
    expect(VERSIONS_SQL).toMatch(/UNIQUE\s*\(\s*evidence_id\s*,\s*version_id\s*\)/)
    expect(VERSIONS_SQL).toMatch(/UNIQUE\s*\(\s*evidence_id\s*,\s*ordinal\s*\)/)
  })

  it('is append-only in the strong sense: no principal holds UPDATE, DELETE or TRUNCATE', () => {
    // GR-002 §2 asks for "append-only, like audit_logs / runs / line_items".
    // Absence of a GRANT is the primary mechanism; the trigger is the backstop
    // that also binds the owner, who is not subject to GRANTs at all.
    const grants = VERSIONS_SQL.split('\n').filter((l) =>
      /^GRANT .* ON public\.evidence_document_versions/.test(l),
    )
    expect(grants.length).toBeGreaterThan(0)
    for (const grant of grants) {
      expect(grant, `mutating grant on an append-only table: ${grant}`).not.toMatch(
        /\b(UPDATE|DELETE|TRUNCATE|ALL)\b/,
      )
    }
    expect(VERSIONS_SQL).toMatch(/BEFORE UPDATE OR DELETE ON public\.evidence_document_versions/)
    expect(VERSIONS_SQL).toMatch(/BEFORE TRUNCATE ON public\.evidence_document_versions/)
  })

  it('distinguishes regenerable from non-regenerable: chunks MAY be deleted, versions may not', () => {
    // This asymmetry is the contract, not an oversight. evidence_chunks is a
    // derived index and must be re-buildable; evidence_document_versions is a
    // chain-of-custody record. A test that demanded symmetry would be demanding
    // that one of the two be wrong.
    expect(CHUNKS_SQL).toMatch(/GRANT[^\n]*DELETE[^\n]*ON public\.evidence_chunks/)
    expect(VERSIONS_SQL).not.toMatch(/GRANT[^\n]*DELETE[^\n]*ON public\.evidence_document_versions/)
  })
})

// ---------------------------------------------------------------------------
// 2. Versions and chunks share one scope, and it is the evidence item's
// ---------------------------------------------------------------------------

describe('CAPABILITIES → GROUNDING: chunks and versions share a scope', () => {
  it('both tables carry organization_id AND project_id, both NOT NULL', () => {
    for (const [name, body] of [
      ['evidence_chunks', CHUNKS_TABLE],
      ['evidence_document_versions', VERSIONS_TABLE],
    ] as const) {
      for (const column of ['organization_id', 'project_id']) {
        const line = body.split('\n').find((l) => new RegExp(`^\\s*${column}\\s`).test(l))
        expect(line, `${name}.${column} is missing`).toBeTruthy()
        expect(line, `${name}.${column} is nullable`).toMatch(/NOT NULL/)
      }
    }
  })

  it('project_id is NOT NULL because evidence_items.project_id is — the deviation is grounded in the schema', () => {
    // GR-001 §2.1 proposed `project_id uuid NULL` ("null = org-wide evidence").
    // CAPABILITIES deviated (GR-CAP-001 §5.1) on the grounds that the case does
    // not exist. This asserts the GROUND for the deviation, not just the
    // deviation: if evidence_items.project_id ever becomes nullable, the reason
    // evaporates and this test fires.
    const schema = readFileSync(path.join(process.cwd(), 'db/schema.ts'), 'utf8')
    const evidenceItems = schema.slice(
      schema.indexOf("export const evidenceItems = pgTable('evidence_items'"),
      schema.indexOf('export const', schema.indexOf("pgTable('evidence_items'") + 10),
    )
    expect(evidenceItems).toMatch(/projectId: uuid\('project_id'\)[^\n]*\.notNull\(\)/)
  })

  it('ties a chunk to its parent by the WHOLE key, not by evidence_id alone', () => {
    // A chunk row that agreed with its evidence item on evidence_id but not on
    // organization/project would be readable by the wrong boundary. The
    // restrictive policy is what makes the triple the unit of consistency.
    expect(CHUNKS_SQL).toMatch(/AS RESTRICTIVE/)
    expect(CHUNKS_SQL).toMatch(/evidence_chunks_scope_consistency/)
    expect(VERSIONS_SQL).toMatch(/evidence_document_versions_scope_consistency/)
  })

  it('derives scope inside the definer instead of trusting the payload', () => {
    expect(CHUNKS_SQL).toMatch(/uellix_grounding\.insert_evidence_chunks/)
    // The version row, not the caller, supplies organization/project/version.
    expect(CHUNKS_SQL).toMatch(/v_version\s+public\.evidence_document_versions%ROWTYPE/)
  })
})

// ---------------------------------------------------------------------------
// 3. extractor_version — the open contract, asserted as open
// ---------------------------------------------------------------------------

describe('CAPABILITIES → GROUNDING: extractor_version has an explicit contract', () => {
  it('the column exists and is NOT NULL, so a caller must declare something', () => {
    const line = VERSIONS_TABLE.split('\n').find((l) => /^\s*extractor_version\s/.test(l))
    expect(line, 'extractor_version is missing from evidence_document_versions').toBeTruthy()
    expect(line).toMatch(/NOT NULL/)
  })

  it('GROUNDING publishes no EXTRACTOR_VERSION yet — recorded as an open contract, not as an invented value', () => {
    // INTEGRATION DECISION (train 2): this stays PENDING and is registered in
    // the ledger as GR-CAP-002. Integration did not publish the constant itself,
    // for three reasons: `lib/grounding/**` belongs to GROUNDING; choosing a
    // string like 'extract-1' would be inventing a governed value in silence;
    // and `tests/grounding-persistence-contract.test.ts` pins its ABSENCE as a
    // tripwire, so adding it here would break a CAPABILITIES-owned test to
    // satisfy a column nothing writes yet.
    //
    // The day GROUNDING publishes it, THIS test fails too — which is the
    // intended signal to close the contract rather than to delete the test.
    expect(PIPELINE_VERSIONS).not.toHaveProperty('extractor')
    const core = readFileSync(path.join(process.cwd(), 'lib/grounding/contracts/core.ts'), 'utf8')
    expect(core).not.toMatch(/export const EXTRACTOR_VERSION/)
  })

  it('the gap it closes is real: version_id does not cover the extractor', () => {
    // versionId derives from (evidenceId, rawContentHash) only. A different
    // extractor over the same bytes yields a different normalized hash under
    // the SAME version_id, so without the column a re-ingestion would be
    // discarded as a replica and every stored offset would silently go stale.
    // CAPABILITIES raises U0101 instead. This asserts the mechanism exists.
    expect(VERSIONS_SQL).toContain('U0101')
    expect(VERSIONS_SQL).toMatch(/uellix_grounding\.register_document_version/)
  })

  it('there is a real extraction stage, so the version is not a theoretical concern', () => {
    const extract = readFileSync(path.join(process.cwd(), 'lib/grounding/extract.ts'), 'utf8')
    expect(extract).toMatch(/text\/csv/)
    expect(extract).toMatch(/No extractor registered for MIME type/)
  })
})

// ---------------------------------------------------------------------------
// 4. grounding_0001 is superseded, byte-for-byte, and not applied
// ---------------------------------------------------------------------------

describe('CAPABILITIES → GROUNDING: the superseded package', () => {
  const legacy = readFileSync(path.join(PREPARED, 'grounding_0001_evidence_chunks.sql'), 'utf8')

  it('is marked superseded and points at its replacement by name', () => {
    expect(legacy).toMatch(/SUPERSEDED BY db\/prepared\/grounding_0003_evidence_chunks\.sql/)
    expect(legacy).toMatch(/DO NOT APPLY THIS SCRIPT/)
  })

  it('changed by comments only — every added line is a comment', () => {
    const banner = legacy.slice(0, legacy.indexOf('-- PREPARED ONLY'))
    const nonComment = banner
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('--'))
    expect(nonComment).toEqual([])
  })

  it('the replacement detects the legacy constraint by name if the old script was ever applied', () => {
    expect(CHUNKS_SQL).toMatch(/evidence_chunks_evidence_id_chunk_index_key|grounding_0001/)
  })
})
