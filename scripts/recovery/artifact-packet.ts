// scripts/recovery/artifact-packet.ts — the BACKUP_PACKET, exactly as frozen
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-2).
//
// THE SHAPE IS THE AUTHORITY'S, NOT THIS FILE'S. The packet class is frozen by
// docs/ops/release/STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json
// EVIDENCE_PACKETS.packets[BACKUP_PACKET].contents — six contents — and the
// recovery authority forbids enlarging it (ADJ.B: "does NOT add, remove or
// reorder any field"; ADJ.H: "No field is added to the packet: each of these
// instantiates one of the six"). The recert of ec573e9b failed this lane for
// emitting thirteen top-level keys. Here the six top-level keys ARE the six
// content strings, verbatim and in order, read from the authority file at load
// time and compared with the literal keys this module types; any difference
// throws before a packet can be built.
//
// WHAT GOES INSIDE EACH CONTENT, and the clause that puts it there:
//
//   target identifier            ADJ.H: the structurally derived project ref
//                                (never a name); for the local class, the
//                                run-labelled container id.
//   backup identifier            ADJ.H: content digest + storage locator (by
//                                CLASS, RETENTION_AND_DISPOSAL).
//   backup timestamp             ADJ.H: capture start AND end.
//   the method used              ADJ.H: exact tool, version, exact invocation
//                                (extensions and principal appear in it);
//                                FRESHNESS criterion 4: the SHA of the tooling.
//   the scope covered            ADJ.H: enumerated schemas + excluded relations.
//   confirmation that no mutation ...  ADJ.H "per FRESHNESS": the capture-time
//                                census digests (the positive observation the
//                                predicate is built on), and "the change it
//                                precedes" as that content's own words name it:
//                                the corpus SHA (FRESHNESS criterion 4), the
//                                MIGRATION_CORPUS_PACKET (H.additionally_bound)
//                                and its DDL event class — carried verbatim,
//                                posture NOT_CHOSEN (OD-3 is out of scope). This
//                                mechanism never CONFIRMS the predicate: that
//                                needs HC-2 under an OD-3 posture.
//
// NOT in the packet: the source catalog census and its data classification.
// The authority compares restores against "the source observation" the backup
// is BOUND to — a separate thing. They travel in SourceCensusRecord, bound to
// the packet by the census digest in the confirmation content.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { CENSUS_SHAPE, canonicalJson, censusSha256, type Census } from './catalog-census'
import { S, validateEvidence, type GrammarViolation, type Shape } from './evidence-privacy'
import type { RecoveryIdentity } from './recovery-target'

export const RELEASE_AUTHORITY_PATH = 'docs/ops/release/STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json'
const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** Read a frozen packet's `contents` straight from the authority file. Throws unless exactly one packet matches. */
export function frozenPacketContents(packet: 'BACKUP_PACKET' | 'RESTORE_PROOF', repoRoot: string = ROOT): string[] {
  const authority = JSON.parse(readFileSync(path.join(repoRoot, RELEASE_AUTHORITY_PATH), 'utf8')) as { EVIDENCE_PACKETS?: { packets?: Array<{ packet?: string; contents?: unknown }> } }
  const matches = (authority.EVIDENCE_PACKETS?.packets ?? []).filter((p) => p.packet === packet)
  if (matches.length !== 1 || !Array.isArray(matches[0].contents) || !matches[0].contents.every((c) => typeof c === 'string')) {
    throw new Error(`FROZEN_PACKET_UNRESOLVABLE: ${packet} is not exactly one packet with string contents in ${RELEASE_AUTHORITY_PATH}`)
  }
  return matches[0].contents as string[]
}

/** Top-level problems of `value` against a frozen content list: missing, extra, or reordered keys. */
export function frozenTopLevelProblems(value: unknown, contents: readonly string[], label: string): GrammarViolation[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path: `$.${label}`, problem: 'expected an object' }]
  const keys = Object.keys(value)
  const out: GrammarViolation[] = []
  for (const k of keys) if (!contents.includes(k)) out.push({ path: `$.${label}.${k}`, problem: 'top-level key is not a frozen content of the authority' })
  for (const c of contents) if (!keys.includes(c)) out.push({ path: `$.${label}.${c}`, problem: 'frozen content absent' })
  if (out.length === 0 && keys.some((k, i) => k !== contents[i])) out.push({ path: `$.${label}`, problem: 'frozen contents reordered' })
  return out
}

