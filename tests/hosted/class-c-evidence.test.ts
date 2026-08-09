// tests/hosted/class-c-evidence.test.ts
//
// Class-C evidence is SELECTED, and the selection has to be governed.
//
// `SQL_EDITOR_ARTEFACT` was a hardcoded dated filename. Honest with one
// measurement; a trap the moment the world moved. The 2026-08-07 probe recorded
// `evidenceBucketExists: false` and, after the bucket was created, the gate kept
// reading that answer. The artefact was not wrong — the selection was.

import { describe, expect, it } from 'vitest'

import {
  CLASS_C_SQL_EDITOR_EVIDENCE,
  resolveClassCEvidence,
  type ClassCEvidenceEntry,
} from '@/db/hosted/measured-evidence'
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
