// @vitest-environment node
// tests/recovery/artifact-integrity.test.ts — OR-N2 (digest mismatch ignored ->
// RED), OR-N17 (artifact inside the repository -> RED), TOC structure and the
// TOC selection that replaced DROP SCHEMA public (NB-5).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkArchiveStructure, checkArtifactLocation, isInsideDirectory, parseArchiveToc, selectTocForExistingPublic, verifyArtifactDigest } from '../../scripts/recovery/artifact-integrity'
import { sampleCensus, samplePacket } from './sample-evidence'

const REPO = path.resolve(import.meta.dirname, '../..')
// Allocated in the executed lifecycle, never at collection time (NB-6).
let dir = ''
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'uellix-recovery-unit-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function artifact(bytes: Buffer) {
  const sha = createHash('sha256').update(bytes).digest('hex')
  const p = path.join(dir, `a-${sha.slice(0, 8)}.dump`)
  writeFileSync(p, bytes)
  return { p, packet: samplePacket({ artifactSha256: sha }) }
}

// The real listing captured from the synthetic fixture (prototype run, 2026-09-23), trimmed.
const LISTING = [
  ';',
  '; Archive created at 2026-09-23 20:00:35 UTC',
  ';     dbname: fixture_src',
  ';     TOC Entries: 42',
  ';     Compression: gzip',
  ';     Dump Version: 1.16-0',
  ';     Format: CUSTOM',
  ';     Dumped from database version: 17.6',
  ';     Dumped by pg_dump version: 17.6',
  ';',
  '; Selected TOC Entries:',
  ';',
  '5; 2615 2200 SCHEMA - public pg_database_owner',
  '3498; 0 0 COMMENT - SCHEMA public pg_database_owner',
  '7; 2615 16784 SCHEMA - uellix_provisioning fixture_app_owner',
  '2; 3079 16666 EXTENSION - pg_trgm ',
  '224; 1259 16770 TABLE public fixture_audit fixture_app_owner',
  '223; 1259 16769 SEQUENCE public fixture_audit_id_seq fixture_app_owner',
  '222; 1259 16756 TABLE public fixture_member fixture_app_owner',
  '220; 1259 16748 TABLE public fixture_org fixture_app_owner',
  '226; 1259 16786 TABLE uellix_provisioning applied_units fixture_app_owner',
  '3489; 0 16770 TABLE DATA public fixture_audit fixture_app_owner',
  '3487; 0 16756 TABLE DATA public fixture_member fixture_app_owner',
  '',
].join('\n')

describe('artifact location (layer 1)', () => {
  it('OR-N17: an artifact inside the repository working tree is refused, tracked or not', () => {
    expect(checkArtifactLocation(path.join(REPO, 'tmp', 'x.dump'), REPO)).toEqual({ ok: false, code: 'ARTIFACT_INSIDE_REPOSITORY' })
    expect(checkArtifactLocation(REPO, REPO)).toEqual({ ok: false, code: 'ARTIFACT_INSIDE_REPOSITORY' })
    expect(checkArtifactLocation(path.join(REPO, 'a', '..', 'b', 'c.dump'), REPO)).toEqual({ ok: false, code: 'ARTIFACT_INSIDE_REPOSITORY' })
  })

  it('OR-N17: case differences do not escape the check on Windows', () => {
    if (process.platform !== 'win32') return
    expect(isInsideDirectory(path.join(REPO.toUpperCase(), 'x.dump'), REPO)).toBe(true)
  })

  it('a relative path is refused; the OS temp directory is accepted', () => {
    expect(checkArtifactLocation('x.dump', REPO)).toEqual({ ok: false, code: 'ARTIFACT_PATH_NOT_ABSOLUTE' })
    expect(checkArtifactLocation(path.join(dir, 'x.dump'), REPO)).toBeNull()
  })
})

describe('artifact digest (layer 2)', () => {
  it('accepts bytes whose recomputed sha256 matches the packet content digest', async () => {
    const { p, packet } = artifact(Buffer.from('PGDMP-synthetic-bytes-1'))
    expect(await verifyArtifactDigest(packet, p, REPO)).toMatchObject({ ok: true })
  })

  it('OR-N2: one flipped byte is a DIGEST mismatch', async () => {
    const { p, packet } = artifact(Buffer.from('PGDMP-synthetic-bytes-2'))
    writeFileSync(p, Buffer.from('PGDMP-synthetic-bytes-3'))
    expect(await verifyArtifactDigest(packet, p, REPO)).toEqual({ ok: false, code: 'ARTIFACT_DIGEST_MISMATCH' })
  })

  it('OR-N2: truncation is a DIGEST mismatch; absence is ABSENT', async () => {
    const { p, packet } = artifact(Buffer.from('PGDMP-synthetic-bytes-4'))
    writeFileSync(p, Buffer.from('PGDMP'))
    expect(await verifyArtifactDigest(packet, p, REPO)).toEqual({ ok: false, code: 'ARTIFACT_DIGEST_MISMATCH' })
    expect(await verifyArtifactDigest(packet, path.join(dir, 'missing.dump'), REPO)).toEqual({ ok: false, code: 'ARTIFACT_ABSENT' })
  })
})

describe('archive structure (layer 3)', () => {
  it('parses the header and TABLE entries, never TABLE DATA as a table', () => {
    const toc = parseArchiveToc(LISTING)
    expect(toc).toMatchObject({ format: 'CUSTOM', dumpedFrom: '17.6', dumpedBy: '17.6', createsPublicSchema: true })
    expect(toc.tables).toEqual(['public.fixture_audit', 'public.fixture_member', 'public.fixture_org', 'uellix_provisioning.applied_units'])
  })

  it('OR-N1: TABLE entries must equal the bound census relations exactly', () => {
    const census = sampleCensus()
    expect(checkArchiveStructure(parseArchiveToc(LISTING), census)).toBeNull()
    const missing = LISTING.replace(/^222; .*$/m, '')
    expect(checkArchiveStructure(parseArchiveToc(missing), census)).toEqual({ ok: false, code: 'ARTIFACT_TOC_RELATIONS_MISMATCH' })
  })

  it('OR-N1: a non-custom or empty archive is refused', () => {
    const census = sampleCensus()
    expect(checkArchiveStructure(parseArchiveToc(LISTING.replace('Format: CUSTOM', 'Format: TAR')), census)).toEqual({ ok: false, code: 'ARTIFACT_TOC_NOT_CUSTOM_FORMAT' })
    expect(checkArchiveStructure(parseArchiveToc([';', ';     Format: CUSTOM', ''].join('\n')), census)).toEqual({ ok: false, code: 'ARTIFACT_TOC_EMPTY' })
  })
})

describe('TOC selection (NB-5: replaces DROP SCHEMA public)', () => {
  it("removes exactly the archive's own SCHEMA - public entry and keeps everything else in order", () => {
    const { list, removed } = selectTocForExistingPublic(LISTING)
    expect(removed).toBe(1)
    expect(list).not.toMatch(/SCHEMA - public /)
    expect(list).toContain('SCHEMA - uellix_provisioning')
    expect(list).toContain('EXTENSION - pg_trgm')
    expect(list.split('\n')).toEqual(LISTING.split('\n').filter((l) => !l.startsWith('5; 2615 2200 SCHEMA - public ')))
  })

  it('removes nothing from an archive that does not create public', () => {
    expect(selectTocForExistingPublic(LISTING.replace(/^5; .*$/m, '')).removed).toBe(0)
  })
})