export function assertFrozen(packet: 'BACKUP_PACKET' | 'RESTORE_PROOF', literal: readonly string[]): void {
  const frozen = frozenPacketContents(packet)
  if (frozen.length !== literal.length || frozen.some((c, i) => c !== literal[i])) {
    throw new Error(`FROZEN_PACKET_DRIFT: the typed ${packet} keys are not the authority's contents`)
  }
}

export const TARGET_IDENTIFIER = 'target identifier'
export const BACKUP_IDENTIFIER = 'backup identifier'
export const BACKUP_TIMESTAMP = 'backup timestamp'
export const METHOD_USED = 'the method used'
export const SCOPE_COVERED = 'the scope covered'
export const NO_MUTATION_CONFIRMATION = 'confirmation that no mutation occurred between the backup and the change it precedes'

export const BACKUP_PACKET_CONTENTS = [TARGET_IDENTIFIER, BACKUP_IDENTIFIER, BACKUP_TIMESTAMP, METHOD_USED, SCOPE_COVERED, NO_MUTATION_CONFIRMATION] as const
assertFrozen('BACKUP_PACKET', BACKUP_PACKET_CONTENTS)

export const NOT_CHOSEN = 'NOT_CHOSEN_BY_THIS_MECHANISM'

export type DataClassification = 'SYNTHETIC_FIXTURE' | 'CUSTOMER_DATA_BY_CONTRACT'

/** The capture request's scope. `extensions` reaches the packet only through the invocation (-e). */
export interface DeclaredScope {
  schemas: string[]
  excluded_relations: string[]
  extensions: string[]
}

export interface TargetIdentifierContent {
  identity_class: 'HOSTED_STAGING' | 'LOCAL_DISPOSABLE'
  project_ref: string | null
  container_id: string | null
  derivation: 'VERIFY_STAGING_TARGET' | 'SUBSTRATE_RUN_LABEL'
}

