// tests/hosted/class-c-evidence.test.ts
//
// Class-C evidence is SELECTED, and the selection has to be governed.
//
// `SQL_EDITOR_ARTEFACT` was a hardcoded dated filename. Honest with one
// measurement; a trap the moment the world moved. The 2026-08-07 probe recorded
// `evidenceBucketExists: false` and, after the bucket was created, the gate kept
// reading that answer. The artefact was not wrong — the selection was.

import { describe, expect, it } from 'vitest'

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CLASS_C_SQL_EDITOR_EVIDENCE,
  resolveClassCEvidence,
  type ClassCEvidenceEntry,
} from '@/db/hosted/measured-evidence'
import {
  CLASS_C_OBSERVATION_SQL,
  CLASS_C_EDITOR_PROBE_NAMES,
  buildClassCObservationSql,
} from '@/db/hosted/class-c-observation'
import { CLASS_C_PROBES } from '@/db/hosted/hosted-provisioning-runner'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!

// ---------------------------------------------------------------------------
// FASE 4 — Class-C evidence is SELECTED, and the selection is governed
// ---------------------------------------------------------------------------

describe('class-C evidence selection', () => {
  const entry = (patch: Partial<ClassCEvidenceEntry> = {}): ClassCEvidenceEntry => ({
    path: 'artifacts/class-c-probes/2026-08-08-uellix-staging.json',
    measuredOn: '2026-08-08',
    projectRef: KNOWN_STAGING_PROJECT_REF,
    note: 'test',
    ...patch,
  })

  it('resolves the CURRENT entry, which is the last declared one', () => {
    const older = entry({ path: 'old.json', measuredOn: '2026-08-07' })
    const newer = entry({ path: 'new.json', measuredOn: '2026-08-08' })
    const r = resolveClassCEvidence(KNOWN_STAGING_PROJECT_REF, [older, newer])
    expect(r.ok && r.entry.path).toBe('new.json')
  })

  it('is a declared ledger, never the newest file on disk', () => {
    // The property that matters: adding evidence is a code change. If this ever
    // becomes a directory scan, a file drop appoints the authority.
    expect(CLASS_C_SQL_EDITOR_EVIDENCE.length).toBeGreaterThan(0)
    for (const e of CLASS_C_SQL_EDITOR_EVIDENCE) {
      expect(e.path).toMatch(/^artifacts\/class-c-probes\//)
      expect(e.projectRef).toBe(KNOWN_STAGING_PROJECT_REF)
    }
  })

  it('refuses evidence describing another project', () => {
    const r = resolveClassCEvidence(KNOWN_STAGING_PROJECT_REF, [entry({ projectRef: 'aaaaaaaaaaaaaaaaaaaa' })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CLASS_C_WRONG_TARGET')
  })

  it('refuses PRODUCTION evidence by the check that names production', () => {
    const r = resolveClassCEvidence(PROD, [entry({ projectRef: PROD })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CLASS_C_PRODUCTION_REF')
  })

  it('refuses an empty ledger — unmeasured is not satisfied', () => {
    const r = resolveClassCEvidence(KNOWN_STAGING_PROJECT_REF, [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CLASS_C_EMPTY')
  })

  it('records WHY the current entry is current, so a stale one is visible in review', () => {
    const current = CLASS_C_SQL_EDITOR_EVIDENCE[CLASS_C_SQL_EDITOR_EVIDENCE.length - 1]!
    expect(current.note.length).toBeGreaterThan(20)
    expect(current.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ---------------------------------------------------------------------------
// The observation probe. Generated from CLASS_C_PROBES, so the query the
// operator runs and the query the criterion demands are ONE string.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const probeSql = existsSync(path.join(ROOT, CLASS_C_OBSERVATION_SQL))
  ? readFileSync(path.join(ROOT, CLASS_C_OBSERVATION_SQL), 'utf8')
  : null

/** git checks the file out with CRLF on Windows; the builder emits LF. */
const normalizeEol = (s: string | null): string | null =>
  s === null ? null : s.split('\r\n').join('\n').split('\r').join('\n')

/** The psql meta-command guard, written without a regex so no escape can rot. */
const PROJECT_REF_GUARD = String.fromCharCode(92) + 'if :{?uellix_project_ref}'

describe('the class-C observation probe', () => {
  it('is committed to the repository, never a temporary file', () => {
    expect(probeSql, `${CLASS_C_OBSERVATION_SQL} is missing — run pnpm classc:observation:generate`).not.toBeNull()
  })

  it('regenerates byte-identically from CLASS_C_PROBES', () => {
    expect(normalizeEol(probeSql)).toBe(buildClassCObservationSql())
  })

  it('QUOTES each canonical §2.7 query verbatim', () => {
    // THE PROPERTY THAT MATTERS. `hosted-capability-preflight-ready` refuses an
    // attestation whose recorded query is not the canonical one, because a
    // different query answers a different question. Generating the probe from
    // the same constant makes a typo impossible rather than unlikely.
    // IN THE `sql` FIELD SPECIFICALLY, not merely somewhere in the file.
    //
    // The first version of this test asserted `toContain(canonical)`, and a
    // mutation that replaced the recorded `sql` with 'SELECT 1' passed it: the
    // canonical string still appeared in the `observed` expression beside it.
    // `recordedQuery` reads the `sql` field and nothing else, so that is the
    // one the criterion will see.
    for (const name of CLASS_C_EDITOR_PROBE_NAMES) {
      const canonical = CLASS_C_PROBES.find(([k]) => k === name)?.[2]
      expect(canonical, name).toBeDefined()
      const escaped = canonical!.split("'").join("''")
      expect(probeSql, `${name}: the recorded sql field must BE the canonical query`).toContain(
        `'sql', '${escaped}'`,
      )
    }
  })

  it('records the three probes the artefact contract reads', () => {
    for (const name of CLASS_C_EDITOR_PROBE_NAMES) expect(probeSql).toContain(`'${name}'`)
    expect(CLASS_C_EDITOR_PROBE_NAMES).toHaveLength(3)
  })

  it('never writes, runs read-only, and rolls back', () => {
    expect(probeSql).not.toMatch(/(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s|DROP\s|ALTER\s|GRANT\s|REVOKE\s)/i)
    expect(probeSql).toContain('BEGIN READ ONLY;')
    expect(probeSql?.trimEnd().endsWith('ROLLBACK;')).toBe(true)
  })

  it('refuses to run without a project ref', () => {
    expect(probeSql).toContain(PROJECT_REF_GUARD)
    expect(probeSql).toContain('REFUSED')
  })

  it('does NOT re-measure the apply identity, which has its own artefact', () => {
    // Two artefacts answering one question is the divergence this programme
    // keeps paying for. current_user / MEMBER / USAGE / SET stay where they are.
    expect(probeSql).not.toContain('session_user')
    expect(probeSql).not.toContain("'MEMBER'")
  })

  it('records the bucket detail for AUDIT, not as a gate input', () => {
    // The criterion consumes evidenceBucketExists.observed and nothing else.
    // Recording public / size / MIME is auditable evidence; a reader must not
    // mistake it for something a gate rests on.
    expect(probeSql).toContain('bucketDetail')
    expect(probeSql).toContain('allowed_mime_types')
  })
})

describe('the historical artefact stays historical', () => {
  it('is still on disk and still declared in the ledger', () => {
    const historical = 'artifacts/class-c-probes/2026-08-07-uellix-staging.json'
    expect(existsSync(path.join(ROOT, historical))).toBe(true)
    expect(CLASS_C_SQL_EDITOR_EVIDENCE.map((e) => e.path)).toContain(historical)
  })

  it('records why it is superseded rather than being deleted', () => {
    const entry = CLASS_C_SQL_EDITOR_EVIDENCE.find((e) => e.path.includes('2026-08-07'))
    expect(entry?.note).toMatch(/SUPERSEDED|superseded/)
  })

  it('stops being the ACTIVE entry the moment a later one is declared', () => {
    const newer: ClassCEvidenceEntry = {
      path: 'artifacts/class-c-probes/2026-08-09-uellix-staging.json',
      measuredOn: '2026-08-09',
      projectRef: KNOWN_STAGING_PROJECT_REF,
      note: 'post-baseline re-measurement',
    }
    const r = resolveClassCEvidence(KNOWN_STAGING_PROJECT_REF, [...CLASS_C_SQL_EDITOR_EVIDENCE, newer])
    expect(r.ok && r.entry.path).toBe(newer.path)
    expect(r.ok && r.entry.path).not.toContain('2026-08-07')
  })
})
