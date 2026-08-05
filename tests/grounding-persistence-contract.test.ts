// tests/grounding-persistence-contract.test.ts
//
// The GR-001 / GR-002 persistence contract, applied to the packages as they sit
// on disk. Fully offline: reads repository files only. No database, no network.
//
// Division of labour with its two neighbours:
//
//   tests/helpers/grounding-gates.ts    the properties that must be MUTATION
//                                       TESTABLE, so they live in a pure
//                                       function that can be run over broken
//                                       copies (tests/grounding-persistence-
//                                       mutation.test.ts does exactly that).
//   this file                           the properties that are about the
//                                       packages AS SHIPPED and about their
//                                       agreement with the TypeScript contracts
//                                       in lib/grounding/contracts/ — an
//                                       agreement no SQL-only reader can check.
//
// The second half is the point. GR-001's whole argument is that a citation is
// verifiable from the sealed file, and that only holds if the columns the
// database stores are the fields the ingestion core actually produces. A schema
// that is internally consistent and disagrees with lib/grounding is a schema
// that stores provenance for a pipeline nobody runs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateGroundingGates,
  parseFunctions,
  FORWARD,
  ROLLBACK,
  GROUNDING_SQL_FILES,
  GR001_PROVENANCE_COLUMNS,
  type Sources,
} from './helpers/grounding-gates'
import { parsePolicies, analyzeSecurity } from './helpers/sql-structure'

const ROOT = process.cwd()
const PREPARED = path.resolve(ROOT, 'db', 'prepared')

const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8')
const prepared = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

const SOURCES: Sources = Object.fromEntries(
  GROUNDING_SQL_FILES.map((f) => [f, prepared(f)]),
)

const VERSIONS = SOURCES[FORWARD.VERSIONS]
const CHUNKS = SOURCES[FORWARD.CHUNKS]

