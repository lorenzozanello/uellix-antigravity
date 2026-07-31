// lib/grounding/__tests__/chunk.test.ts
// U3: deterministic chunking + reconstructible citation anchors.
// Property tests: anchor reconstruction, full non-whitespace coverage,
// determinism, CRLF/LF stability.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { extractDocument, type ExtractionResult } from '../extract'
import {
  chunkText,
  chunkExtraction,
  normalizeForAnchors,
  DEFAULT_TARGET_CHARS,
  DEFAULT_OVERLAP_CHARS,
  type DocumentChunk,
} from '../chunk'

const FIXTURES = path.resolve(process.cwd(), 'audit-fixtures', 'agua-segura')
const fixtureText = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8')

const EVIDENCE_ID = 'ev-agua-0001'

function assertReconstruction(chunks: DocumentChunk[], originalText: string) {
  const norm = normalizeForAnchors(originalText)
  for (const chunk of chunks) {
    expect(chunk.anchor.evidenceId).toBe(EVIDENCE_ID)
    // Anchor invariant: slicing the normalized source by [charStart, charEnd)
    // reproduces the chunk text exactly.
    expect(norm.slice(chunk.anchor.charStart, chunk.anchor.charEnd)).toBe(chunk.text)
  }
}

function assertFullCoverage(chunks: DocumentChunk[], originalText: string) {
  const norm = normalizeForAnchors(originalText)
  const covered = new Array<boolean>(norm.length).fill(false)
  for (const chunk of chunks) {
    for (let i = chunk.anchor.charStart; i < chunk.anchor.charEnd; i++) covered[i] = true
  }
  for (let i = 0; i < norm.length; i++) {
    if (/\s/.test(norm[i])) continue
    expect(covered[i], `non-whitespace char at offset ${i} is not covered by any chunk`).toBe(true)
  }
}

describe('chunkText — real fixtures', () => {
  const fixtures = ['linea-base.csv', 'encuesta-final.csv', 'asistencia.csv', 'testimonios.txt']

  for (const name of fixtures) {
    it(`${name}: anchors reconstruct and cover all non-whitespace content`, () => {
      const text = fixtureText(name)
      const chunks = chunkText(text, { evidenceId: EVIDENCE_ID })
      expect(chunks.length).toBeGreaterThan(0)
      assertReconstruction(chunks, text)
      assertFullCoverage(chunks, text)
    })
  }

  it('produces sequential chunk indexes, page null and bounded sizes', () => {
    const text = fixtureText('linea-base.csv')
    const chunks = chunkText(text, { evidenceId: EVIDENCE_ID })
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i)
      expect(chunk.anchor.page).toBeNull()
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_TARGET_CHARS)
      expect(chunk.text.length).toBeGreaterThan(0)
    })
  })

  it('overlaps consecutive chunks by roughly the configured overlap', () => {
    const text = fixtureText('linea-base.csv')
    const chunks = chunkText(text, { evidenceId: EVIDENCE_ID })
    expect(chunks.length).toBeGreaterThan(2)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]
      const curr = chunks[i]
      // next chunk starts before the previous ends (overlap), but after its start
      expect(curr.anchor.charStart).toBeLessThan(prev.anchor.charEnd)
      expect(curr.anchor.charStart).toBeGreaterThan(prev.anchor.charStart)
      const overlap = prev.anchor.charEnd - curr.anchor.charStart
      expect(overlap).toBeLessThanOrEqual(DEFAULT_OVERLAP_CHARS)
    }
  })

  it('prefers breaking on line boundaries for row-structured content', () => {
    const text = fixtureText('linea-base.csv')
    const chunks = chunkText(text, { evidenceId: EVIDENCE_ID })
    // every non-final chunk of a CSV should end exactly at a row boundary
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.endsWith('\n')).toBe(true)
    }
  })
})

describe('chunkText — properties', () => {
  it('is deterministic: same input twice yields identical output', () => {
    const text = fixtureText('testimonios.txt')
    const a = chunkText(text, { evidenceId: EVIDENCE_ID })
    const b = chunkText(text, { evidenceId: EVIDENCE_ID })
    expect(a).toEqual(b)
  })

  it('is stable under CRLF vs LF line endings', () => {
    const lf = fixtureText('asistencia.csv').replace(/\r\n/g, '\n')
    const crlf = lf.replace(/\n/g, '\r\n')
    const a = chunkText(lf, { evidenceId: EVIDENCE_ID })
    const b = chunkText(crlf, { evidenceId: EVIDENCE_ID })
    expect(a).toEqual(b)
  })

  it('normalizeForAnchors maps CRLF and lone CR to LF (documented normalization)', () => {
    expect(normalizeForAnchors('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('', { evidenceId: EVIDENCE_ID })).toEqual([])
    expect(chunkText('  \n\r\n\t ', { evidenceId: EVIDENCE_ID })).toEqual([])
  })

  it('breaks on paragraph boundaries when present', () => {
    const para = 'p'.repeat(600)
    const text = `${para}\n\n${'q'.repeat(600)}`
    const chunks = chunkText(text, { evidenceId: EVIDENCE_ID })
    expect(chunks.length).toBeGreaterThan(1)
    // first chunk should end at the paragraph break, not mid-word at 1000
    expect(chunks[0].text.trimEnd()).toBe(para)
    assertReconstruction(chunks, text)
    assertFullCoverage(chunks, text)
  })

  it('hard-splits pathological unbroken text while preserving invariants', () => {
    const text = 'x'.repeat(3517)
    const chunks = chunkText(text, { evidenceId: EVIDENCE_ID })
    expect(chunks.length).toBeGreaterThan(3)
    assertReconstruction(chunks, text)
    assertFullCoverage(chunks, text)
  })
})

describe('chunkExtraction', () => {
  it('chunks an unpaged extraction with page: null anchors', () => {
    const extraction = extractDocument(
      readFileSync(path.join(FIXTURES, 'testimonios.txt')),
      'text/plain',
    )
    const chunks = chunkExtraction(extraction, EVIDENCE_ID)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) expect(chunk.anchor.page).toBeNull()
    assertReconstruction(chunks, extraction.text)
  })

  it('chunks page-aware extractions per page with continuous indexes', () => {
    const extraction: ExtractionResult = {
      status: 'extracted',
      text: '',
      pages: [
        { page: 1, text: 'Primera página.\n' + 'a'.repeat(1200) },
        { page: 2, text: 'Segunda página.\n' + 'b'.repeat(300) },
      ],
      tables: [],
      warnings: [],
      meta: { chars: 0, truncated: false },
    }
    const chunks = chunkExtraction(extraction, EVIDENCE_ID)
    const page1 = chunks.filter((c) => c.anchor.page === 1)
    const page2 = chunks.filter((c) => c.anchor.page === 2)
    expect(page1.length).toBeGreaterThan(1)
    expect(page2.length).toBe(1)
    // chunkIndex is continuous across the whole document
    chunks.forEach((chunk, i) => expect(chunk.chunkIndex).toBe(i))
    // page-scoped anchors: offsets are relative to that page's normalized text
    for (const chunk of page2) {
      expect(normalizeForAnchors(extraction.pages[1].text).slice(
        chunk.anchor.charStart,
        chunk.anchor.charEnd,
      )).toBe(chunk.text)
    }
  })

  it('returns no chunks for unsupported or error extractions', () => {
    const unsupported = extractDocument(Buffer.from('%PDF-1.7'), 'application/pdf')
    expect(chunkExtraction(unsupported, EVIDENCE_ID)).toEqual([])
  })
})
