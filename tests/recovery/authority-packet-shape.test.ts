// @vitest-environment node
// tests/recovery/authority-packet-shape.test.ts — the B-1 regression.
//
// The recert of ec573e9b failed this lane because BACKUP_PACKET and
// RESTORE_PROOF ENLARGED frozen packet shapes (13 and 21 top-level keys against
// 6 and 5). This file exists so that can never pass again. Its oracle is the
// AUTHORITY FILE, read here with plain fs/JSON — not the implementation's
// TypeScript schema, not frozenPacketContents(), not BACKUP_PACKET_SHAPE — so an
// implementer who blesses an extra key in their own schema still goes red.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateBackupPacket } from '../../scripts/recovery/artifact-packet'
import { validateRestoreProof } from '../../scripts/recovery/restore-proof'
import { samplePacket, sampleRestoreProof } from './sample-evidence'

const AUTHORITY = path.resolve(import.meta.dirname, '../../docs/ops/release/STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json')

function authorityContents(packet: string): string[] {
  const doc = JSON.parse(readFileSync(AUTHORITY, 'utf8'))
  const hits: string[][] = []
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk)
    else if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>
      if (r.packet === packet && Array.isArray(r.contents)) hits.push(r.contents as string[])
      Object.values(r).forEach(walk)
    }
  }
  walk(doc)
  expect(hits, `${packet} must be defined exactly once in the authority`).toHaveLength(1)
  return hits[0]
}

const BACKUP = authorityContents('BACKUP_PACKET')
const RESTORE = authorityContents('RESTORE_PROOF')

describe('authority: the frozen contents, machine-derived', () => {
  it('BACKUP_PACKET has six contents and RESTORE_PROOF has five (derived, then checked against the expected cardinality)', () => {
    expect(BACKUP).toHaveLength(6)
    expect(RESTORE).toHaveLength(5)
  })
})

describe('B-1: emitted packets carry EXACTLY the authority contents, in order', () => {
  it('BACKUP_PACKET top-level keys === authority contents', () => {
    expect(Object.keys(samplePacket())).toEqual(BACKUP)
    expect(validateBackupPacket(samplePacket())).toEqual([])
  })

  it('RESTORE_PROOF top-level keys === authority contents', () => {
    expect(Object.keys(sampleRestoreProof())).toEqual(RESTORE)
    expect(validateRestoreProof(sampleRestoreProof())).toEqual([])
  })

  it('the lane-required data is still present, NESTED inside the frozen contents (event_class, census binding, engine, PRI-7, erasure)', () => {
    const p = samplePacket({ eventClass: 'S1_CORPUS_NO_NEW_RUNTIME' }) as unknown as Record<string, Record<string, unknown>>
    const confirmation = p[BACKUP[5]] as { the_change_it_precedes: { event_class: unknown }; capture_census: { pre_capture_census_sha256: string } }
    expect(confirmation.the_change_it_precedes.event_class).toEqual({ value: 'S1_CORPUS_NO_NEW_RUNTIME', policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' })
    expect(confirmation.capture_census.pre_capture_census_sha256).toMatch(/^[0-9a-f]{64}$/)
    const proof = sampleRestoreProof() as unknown as Record<string, Record<string, unknown>>
    expect(Object.keys(proof[RESTORE[1]])).toEqual(expect.arrayContaining(['image_id_observed', 'engine', 'created_at', 'destruction']))
    expect(Object.keys(proof[RESTORE[3]])).toEqual(expect.arrayContaining(['invariants', 'storage_object_bytes', 'governed_erasure_on_source']))
  })
})

describe('B-1 regression: every way of breaking the frozen shape is RED', () => {
  const variants = (base: Record<string, unknown>, contents: string[]) => {
    const moveNested = { ...base, event_class: { value: null } }
    const removed = Object.fromEntries(Object.entries(base).filter(([k]) => k !== contents[2]))
    const renamed = Object.fromEntries(Object.entries(base).map(([k, v]) => [k === contents[0] ? `${k}_v2` : k, v]))
    const reordered = Object.fromEntries(Object.entries(base).reverse())
    const extra = { ...base, data_classification: 'SYNTHETIC_FIXTURE' }
    return { 'one unknown top-level field added': extra, 'one required field removed': removed, 'a nested datum moved to top level': moveNested, 'a top-level field renamed': renamed, 'contents reordered': reordered }
  }

  for (const [name, v] of Object.entries(variants(samplePacket() as unknown as Record<string, unknown>, BACKUP))) {
    it(`BACKUP_PACKET: ${name} -> refused, and its keys differ from the authority`, () => {
      expect(Object.keys(v)).not.toEqual(BACKUP)
      expect(validateBackupPacket(v).length).toBeGreaterThan(0)
    })
  }

  for (const [name, v] of Object.entries(variants(sampleRestoreProof() as unknown as Record<string, unknown>, RESTORE))) {
    it(`RESTORE_PROOF: ${name} -> refused, and its keys differ from the authority`, () => {
      expect(Object.keys(v)).not.toEqual(RESTORE)
      expect(validateRestoreProof(v).length).toBeGreaterThan(0)
    })
  }
})
