// scripts/recovery/artifact-integrity.ts — digest and integrity validation
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-3).
//
// Three independent layers, because each catches a failure the others cannot:
//
//   1. LOCATION  — the artifact lives OUTSIDE the repository working tree
//                  (authority RETENTION_AND_DISPOSAL: "NEVER committed ... tracked
//                  or untracked"; CL-3). Checked on the resolved real path.
//   2. DIGEST    — the bytes on disk hash to the packet's content digest
//                  (backup identifier). The verifier RECOMPUTES; it never trusts
//                  a digest it did not compute (EVIDENCE.independent_verifiability_contract).
//   3. STRUCTURE — `pg_restore --list` of those bytes parses as a custom-format
//                  archive dumped by the pinned tool from the pinned engine, and
//                  its TABLE entries are exactly the captured relations. This is
//                  what catches an artifact that was corrupted BEFORE its digest
//                  was taken (a digest faithfully describes corrupt bytes too).
//
// Layer 2 is repeated during the restore itself (restore-runner.ts): the sha256
// of the bytes actually streamed into pg_restore must equal the packet digest,
// which closes the window between "verified" and "restored".

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { packetArtifactSha256, type BackupPacket } from './artifact-packet'
import type { Census } from './catalog-census'

export type IntegrityRefusalCode =
  | 'ARTIFACT_PATH_NOT_ABSOLUTE'
  | 'ARTIFACT_INSIDE_REPOSITORY'
  | 'ARTIFACT_ABSENT'
  | 'ARTIFACT_DIGEST_MISMATCH'
  | 'ARTIFACT_TOC_UNREADABLE'
  | 'ARTIFACT_TOC_NOT_CUSTOM_FORMAT'
  | 'ARTIFACT_TOC_EMPTY'
  | 'ARTIFACT_TOC_RELATIONS_MISMATCH'

export type IntegrityVerdict = { ok: true; sha256: string; bytes: number } | { ok: false; code: IntegrityRefusalCode }

/** True when `candidate` resolves inside `root` (or is `root`). Case-insensitive on Windows. */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const resolve = (p: string) => {
    let current = path.resolve(p)
    const tail: string[] = []
    // Resolve symlinks/junctions on the longest existing prefix.
    while (!existsSync(current) && path.dirname(current) !== current) {
      tail.unshift(path.basename(current))
      current = path.dirname(current)
    }
    const real = existsSync(current) ? realpathSync.native(current) : current
    return path.join(real, ...tail)
  }
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = path.relative(norm(resolve(root)), norm(resolve(candidate)))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Layer 1. An artifact directory or file must be absolute and outside the repository. */
export function checkArtifactLocation(artifactPath: string, repoRoot: string): IntegrityVerdict | null {
  if (!path.isAbsolute(artifactPath)) return { ok: false, code: 'ARTIFACT_PATH_NOT_ABSOLUTE' }
  if (isInsideDirectory(artifactPath, repoRoot)) return { ok: false, code: 'ARTIFACT_INSIDE_REPOSITORY' }
  return null
}

export function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    createReadStream(filePath)
      .on('data', (chunk) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        hash.update(buf)
        bytes += buf.length
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }))
  })
}

/** Layers 1 + 2. */
export async function verifyArtifactDigest(packet: BackupPacket, artifactPath: string, repoRoot: string): Promise<IntegrityVerdict> {
  const location = checkArtifactLocation(artifactPath, repoRoot)
  if (location) return location
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) return { ok: false, code: 'ARTIFACT_ABSENT' }
  const { sha256, bytes } = await sha256File(artifactPath)
  if (sha256 !== packetArtifactSha256(packet)) return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH' }
  return { ok: true, sha256, bytes }
}

export interface ArchiveToc {
  format: string | null
  dumpedFrom: string | null
  dumpedBy: string | null
  entryCount: number
  /** `schema.table` for every `TABLE` entry. */
  tables: string[]
  /** True when the archive carries its own `SCHEMA - public` entry. */
  createsPublicSchema: boolean
}

/**
 * Parse `pg_restore --list` output. Only the header comments and the entry
 * lines are read; nothing in a TOC is row content (TABLE DATA entries name the
 * table, not its rows).
 */
export function parseArchiveToc(listing: string): ArchiveToc {
  const header = (label: string): string | null => {
    const m = listing.match(new RegExp(`^;\\s+${label}:\\s*(.+?)\\s*$`, 'm'))
    return m ? m[1] : null
  }
  const entries = listing.split(/\r?\n/).filter((l) => /^\d+;\s+\d+\s+\d+\s+\S/.test(l))
  const tables: string[] = []
  let createsPublicSchema = false
  for (const line of entries) {
    const table = line.match(/^\d+;\s+\d+\s+\d+\s+TABLE\s+(\S+)\s+(\S+)\s+\S+\s*$/)
    if (table) tables.push(`${table[1]}.${table[2]}`)
    if (/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public\s+\S+\s*$/.test(line)) createsPublicSchema = true
  }
  const dumpedFrom = header('Dumped from database version')
  const dumpedBy = header('Dumped by pg_dump version')
  return {
    format: header('Format'),
    dumpedFrom: dumpedFrom ? dumpedFrom.split(/\s/)[0] : null,
    dumpedBy: dumpedBy ? dumpedBy.split(/\s/)[0] : null,
    entryCount: entries.length,
    tables: tables.sort(),
    createsPublicSchema,
  }
}

/**
 * Layer 3, over an already-parsed TOC: custom format, non-empty, and its TABLE
 * entries are EXACTLY the bound source census's ordinary/partitioned tables.
 * Version fields are handed to the tool pin by the caller (tool-pin.ts).
 */
export function checkArchiveStructure(toc: ArchiveToc, sourceCensus: Census): IntegrityVerdict | null {
  if (toc.format !== 'CUSTOM') return { ok: false, code: 'ARTIFACT_TOC_NOT_CUSTOM_FORMAT' }
  if (toc.entryCount === 0 || toc.tables.length === 0) return { ok: false, code: 'ARTIFACT_TOC_EMPTY' }
  const expected = sourceCensus.relations
    .filter((r) => r.kind === 'r' || r.kind === 'p')
    .map((r) => `${r.schema}.${r.name}`)
    .sort()
  if (expected.length !== toc.tables.length || expected.some((t, i) => t !== toc.tables[i])) {
    return { ok: false, code: 'ARTIFACT_TOC_RELATIONS_MISMATCH' }
  }
  return null
}

const PUBLIC_SCHEMA_ENTRY = /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public\s+\S+\s*$/

/**
 * The TOC list a restore into a FRESH database uses: the archive's own
 * `SCHEMA - public` entry removed, everything else kept in archive order.
 *
 * pg_dump -n public emits CREATE SCHEMA public (measured, and re-measured by the
 * recert of ec573e9b); a fresh database already has public, so with
 * --exit-on-error the restore stops at "schema public already exists". The
 * earlier mechanism DROPPED the fresh database's public first — a destructive
 * statement the recovery authority does not name, and the thing that made the
 * restored public lose its initdb ACL (the RR-CAP-7 shape). Selecting the TOC
 * with `pg_restore -L` is non-destructive, keeps the fresh database's public
 * (owner pg_database_owner, USAGE to PUBLIC), and restores everything else.
 * The listing carries object names only, never row content.
 */
export function selectTocForExistingPublic(listing: string): { list: string; removed: number } {
  const lines = listing.split(/\r?\n/)
  const kept = lines.filter((l) => !PUBLIC_SCHEMA_ENTRY.test(l))
  return { list: kept.join('\n'), removed: lines.length - kept.length }
}