/** Strip `--` comments so prose cannot satisfy an assertion about code. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '')

describe('grounding persistence — the packages on disk satisfy every gate', () => {
  it('produces no violation at all', () => {
    // Printed in full rather than counted: a gate that fires has to say what it
    // saw, or the next person debugging it re-derives the whole contract.
    expect(evaluateGroundingGates(SOURCES).map((v) => `${v.gate}: ${v.detail}`)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GR-001 — the six columns, and the guard that must demand them
// ---------------------------------------------------------------------------

describe('GR-001 — provenance columns', () => {
  it.each(GR001_PROVENANCE_COLUMNS)('%s is declared NOT NULL', (column) => {
    expect(CHUNKS).toMatch(new RegExp(`^\\s*${column} (char\\(64\\)|varchar\\(32\\)) NOT NULL`, 'm'))
  })

  it('the shape guard demands every column the CREATE TABLE declares, and no other', () => {
    // GR-001 §5 makes acceptance conditional on the guard REQUIRING the six
    // columns. But a guard that lists FEWER columns than the table has is the
    // dangerous direction generally: it adopts a pre-existing table missing one
    // and reports success. Compare the two lists rather than spot-checking six.
    const table = /CREATE TABLE IF NOT EXISTS public\.evidence_chunks \(([\s\S]*?)\n\);/.exec(CHUNKS)
    expect(table, 'evidence_chunks is not created in the expected form').not.toBeNull()
    const declared = [...code(table![1]).matchAll(/^\s{2}(\w+) (?:uuid|char|varchar|text|integer|jsonb|timestamptz)/gm)]
      .map((m) => m[1])
      .sort()

    const guard = CHUNKS.slice(CHUNKS.indexOf('0c. Shape guard'), CHUNKS.indexOf('-- 1. Table'))
    const guarded = [...guard.matchAll(/\('(\w+)',\s+'/g)].map((m) => m[1]).sort()

    expect(guarded).toEqual(declared)
    expect(declared.length).toBe(23)
  })

  it('the guard names grounding_0001 and its rollback when it meets the superseded shape', () => {
    // "Add the missing columns" is the WRONG instruction for a legacy table:
    // the legacy UNIQUE has to go too, and this script deliberately refuses to
    // drop a uniqueness guarantee. A generic mismatch message would send the
    // operator down a path that cannot terminate.
    expect(CHUNKS).toMatch(/evidence_chunks_evidence_chunk_unique/)
    expect(CHUNKS).toMatch(/grounding_0001_rollback\.sql/)
    expect(CHUNKS).toMatch(/SUPERSEDED grounding_0001 shape/)
  })

  it('offsets and hashes are constrained, not merely typed', () => {
    // char(64) admits 64 spaces; integer admits a negative offset. The types
    // are the storage decision, the CHECKs are the contract.
    expect(code(CHUNKS)).toContain("chunk_id ~ '^[0-9a-f]{64}$'")
    expect(code(CHUNKS)).toContain('char_start >= 0 AND char_end > char_start')
    // Half-open [start, end): `>=` would admit an empty span, which quotes
    // nothing while looking like a valid anchor.
    expect(code(CHUNKS)).not.toMatch(/char_end >= char_start/)
  })

  it('records the injection scanner version, so an old scan can be redone without re-extracting', () => {
    expect(CHUNKS).toMatch(/^\s*injection_scanner_version varchar\(32\) NOT NULL,/m)
  })

  it('carries an embedding provider column but creates no vector object', () => {
    // GR-001 §4 places vector work outside the request, and G5 P3 is undecided.
    // The provider ships now so the follow-up package can add the vector and
    // the "provider present iff vector present" invariant together.
    expect(CHUNKS).toMatch(/^\s*embedding_provider_id varchar\(64\),/m)
    expect(code(CHUNKS)).not.toMatch(/\bvector\s*\(/i)
    expect(code(CHUNKS)).not.toMatch(/CREATE EXTENSION/i)
    expect(code(CHUNKS)).not.toMatch(/\b(hnsw|ivfflat)\b/i)
  })
})

// ---------------------------------------------------------------------------
// GR-002 — the history is append-only and linear
// ---------------------------------------------------------------------------

describe('GR-002 — version history', () => {
  it('the guard demands every column the CREATE TABLE declares, and no other', () => {
    const table = /CREATE TABLE IF NOT EXISTS public\.evidence_document_versions \(([\s\S]*?)\n\);/.exec(VERSIONS)
    expect(table).not.toBeNull()
    const declared = [...code(table![1]).matchAll(/^\s{2}(\w+) (?:uuid|char|varchar|integer|timestamptz)/gm)]
      .map((m) => m[1])
      .sort()

    const guard = VERSIONS.slice(VERSIONS.indexOf('0.7 Shape guard'), VERSIONS.indexOf('-- 1. Capability role'))
    const guarded = [...guard.matchAll(/\('(\w+)',\s+'/g)].map((m) => m[1]).sort()

    expect(guarded).toEqual(declared)
    expect(declared.length).toBe(14)
  })

  it('has no is_active column — activeness is derived, because a flag needs an UPDATE', () => {
    // The four constraints below make max(ordinal) unique and the chain linear
    // and rooted, so "the active version" is a theorem. A boolean flag would
    // need an UPDATE to move, and UPDATE is the one thing this table refuses.
    expect(code(VERSIONS)).not.toMatch(/\bis_active\b/)
    expect(code(VERSIONS)).toContain('UNIQUE (evidence_id, ordinal)')
    expect(code(VERSIONS)).toContain('UNIQUE (evidence_id, supersedes_version_id)')
    expect(code(VERSIONS)).toContain('(ordinal = 1) = (supersedes_version_id IS NULL)')
    expect(code(VERSIONS)).toContain('supersedes_version_id <> version_id')
  })

  it('the evidence foreign key is NO ACTION, so deleting evidence cannot erase history', () => {
    const fk = /evidence_id uuid NOT NULL REFERENCES public\.evidence_items\(id\)([^,]*),/.exec(VERSIONS)
    expect(fk, 'the evidence_items foreign key is missing').not.toBeNull()
    expect(fk![1].trim()).toBe('')
    // ...and the chunk index is the opposite, deliberately: it is derived and
    // regenerable, so it SHOULD fall with the evidence row.
    expect(CHUNKS).toMatch(/evidence_id uuid NOT NULL REFERENCES public\.evidence_items\(id\) ON DELETE CASCADE/)
  })

  it('stores no source label — a filename is user-supplied text that carries personal data', () => {
    // "minimal, non-sensitive metadata" means exactly one column, and it is the
    // normalized MIME type: it selects which extractor contract applies when a
    // third party re-derives the chunks, and it cannot carry user text.
    expect(code(VERSIONS)).not.toMatch(/\b(source_label|file_name|filename|original_name)\b/)
    expect(VERSIONS).toMatch(/^\s*mime_type varchar\(255\) NOT NULL,/m)
  })

  it('has no UPDATE or DELETE policy, on any table', () => {
    for (const p of parsePolicies(VERSIONS)) {
      expect(['UPDATE', 'DELETE'], `policy ${p.name}`).not.toContain(p.command)
    }
  })

  it('carries an extractor version, which the TypeScript contract does not yet publish', () => {
    // versionId = hash(evidenceId, rawContentHash) — the extractor is NOT in
    // that preimage. So a change of extractor produces a different
    // normalized_content_hash under the SAME version_id, and without this
    // column the re-ingestion is indistinguishable from a replay.
    expect(VERSIONS).toMatch(/^\s*extractor_version varchar\(32\) NOT NULL,/m)

    // The corresponding constant does not exist in lib/grounding yet. Pinned so
    // that publishing one is a visible act rather than a quiet divergence — and
    // so this assertion fails, loudly, on the day it appears.
    const core = read('lib', 'grounding', 'contracts', 'core.ts')
    expect(core).toMatch(/export const NORMALIZATION_VERSION/)
    expect(core).toMatch(/export const CHUNKER_VERSION/)
    expect(core).toMatch(/export const INJECTION_SCANNER_VERSION/)
    expect(
      core,
      'lib/grounding now publishes an EXTRACTOR_VERSION: update the GR-CAP-001 response and drop this pin',
    ).not.toMatch(/export const EXTRACTOR_VERSION/)
  })
})

// ---------------------------------------------------------------------------
// Agreement with the TypeScript contracts
// ---------------------------------------------------------------------------

describe('the schema and lib/grounding describe the same pipeline', () => {
  it('every pipeline version the core produces has a column to land in', () => {
    const core = read('lib', 'grounding', 'contracts', 'core.ts')
    const published = [...core.matchAll(/export const (\w+_VERSION) = '([\w-]+)'/g)].map((m) => m[1])
    expect(published.length).toBeGreaterThan(0)

    const columnFor: Record<string, string> = {
      NORMALIZATION_VERSION: 'normalization_version',
      CHUNKER_VERSION: 'chunker_version',
      INJECTION_SCANNER_VERSION: 'injection_scanner_version',
    }
    for (const constant of published) {
      const column = columnFor[constant]
      expect(column, `lib/grounding publishes ${constant} and no column is mapped to it`).toBeDefined()
      expect(CHUNKS, `${column} is missing`).toMatch(new RegExp(`^\\s*${column} varchar\\(32\\) NOT NULL,`, 'm'))
    }
  })

  it('the hash width matches CONTENT_HASH_HEX_LENGTH', () => {
    const core = read('lib', 'grounding', 'contracts', 'core.ts')
    const length = /export const CONTENT_HASH_HEX_LENGTH = (\d+)/.exec(core)
    expect(length).not.toBeNull()
    expect(length![1]).toBe('64')
    // char(64) and the anchored {64} CHECK both derive from that constant. A
    // schema that stored 32 or 128 would accept digests the core cannot produce.
    expect(code(CHUNKS)).toContain("~ '^[0-9a-f]{64}$'")
    expect(code(VERSIONS)).toContain("~ '^[0-9a-f]{64}$'")
  })

  it('project_id is NOT NULL because evidence_items.project_id is', () => {
    // GR-001 §2.1 proposed a nullable project ("null = organization-scoped
    // evidence"). No such evidence exists, and a nullable column would invite a
    // row no evidence item can produce.
    const schema = read('db', 'schema.ts')
    const evidence = /export const evidenceItems = pgTable\('evidence_items', \{([\s\S]*?)\n\}/.exec(schema)
    expect(evidence).not.toBeNull()
    expect(evidence![1]).toMatch(/projectId: uuid\('project_id'\)\.references\(\(\) => projects\.id\)\.notNull\(\)/)

    for (const sql of [VERSIONS, CHUNKS]) {
      expect(sql).toMatch(/project_id uuid NOT NULL REFERENCES public\.projects\(id\)/)
    }
  })

  it('chunk_index is never assumed contiguous', () => {
    // GR-001 §3: indexes are assigned BEFORE deduplication and kept afterwards,
    // so a gap says "the chunk that would have sat here duplicated an earlier
    // one". Any constraint or count that assumes contiguity fails on a document
    // with a repeated header.
    expect(code(CHUNKS)).not.toMatch(/chunk_index\s*=\s*(?!.*>=)\w*ordinal/)
    expect(code(CHUNKS)).not.toMatch(/max\(chunk_index\)\s*\+\s*1\s*=\s*count/)
    expect(CHUNKS).toMatch(/NOT contiguous/)
  })
})

// ---------------------------------------------------------------------------
// The governed write path
// ---------------------------------------------------------------------------

describe('SECURITY DEFINER contract', () => {
  const functions = [FORWARD.VERSIONS, FORWARD.CHUNKS].flatMap((f) =>
    parseFunctions(SOURCES[f]).map((fn) => ({ file: f, ...fn })),
  )

  it('there are exactly five, and they are the five the contract names', () => {
    expect(functions.map((f) => f.name).sort()).toEqual([
      'uellix_grounding.chunks_in_scope',
      'uellix_grounding.claim_active_document_version',
      'uellix_grounding.finalize_document_ingestion',
      'uellix_grounding.insert_evidence_chunks',
      'uellix_grounding.register_document_version',
    ])
  })

  it.each(functions.map((f) => [f.name, f] as const))(
    '%s validates its arguments before reading anything',
    (_name, fn) => {
      const body = code(fn.body)
      const firstGuard = body.search(/RAISE EXCEPTION/)
      const firstRead = body.search(/\bFROM public\./)
      expect(firstGuard, 'no argument validation at all').toBeGreaterThan(-1)
      if (firstRead === -1) return
      expect(firstGuard, 'a table is read before the arguments are checked').toBeLessThan(firstRead)
    },
  )

  it('the ingestion path derives scope from the version row, never from its payload', () => {
    const insert = functions.find((f) => f.name.endsWith('insert_evidence_chunks'))!
    const body = code(insert.body)
    // Scope and pipeline facts come from v_version; the payload supplies only
    // the per-chunk fields. A payload that could name its own organization
    // could file a chunk against another tenant's document.
    for (const derived of [
      'v_version.organization_id',
      'v_version.project_id',
      'v_version.evidence_id',
      'v_version.version_id',
      'v_version.normalization_version',
    ]) {
      expect(body, `${derived} is not taken from the version row`).toContain(derived)
    }
    // jsonb_to_recordset with an explicit record definition, never a positional
    // SELECT * — reordering the definition would write offsets into hashes.
    expect(body).toContain('jsonb_to_recordset')
    expect(body).not.toMatch(/SELECT \*\s+FROM jsonb_to_recordset/)
  })

  it('the read path checks the scope it is given instead of deriving it', () => {
    // Deriving the scope from the row would make every call succeed, and the
    // mismatch between what a retrieval layer BELIEVES it is serving and the
    // row's actual scope is the bug worth catching.
    const scoped = functions.find((f) => f.name.endsWith('chunks_in_scope'))!
    const body = code(scoped.body)
    expect(body).toContain('ch.organization_id = p_organization_id')
    expect(body).toContain('ch.project_id = p_project_id')
    // Suppressed occurrences never reach a retrieval result.
    expect(body).toContain('ch.canonical_chunk_id IS NULL')
  })

  it('"not yours" and "does not exist" are the same error WITHIN a function', () => {
    // Distinguishing them is a tenancy oracle: it answers "does this document
    // exist in some other organization?" for anyone who can guess an id. The
    // requirement is per FUNCTION, not global — a function keyed on an evidence
    // item and one keyed on a version legitimately name different objects, and
    // collapsing those two into one message would be less informative without
    // closing anything.
    let checked = 0
    for (const fn of functions) {
      const messages = [
        ...code(fn.body).matchAll(/RAISE EXCEPTION\s*\n?\s*'grounding: ([^']*)'\s*USING ERRCODE = 'U0102'/g),
      ].map((m) => m[1])
      if (messages.length === 0) continue
      checked++
      expect(
        new Set(messages).size,
        `${fn.name} answers U0102 with more than one message: ${[...new Set(messages)].join(' | ')}`,
      ).toBe(1)
    }
    // At least the two functions that have BOTH branches — a missing row and a
    // row outside the caller's organizations.
    expect(checked).toBeGreaterThanOrEqual(4)
  })

  it('finalization counts canonical chunks only, and fails the transaction on a mismatch', () => {
    // Without it a batch that lost its tail leaves a version that LOOKS fully
    // indexed: retrieval simply never returns the missing passages.
    const finalize = functions.find((f) => f.name.endsWith('finalize_document_ingestion'))!
    const body = code(finalize.body)
    expect(body).toContain('canonical_chunk_id IS NULL')
    expect(body).toMatch(/v_actual <> p_expected_chunk_count/)
    expect(body).toMatch(/RAISE EXCEPTION/)
  })

  it('re-registering a version under a different pipeline is refused, not absorbed', () => {
    // Idempotent is not the same as permissive. Same bytes, different pipeline
    // means the coordinate space changed under a stable version_id, so every
    // stored offset for it is suspect — returning the old id leaves them.
    const register = functions.find((f) => f.name.endsWith('register_document_version'))!
    const body = code(register.body)
    expect(body).toMatch(/v_existing\.normalized_content_hash <> p_normalized_content_hash/)
    expect(body).toMatch(/v_existing\.extractor_version <> p_extractor_version/)
    expect(body).toMatch(/U0101/)
  })

  it('the registrar locks the evidence row before it reads the history', () => {
    // The UNIQUE constraints would catch a concurrent registration, but as a
    // constraint violation the caller cannot tell a race from a real conflict.
    const register = functions.find((f) => f.name.endsWith('register_document_version'))!
    const body = code(register.body)
    const lock = body.indexOf('FOR UPDATE')
    const historyRead = body.indexOf('FROM public.evidence_document_versions')
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(historyRead)
  })
})

// ---------------------------------------------------------------------------
// Rollbacks
// ---------------------------------------------------------------------------

describe('rollbacks', () => {
  it('the destructive statement is inside the DO block, so psql flags are not the barrier', () => {
    // A guard in a DO block followed by a top-level DROP is two statements, and
    // without -v ON_ERROR_STOP=1 psql reports the first and sends the second.
    // Those flags are a convention of invocation, not a property of the file:
    // the Supabase SQL editor, `supabase db execute` and a GUI client supply
    // neither. This is the defect stella_0003_rollback was hardened against.
    for (const file of [ROLLBACK.VERSIONS, ROLLBACK.CHUNKS]) {
      const topLevel = code(SOURCES[file])
        .replace(/\$\$[\s\S]*?\$\$/g, '$$body$$')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of topLevel) {
        expect(stmt, `${file}: top-level statement`).toMatch(/^(SET|DO)\b/i)
      }
    }
  })

  it('every DROP is a fixed literal — no format(), no concatenation, no variable', () => {
    for (const file of [ROLLBACK.VERSIONS, ROLLBACK.CHUNKS]) {
      const executed = [...SOURCES[file].matchAll(/EXECUTE\s+'((?:[^']|'')*)'/g)].map((m) => m[1])
      expect(executed.length, `${file} executes nothing`).toBeGreaterThan(0)
      for (const stmt of executed) {
        expect(stmt).toMatch(/^DROP (TABLE|FUNCTION|SCHEMA|ROLE)\b/i)
      }
      expect(SOURCES[file]).not.toMatch(/EXECUTE\s+format/i)
      expect(SOURCES[file]).not.toMatch(/EXECUTE\s+[a-z_]+\s*;/i)
    }
  })

  it('the two rollbacks are asymmetric, and the asymmetry is the point', () => {
    // The version history is NOT regenerable from Storage, so its rollback
    // asks. The chunk index IS, so its rollback does not — a confirmation
    // prompt there would train an operator to type the same confirmation at the
    // prompt where evidence is actually lost.
    expect(SOURCES[ROLLBACK.VERSIONS]).toContain('grounding.rollback_confirm')
    expect(SOURCES[ROLLBACK.CHUNKS]).not.toContain('rollback_confirm')
    expect(SOURCES[ROLLBACK.CHUNKS]).toMatch(/regenerable/i)
  })

  it('each rollback drops only what its own forward script created', () => {
    const dropped = (sql: string) =>
      [...sql.matchAll(/DROP (?:TABLE|SCHEMA|ROLE|FUNCTION)(?: IF EXISTS)? ([\w.]+)/g)].map((m) => m[1])

    expect(dropped(SOURCES[ROLLBACK.CHUNKS]).sort()).toEqual([
      'public.evidence_chunks',
      'uellix_grounding.chunks_in_scope',
      'uellix_grounding.finalize_document_ingestion',
      'uellix_grounding.insert_evidence_chunks',
    ])
    expect(dropped(SOURCES[ROLLBACK.VERSIONS]).sort()).toEqual([
      'public.evidence_document_versions',
      'uellix_cap_grounding',
      'uellix_grounding',
      'uellix_grounding.claim_active_document_version',
      'uellix_grounding.register_document_version',
    ])
  })

  it('the version rollback refuses to run while the chunk index still references it', () => {
    expect(SOURCES[ROLLBACK.VERSIONS]).toMatch(/rollback refused[\s\S]{0,120}evidence_chunks still references/)
  })

  it('the schema and the role survive a chunk-only rollback', () => {
    // grounding_0002 owns them, and a database with the version history still
    // applied would otherwise lose its governed write path.
    expect(SOURCES[ROLLBACK.CHUNKS]).not.toMatch(/DROP SCHEMA/)
    expect(SOURCES[ROLLBACK.CHUNKS]).not.toMatch(/DROP ROLE/)
    // ...and the version rollback only drops them when nothing else is there.
    expect(SOURCES[ROLLBACK.VERSIONS]).toMatch(/other_funcs = 0/)
  })
})

// ---------------------------------------------------------------------------
// grounding_0001 disposition
// ---------------------------------------------------------------------------

describe('grounding_0001 is superseded, not silently replaced', () => {
  const legacy = prepared('grounding_0001_evidence_chunks.sql')

  it('carries a do-not-apply banner naming its successor', () => {
    expect(legacy).toMatch(/SUPERSEDED BY db\/prepared\/grounding_0003_evidence_chunks\.sql/)
    expect(legacy).toMatch(/DO NOT APPLY THIS SCRIPT/)
  })

  it('only comments were added — every executable statement is unchanged', () => {
    // The GROUNDING line owns lib/grounding/__tests__/prepared-sql.test.ts and
    // it pins this file's contents; the G2 addendum's evidence refers to it by
    // name. So the banner had to be inert.
    // String literals are blanked before splitting, not just comments: the
    // table COMMENT contains a semicolon inside its literal ("Not an audit
    // trail; source of truth is …"), and splitting on it produced a fragment
    // that starts with prose. Same order of operations the GROUNDING-owned
    // lib/grounding/__tests__/prepared-sql.test.ts uses.
    const statements = code(legacy)
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/\$\$[\s\S]*?\$\$/g, '$$body$$')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    expect(statements[0]).toMatch(/^SET search_path = public, extensions$/i)
    for (const stmt of statements) {
      expect(stmt).toMatch(/^(SET|CREATE|ALTER|DROP POLICY|GRANT|REVOKE|DO|COMMENT)\b/i)
    }
  })

  it('the successor is pgvector-free, so it no longer waits on the G5 P3 decision', () => {
    expect(/^SET search_path = ([^;]+);/m.exec(legacy)![1]).toBe('public, extensions')
    expect(/^SET search_path = ([^;]+);/m.exec(CHUNKS)![1]).toBe('public')
  })

  it('the README registry records the disposition and both application orders', () => {
    const readme = prepared('README.md')
    expect(readme).toMatch(/SUPERSEDIDO por `grounding_0003`/)
    expect(readme).toMatch(/grounding_0002` → `grounding_0003/)
    expect(readme).toMatch(/grounding_0003` → `grounding_0002/)
  })
})

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

describe('containment', () => {
  it('neither package touches a table it does not own', () => {
    const OWN = new Set(['public.evidence_document_versions', 'public.evidence_chunks'])
    for (const file of [FORWARD.VERSIONS, FORWARD.CHUNKS]) {
      const analysis = analyzeSecurity(SOURCES[file])
      for (const stmt of [...analysis.grants, ...analysis.revokes]) {
        if (stmt.objectType !== 'TABLE') continue
        expect(OWN, `${file} confers privileges on ${stmt.object}`).toContain(stmt.object)
      }
      for (const toggle of analysis.rlsToggles) {
        expect(OWN, `${file} toggles RLS on ${toggle.table}`).toContain(toggle.table)
      }
      // No ALTER DEFAULT PRIVILEGES and no whole-catalogue ownership move: both
      // reach objects the package never names.
      expect(analysis.defaultPrivileges, `${file}: ALTER DEFAULT PRIVILEGES`).toEqual([])
      expect(analysis.ownedStatements, `${file}: REASSIGN/DROP OWNED`).toEqual([])
    }
  })

  it('nothing in these packages enables a feature flag or reaches a remote target', () => {
    for (const file of GROUNDING_SQL_FILES) {
      expect(SOURCES[file]).not.toMatch(/_ENABLED\s*=\s*true/i)
      expect(SOURCES[file]).not.toMatch(/service_role\s+TO/i)
      expect(SOURCES[file]).not.toMatch(/supabase\.co/i)
    }
  })

  it('the gate-managed table registry knows both tables', () => {
    // ADR 21 §3: a gate-managed table that appeared in db/schema.ts would make
    // `drizzle-kit generate` emit a CREATE TABLE without IF NOT EXISTS, which
    // fails against a database where the prepared package already ran.
    const schema = read('db', 'schema.ts')
    for (const table of ['evidence_chunks', 'evidence_document_versions']) {
      expect(schema, `db/schema.ts declares ${table}`).not.toContain(table)
    }
  })
})