export interface BackupPacket {
  'target identifier': TargetIdentifierContent
  'backup identifier': { content_digest: string; storage_locator: { locator_class: 'OS_TEMP_OUTSIDE_REPOSITORY' } }
  'backup timestamp': { capture_started_at: string; capture_finished_at: string }
  'the method used': {
    tool: { name: 'pg_dump'; version: string; image_ref_pinned: string; image_id_observed: string }
    tooling_sha: string | null
    invocation: string[]
  }
  'the scope covered': { schemas: string[]; excluded_relations: string[] }
  'confirmation that no mutation occurred between the backup and the change it precedes': {
    confirmation: 'NOT_ESTABLISHED_BY_THIS_MECHANISM'
    establishment_posture: 'NOT_CHOSEN_BY_THIS_MECHANISM'
    capture_census: { pre_capture_census_sha256: string; post_capture_census_sha256: string; pre_post_equal: boolean }
    the_change_it_precedes: {
      release_sha: string | null
      migration_corpus_packet_sha256: string | null
      event_class: { value: string | null; policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' }
    }
  }
}

const CONTENT_SHAPES: Shape[] = [
  S.obj({
    identity_class: S.enm('HOSTED_STAGING', 'LOCAL_DISPOSABLE'),
    project_ref: S.opt(S.str('identifier')),
    container_id: S.opt(S.str('docker_id')),
    derivation: S.enm('VERIFY_STAGING_TARGET', 'SUBSTRATE_RUN_LABEL'),
  }),
  S.obj({ content_digest: S.str('image_id'), storage_locator: S.obj({ locator_class: S.enm('OS_TEMP_OUTSIDE_REPOSITORY') }) }),
  S.obj({ capture_started_at: S.str('iso_timestamp'), capture_finished_at: S.str('iso_timestamp') }),
  S.obj({
    tool: S.obj({ name: S.enm('pg_dump'), version: S.str('version'), image_ref_pinned: S.str('image_ref'), image_id_observed: S.str('image_id') }),
    tooling_sha: S.opt(S.str('git_sha')),
    invocation: S.arr(S.str('cli_token'), 64),
  }),
  S.obj({ schemas: S.arr(S.str('identifier')), excluded_relations: S.arr(S.str('qualified_identifier')) }),
  S.obj({
    confirmation: S.enm('NOT_ESTABLISHED_BY_THIS_MECHANISM'),
    establishment_posture: S.enm(NOT_CHOSEN),
    capture_census: S.obj({ pre_capture_census_sha256: S.str('sha256'), post_capture_census_sha256: S.str('sha256'), pre_post_equal: S.bool() }),
    the_change_it_precedes: S.obj({
      release_sha: S.opt(S.str('git_sha')),
      migration_corpus_packet_sha256: S.opt(S.str('sha256')),
      event_class: S.obj({ value: S.opt(S.str('code')), policy: S.enm(NOT_CHOSEN) }),
    }),
  }),
]

/** Keyed by the authority's own content strings, so the shape cannot drift from them. */
export const BACKUP_PACKET_SHAPE: Shape = S.obj(Object.fromEntries(BACKUP_PACKET_CONTENTS.map((c, i) => [c, CONTENT_SHAPES[i]])))

export interface BackupPacketInput {
  identity: RecoveryIdentity
  artifactSha256: string
  captureStartedAt: string
  captureFinishedAt: string
  toolVersion: string
  imageRefPinned: string
  imageIdObserved: string
  toolingSha: string | null
  invocation: string[]
  scope: DeclaredScope
  preCensus: Census
  postCensus: Census
  eventClass: string | null
  releaseSha: string | null
  migrationCorpusPacketSha256: string | null
}

export function targetIdentifierOf(identity: RecoveryIdentity): TargetIdentifierContent {
  return identity.identityClass === 'HOSTED_STAGING'
    ? { identity_class: 'HOSTED_STAGING', project_ref: identity.projectRef, container_id: null, derivation: 'VERIFY_STAGING_TARGET' }
    : { identity_class: 'LOCAL_DISPOSABLE', project_ref: null, container_id: identity.containerId, derivation: 'SUBSTRATE_RUN_LABEL' }
}

/** Pure. The ONLY place a BACKUP_PACKET is assembled. Key order = authority order. */
export function buildBackupPacket(i: BackupPacketInput): BackupPacket {
  const pre = censusSha256(i.preCensus)
  const post = censusSha256(i.postCensus)
  return {
    'target identifier': targetIdentifierOf(i.identity),
    'backup identifier': { content_digest: `sha256:${i.artifactSha256}`, storage_locator: { locator_class: 'OS_TEMP_OUTSIDE_REPOSITORY' } },
    'backup timestamp': { capture_started_at: i.captureStartedAt, capture_finished_at: i.captureFinishedAt },
    'the method used': {
      tool: { name: 'pg_dump', version: i.toolVersion, image_ref_pinned: i.imageRefPinned, image_id_observed: i.imageIdObserved },
      tooling_sha: i.toolingSha,
      invocation: i.invocation,
    },
    'the scope covered': { schemas: [...i.scope.schemas], excluded_relations: [...i.scope.excluded_relations] },
    'confirmation that no mutation occurred between the backup and the change it precedes': {
      confirmation: 'NOT_ESTABLISHED_BY_THIS_MECHANISM',
      establishment_posture: NOT_CHOSEN,
      capture_census: { pre_capture_census_sha256: pre, post_capture_census_sha256: post, pre_post_equal: pre === post },
      the_change_it_precedes: {
        release_sha: i.releaseSha,
        migration_corpus_packet_sha256: i.migrationCorpusPacketSha256,
        event_class: { value: i.eventClass, policy: NOT_CHOSEN },
      },
    },
  }
}

export function validateBackupPacket(packet: unknown): GrammarViolation[] {
  const top = frozenTopLevelProblems(packet, BACKUP_PACKET_CONTENTS, 'backup_packet')
  if (top.length > 0) return top
  const violations = validateEvidence(packet, BACKUP_PACKET_SHAPE, '$.backup_packet')
  if (violations.length > 0) return violations
  const p = packet as BackupPacket
  const t = p['backup timestamp']
  if (t.capture_finished_at < t.capture_started_at) violations.push({ path: '$.backup_packet.backup timestamp', problem: 'capture finished before it started' })
  const ti = p['target identifier']
  if (ti.identity_class === 'HOSTED_STAGING' && (ti.project_ref === null || ti.container_id !== null || ti.derivation !== 'VERIFY_STAGING_TARGET')) {
    violations.push({ path: '$.backup_packet.target identifier', problem: 'a hosted identity is a verified project ref and nothing else' })
  }
  if (ti.identity_class === 'LOCAL_DISPOSABLE' && (ti.container_id === null || ti.project_ref !== null || ti.derivation !== 'SUBSTRATE_RUN_LABEL')) {
    violations.push({ path: '$.backup_packet.target identifier', problem: 'a local identity is a run-labelled container id and nothing else' })
  }
  const cc = p[NO_MUTATION_CONFIRMATION].capture_census
  if (cc.pre_post_equal !== (cc.pre_capture_census_sha256 === cc.post_capture_census_sha256)) {
    violations.push({ path: '$.backup_packet.confirmation.capture_census', problem: 'pre_post_equal contradicts the digests' })
  }
  return violations
}

/** Hex content digest of the artifact the packet identifies. */
export function packetArtifactSha256(p: BackupPacket): string {
  return p['backup identifier'].content_digest.replace(/^sha256:/, '')
}

/** Extensions selected by the capture, read back from the exact invocation (`-e <name>`). */
export function declaredExtensions(p: BackupPacket): string[] {
  const inv = p['the method used'].invocation
  return inv.flatMap((t, i) => (t === '-e' && i + 1 < inv.length ? [inv[i + 1]] : []))
}

export function packetSha256(packet: BackupPacket): string {
  return createHash('sha256').update(canonicalJson(packet)).digest('hex')
}

// ---------------------------------------------------------------------------
// The source observation the packet is bound to — NOT a frozen packet.
// ---------------------------------------------------------------------------

export interface SourceCensusRecord {
  record_class: 'SOURCE_CATALOG_CENSUS_RECORD'
  census: Census
  /** HOSTED input is CUSTOMER_DATA until a CLASSIFICATION_RUN says otherwise. */
  data_classification: DataClassification
}

export const SOURCE_CENSUS_RECORD_SHAPE: Shape = S.obj({
  record_class: S.enm('SOURCE_CATALOG_CENSUS_RECORD'),
  census: CENSUS_SHAPE,
  data_classification: S.enm('SYNTHETIC_FIXTURE', 'CUSTOMER_DATA_BY_CONTRACT'),
})

/**
 * HOSTED input is CUSTOMER_DATA until a CLASSIFICATION_RUN says otherwise
 * (authority DATA_PROTECTION_IN_A_REHEARSAL_RESTORE.fail_closed_posture). Only a
 * LOCAL_DISPOSABLE source may be declared SYNTHETIC_FIXTURE, and only by its caller.
 */
export function classifyData(identity: RecoveryIdentity, declared: DataClassification): DataClassification {
  return identity.identityClass === 'HOSTED_STAGING' ? 'CUSTOMER_DATA_BY_CONTRACT' : declared
}

/** Shape + classification + BINDING: the record's census must be the one the packet's confirmation digests. */
export function validateSourceCensusRecord(record: unknown, packet: BackupPacket): GrammarViolation[] {
  const violations = validateEvidence(record, SOURCE_CENSUS_RECORD_SHAPE, '$.source_census_record')
  if (violations.length > 0) return violations
  const r = record as SourceCensusRecord
  if (censusSha256(r.census) !== packet[NO_MUTATION_CONFIRMATION].capture_census.pre_capture_census_sha256) {
    violations.push({ path: '$.source_census_record.census', problem: 'census is not the one the packet is bound to' })
  }
  if (packet['target identifier'].identity_class === 'HOSTED_STAGING' && r.data_classification !== 'CUSTOMER_DATA_BY_CONTRACT') {
    violations.push({ path: '$.source_census_record.data_classification', problem: 'hosted input is CUSTOMER_DATA_BY_CONTRACT' })
  }
  return violations
}
