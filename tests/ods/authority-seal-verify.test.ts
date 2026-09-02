// tests/ods/authority-seal-verify.test.ts — ODS-C2 positive and negative controls.
//
// Per the negative-control doctrine (docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json),
// a gate is not complete until its FAIL path has been deliberately exercised.
// These tests never mutate a real certified artifact — only fixture copies in
// a temporary git repository, or fabricated in-memory values fed to the pure
// verification functions.

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  sha256OfTextLfNormalized,
  checkOdsAuthorityInputIntegrity,
  assertCorpusCount,
  EXPECTED_PROTECTED_CORPUS_COUNT,
  extractCorpusArtifacts,
  extractTransitivelyAttestedFiles,
  extractAnchorCommit,
  checkCorpusArtifact,
  getDottedField,
  checkRelation,
} from '../../scripts/authority-seal-verify'
import {
  makeTempGitRepo,
  commitFile,
  mutateFile,
  blobAt,
  hashObjectCurrent,
  catFileBlob,
  cleanupTempGitRepo,
} from './git-fixture-helpers'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

describe('sha256OfTextLfNormalized', () => {
  it('normalizes CRLF to LF before hashing', () => {
    expect(sha256OfTextLfNormalized('a\r\nb\r\n')).toBe(sha256OfTextLfNormalized('a\nb\n'))
  })

  it('produces the known digest of an empty string', () => {
    expect(sha256OfTextLfNormalized('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.slice(0, 64))
  })
})

describe('checkOdsAuthorityInputIntegrity — POSITIVE and NEGATIVE', () => {
  it('PASS when current blob matches frozen blob', () => {
    expect(checkOdsAuthorityInputIntegrity('abc123', 'abc123')).toBe(true)
  })

  it('NEGATIVE CONTROL: FAIL when current blob differs from the frozen blob', () => {
    expect(checkOdsAuthorityInputIntegrity('abc123', 'def456')).toBe(false)
  })
})

describe('assertCorpusCount — NEGATIVE CONTROL: reduced corpus membership', () => {
  it('PASS at exactly 9', () => {
    expect(assertCorpusCount(9)).toBe(true)
  })

  it('FAILS when the corpus is reduced to 8', () => {
    expect(assertCorpusCount(8)).toBe(false)
  })

  it('FAILS when the corpus is expanded to 10 without an explicit gate-version bump', () => {
    expect(assertCorpusCount(10)).toBe(false)
  })

  it('matches the frozen HPO-ODS-03 constant', () => {
    expect(EXPECTED_PROTECTED_CORPUS_COUNT).toBe(9)
  })
})

describe('extractCorpusArtifacts / extractTransitivelyAttestedFiles / extractAnchorCommit', () => {
  it('reads the real frozen 9-artifact corpus from the committed ODS authority file', () => {
    const authority = JSON.parse(
      spawnSync('git', ['show', 'HEAD:docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).stdout,
    )
    const artifacts = extractCorpusArtifacts(authority)
    expect(artifacts.length).toBe(9)
    expect(extractTransitivelyAttestedFiles(authority).length).toBe(4)
    expect(extractAnchorCommit(authority)).toBe('ff2ab23fbf2178a8b4930bd3943d3c53bc84a1dc')
  })

  it('NEGATIVE CONTROL: throws on a missing authority_corpus.artifacts shape', () => {
    expect(() => extractCorpusArtifacts({})).toThrow()
  })

  it('NEGATIVE CONTROL: throws on a malformed artifact entry', () => {
    expect(() => extractCorpusArtifacts({ authority_corpus: { artifacts: [{ path: 'x' }] } })).toThrow()
  })

  it('NEGATIVE CONTROL: throws on missing transitively_attested_files', () => {
    expect(() => extractTransitivelyAttestedFiles({ authority_corpus: {} })).toThrow()
  })

  it('NEGATIVE CONTROL: throws on missing anchor_commit', () => {
    expect(() => extractAnchorCommit({ authority_corpus: {} })).toThrow()
  })
})

describe('getDottedField / checkRelation', () => {
  it('reads a nested field by dotted path', () => {
    expect(getDottedField({ a: { b: { c: 'value' } } }, 'a.b.c')).toBe('value')
  })

  it('returns undefined for a missing dotted path', () => {
    expect(getDottedField({ a: {} }, 'a.b.c')).toBeUndefined()
  })

  it('PASS when the attested value equals the computed hash', () => {
    expect(checkRelation('deadbeef', 'deadbeef')).toBe(true)
  })

  it('NEGATIVE CONTROL: FAIL on a false native attestation relationship', () => {
    expect(checkRelation('deadbeef', 'not-deadbeef')).toBe(false)
  })

  it('NEGATIVE CONTROL: FAIL when the attested field is missing (undefined)', () => {
    expect(checkRelation(undefined, 'anything')).toBe(false)
  })
})

describe('checkCorpusArtifact — real temp-repo fixture, POSITIVE and NEGATIVE', () => {
  let dir: string

  afterEach(() => {
    if (dir) cleanupTempGitRepo(dir)
  })

  it('PASS when the current fixture file is untouched since the certifying commit', () => {
    dir = makeTempGitRepo()
    const content = 'ODS fixture authority content\n'
    const commit = commitFile(dir, 'authority.json', content)
    const certifiedBlob = blobAt(dir, commit, 'authority.json')
    const currentBlob = hashObjectCurrent(dir, 'authority.json')
    const certifiedBytes = catFileBlob(dir, certifiedBlob)

    const result = checkCorpusArtifact({
      record: { path: 'authority.json', blob_sha1: certifiedBlob, content_sha256: sha256OfTextLfNormalized(content) },
      currentBytes: Buffer.from(content),
      currentGitBlobSha1: currentBlob,
      certifiedGitBlobSha1: certifiedBlob,
      certifiedBytes,
    })

    expect(result.pass).toBe(true)
    expect(result.gitBlobIdentityPass).toBe(true)
    expect(result.recordedBlobMatchesAnchorPass).toBe(true)
    expect(result.contentSha256MatchesRecordPass).toBe(true)
    expect(result.contentSha256MatchesAnchorPass).toBe(true)
  })

  it('NEGATIVE CONTROL: a deliberately 1-byte-mutated fixture copy FAILS git blob identity', () => {
    dir = makeTempGitRepo()
    const original = 'ODS fixture authority content\n'
    const commit = commitFile(dir, 'authority.json', original)
    const certifiedBlob = blobAt(dir, commit, 'authority.json')
    const certifiedBytes = catFileBlob(dir, certifiedBlob)

    // Deliberately flip one byte on disk WITHOUT committing — a real,
    // git-verifiable divergence from the certified blob.
    const mutated = 'ODS fixture authority Content\n' // capital 'C' — 1 byte different
    mutateFile(dir, 'authority.json', mutated)
    const mutatedBlob = hashObjectCurrent(dir, 'authority.json')

    expect(mutatedBlob).not.toBe(certifiedBlob)

    const result = checkCorpusArtifact({
      record: { path: 'authority.json', blob_sha1: certifiedBlob, content_sha256: sha256OfTextLfNormalized(original) },
      currentBytes: Buffer.from(mutated),
      currentGitBlobSha1: mutatedBlob,
      certifiedGitBlobSha1: certifiedBlob,
      certifiedBytes,
    })

    expect(result.pass).toBe(false)
    expect(result.gitBlobIdentityPass).toBe(false)
    expect(result.contentSha256MatchesRecordPass).toBe(false)
    expect(result.contentSha256MatchesAnchorPass).toBe(false)
  })

  it('NEGATIVE CONTROL: a stale recorded blob_sha1 in the ODS authority record FAILS even if bytes match', () => {
    dir = makeTempGitRepo()
    const content = 'ODS fixture authority content\n'
    const commit = commitFile(dir, 'authority.json', content)
    const certifiedBlob = blobAt(dir, commit, 'authority.json')
    const certifiedBytes = catFileBlob(dir, certifiedBlob)
    const currentBlob = hashObjectCurrent(dir, 'authority.json')

    const result = checkCorpusArtifact({
      record: { path: 'authority.json', blob_sha1: 'stale0000000000000000000000000000000000', content_sha256: sha256OfTextLfNormalized(content) },
      currentBytes: Buffer.from(content),
      currentGitBlobSha1: currentBlob,
      certifiedGitBlobSha1: certifiedBlob,
      certifiedBytes,
    })

    expect(result.pass).toBe(false)
    expect(result.recordedBlobMatchesAnchorPass).toBe(false)
  })
})

describe('authority:seal:verify — real CLI, POSITIVE integration control', () => {
  it('PASS against the actual current repository state', () => {
    const tsxCli = require.resolve('tsx/cli')
    const res = spawnSync(process.execPath, [tsxCli, 'scripts/authority-seal-verify.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('ODS_AUTHORITY_INPUT_INTEGRITY=PASS')
    expect(res.stdout).toContain('PROTECTED_CORPUS_COUNT=9')
    expect(res.stdout).toContain('PROTECTED_CORPUS_INTEGRITY=PASS')
    expect(res.stdout).toContain('NATIVE_RELATIONSHIPS=PASS')
    expect(res.stdout).toContain('AUTHORITY_SEAL_VERIFY=PASS')
  })
})
