// lib/grounding/__tests__/classification-boundary.test.ts
// F-ED-4 — the grounding-ingestion classification boundary.
//
// Every existing Stella model-bound context builder
// (`lib/stella/context/build-*-context.ts`) already refuses to hand an
// external model any evidence whose CURRENT `sensitivity_classification` is
// not exactly `'non_sensitive'` — unclassified included. This suite proves
// `resolveEvidenceSource` (lib/grounding/ingest/resolve-evidence-source.ts)
// now enforces the identical boundary at the one seam every ingested BYTE
// must cross, so a restricted evidence item's content can never be WRITTEN
// into the grounding corpus by this resolver, regardless of what a caller
// upstream authorized.
//
// SCOPE, NAMED: this is an INGESTION-TIME gate. It says nothing about
// evidence that was ALREADY ingested while non_sensitive and is later
// reclassified, or whose content is later erased (FIBIU-05/07,
// lib/pipeline/evidence.ts) — neither path purges `evidence_chunks`, and
// this suite does not exercise or claim otherwise. See the F-ED-4 PR's own
// audit trail for that residual gap; closing it needs `lib/grounding/
// retrieve/**` or `db/**`, both explicitly out of this LANE's authority.
//
// This file tests ONLY the classification axis and its interaction with the
// axes `resolve-evidence-source.test.ts` already covers (scope, kind, hash,
// size) — it does not re-derive those suites' full coverage. It also does
// NOT prove the action layer (app/actions/grounding/ingest-evidence.ts)
// actually reads and forwards this value rather than manufacturing it —
// see the dedicated "F-ED-4" describe block in
// app/actions/grounding/__tests__/ingest-evidence.test.ts for that.

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { MAX_GROUNDING_INPUT_BYTES } from '@/lib/grounding/extract'
import {
  resolveEvidenceSource,
  type EvidenceObjectReader,
  type EvidenceSourceRecord,
} from '@/lib/grounding/ingest/resolve-evidence-source'
import type { GroundingScope } from '@/lib/grounding/contracts'

const ORG = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'

const scope: GroundingScope = { organizationId: ORG, projectId: PROJECT }

/** A reader that returns fixed bytes and records every path it was asked to read. */
function readerReturning(bytes: Buffer | null): EvidenceObjectReader & { calls: string[] } {
  const calls: string[] = []
  return {
    id: 'test-reader',
    calls,
    async read(filePath: string) {
      calls.push(filePath)
      return bytes
    },
  }
}

function textRecord(overrides: Partial<EvidenceSourceRecord> = {}): EvidenceSourceRecord {
  const text = 'Encuesta de salida, marzo. 84 participantes completaron el programa.'
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'text',
    title: 'Encuesta de salida',
    description: text,
    filePath: null,
    fileSize: null,
    mimeType: null,
    contentHash: sha256(text),
    sensitivityClassification: 'non_sensitive',
    ...overrides,
  }
}

function fileRecord(
  bytes: Buffer,
  overrides: Partial<EvidenceSourceRecord> = {},
): EvidenceSourceRecord {
  return {
    id: EVIDENCE,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'file',
    title: 'padron.csv',
    description: 'Padrón de participantes',
    filePath: `${PROJECT}/${EVIDENCE}/padron.csv`,
    fileSize: bytes.length,
    mimeType: 'text/csv',
    contentHash: sha256(bytes),
    sensitivityClassification: 'non_sensitive',
    ...overrides,
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** Every restricted value the FIBIU-05 vocabulary (db/schema.ts, 0049) defines. */
const RESTRICTED_CLASSIFICATIONS = [
  'personal_data',
  'identifiable_restricted',
  'confidential_third_party',
  'special_category',
] as const

describe('non_sensitive is the only classification that clears ingestion', () => {
  it('allows text evidence classified non_sensitive', async () => {
    const result = await resolveEvidenceSource(
      textRecord({ sensitivityClassification: 'non_sensitive' }),
      scope,
      readerReturning(null),
    )

    expect(result.kind).toBe('resolved')
  })

  it('allows file evidence classified non_sensitive', async () => {
    const bytes = Buffer.from('nombre,edad\nAna,34\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { sensitivityClassification: 'non_sensitive' }),
      scope,
      reader,
    )

    expect(result.kind).toBe('resolved')
    expect(reader.calls).toHaveLength(1)
  })
})

describe('missing classification is denied — unclassified is not implicitly safe', () => {
  it('refuses text evidence with a null classification', async () => {
    const result = await resolveEvidenceSource(
      textRecord({ sensitivityClassification: null }),
      scope,
      readerReturning(null),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
  })

  it('refuses file evidence with a null classification and never consults the reader', async () => {
    const bytes = Buffer.from('a,b\n1,2\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { sensitivityClassification: null }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
    expect(reader.calls).toEqual([])
  })
})

describe('every restricted classification is denied, with the same refusal reason', () => {
  it.each(RESTRICTED_CLASSIFICATIONS)('refuses file evidence classified %s and never reads the object', async (classification) => {
    const bytes = Buffer.from('a,b\n1,2\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { sensitivityClassification: classification }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
    expect(reader.calls).toEqual([])
  })

  it.each(RESTRICTED_CLASSIFICATIONS)('refuses text evidence classified %s', async (classification) => {
    const result = await resolveEvidenceSource(
      textRecord({ sensitivityClassification: classification }),
      scope,
      readerReturning(null),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
  })

  it('refuses a value the FIBIU-05 vocabulary does not define, identically — the predicate accepts one value, it does not deny-list the rest', async () => {
    const result = await resolveEvidenceSource(
      textRecord({ sensitivityClassification: 'not_a_real_classification' }),
      scope,
      readerReturning(null),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
  })

  it('never reveals which restricted classification applied — the detail text is identical across all of them', async () => {
    const details = new Set<string>()

    for (const classification of [...RESTRICTED_CLASSIFICATIONS, null, 'not_a_real_classification']) {
      const result = await resolveEvidenceSource(
        textRecord({ sensitivityClassification: classification }),
        scope,
        readerReturning(null),
      )
      if (result.kind !== 'refused') throw new Error('expected a refusal')
      details.add(result.detail)
      expect(result.detail.toLowerCase()).not.toContain('personal')
      expect(result.detail.toLowerCase()).not.toContain('special')
      expect(result.detail.toLowerCase()).not.toContain('confidential')
      expect(result.detail.toLowerCase()).not.toContain('identifiable')
    }

    // One detail string, regardless of which of the six inputs above produced
    // it: that sameness IS the non-oracular property, not an incidental one.
    expect(details.size).toBe(1)
  })
})

describe('ordering — classification is decided before ANY byte is read', () => {
  it('refuses on classification even for a kind this resolver never supports, proving classification runs before the kind branch', async () => {
    // `url` evidence refuses 'unsupported_kind' on its own (see
    // resolve-evidence-source.test.ts). Pairing it with a restricted
    // classification and getting 'classification_restricted' back — not
    // 'unsupported_kind' — is only possible if the classification gate runs
    // FIRST, before the kind switch even inspects `evidence.type`.
    const result = await resolveEvidenceSource(
      textRecord({ type: 'url', description: null, sensitivityClassification: 'special_category' }),
      scope,
      readerReturning(null),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
  })

  it('refuses text evidence before its own row content is ever inspected', async () => {
    // Text evidence has no reader to instrument — its "bytes" are the row's
    // own `description`. A malformed row (hash that could never match its
    // description) still refuses on CLASSIFICATION, not on
    // 'content_hash_mismatch' — proof the classification gate runs before
    // resolveTextBytes, not merely before a storage round trip.
    const result = await resolveEvidenceSource(
      textRecord({
        sensitivityClassification: 'personal_data',
        description: 'contenido cualquiera',
        contentHash: '0'.repeat(64),
      }),
      scope,
      readerReturning(null),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'classification_restricted' })
  })

  it('MUTATION CONTROL — this exact case is what deleting the classification gate breaks: a restricted, otherwise-fully-valid file resolves cleanly with the gate removed. Deleting the `if (evidence.sensitivityClassification !== \'non_sensitive\')` branch in resolve-evidence-source.ts turns this expectation from `refused` into `resolved` and the reader-was-never-consulted assertion into a false one.', async () => {
    const bytes = Buffer.from('nombre,dni\nAna,12345678\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, { sensitivityClassification: 'special_category' }),
      scope,
      reader,
    )

    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') return
    expect(result.reason).toBe('classification_restricted')
    expect(reader.calls).toEqual([])
  })
})

describe('scope behavior is unchanged by the classification gate', () => {
  it('still refuses scope_mismatch for a non_sensitive row outside the requested scope', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')

    const result = await resolveEvidenceSource(
      fileRecord(bytes, {
        projectId: OTHER_PROJECT,
        filePath: `${OTHER_PROJECT}/${EVIDENCE}/padron.csv`,
        sensitivityClassification: 'non_sensitive',
      }),
      scope,
      readerReturning(bytes),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'scope_mismatch' })
  })

  it('scope is still decided before classification: a mismatched-scope row refuses scope_mismatch even when its classification is restricted', async () => {
    const bytes = Buffer.from('a,b\n', 'utf8')
    const reader = readerReturning(bytes)

    const result = await resolveEvidenceSource(
      fileRecord(bytes, {
        projectId: OTHER_PROJECT,
        filePath: `${OTHER_PROJECT}/${EVIDENCE}/padron.csv`,
        sensitivityClassification: 'special_category',
      }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'scope_mismatch' })
    expect(reader.calls).toEqual([])
  })
})

describe('hash behavior is unchanged by the classification gate', () => {
  it('a non_sensitive row still refuses content_hash_mismatch when stored bytes disagree with the recorded hash', async () => {
    const declared = Buffer.from('lo que se autorizó', 'utf8')
    const actual = Buffer.from('otra cosa', 'utf8')

    const result = await resolveEvidenceSource(
      fileRecord(declared, { sensitivityClassification: 'non_sensitive' }),
      scope,
      readerReturning(actual),
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'content_hash_mismatch' })
  })
})

describe('size behavior is unchanged by the classification gate', () => {
  it('a non_sensitive row still refuses input_too_large on the declared size, before the reader is consulted', async () => {
    const reader = readerReturning(Buffer.from('small', 'utf8'))

    const result = await resolveEvidenceSource(
      fileRecord(Buffer.from('small', 'utf8'), {
        fileSize: MAX_GROUNDING_INPUT_BYTES + 1,
        sensitivityClassification: 'non_sensitive',
      }),
      scope,
      reader,
    )

    expect(result).toMatchObject({ kind: 'refused', reason: 'input_too_large' })
    expect(reader.calls).toEqual([])
  })
})
