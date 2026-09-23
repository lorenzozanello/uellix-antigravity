// scripts/recovery/artifact-packet.ts — the recovery artifact manifest
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-2).
//
// A BACKUP_PACKET instance. The packet CLASS is frozen by
// docs/ops/release/STAGING_RELEASE_PRODUCTION_AUTHORITY_v1.0.0.json (six
// contents), and the recovery authority's ADJUDICATIONS.H instantiates each of
// the six without adding a seventh. Each top-level field below maps to exactly
// one of them, plus the bindings H.additionally_bound and the lane requires:
//
//   target_identifier        <- "target identifier"   (structural, never a name)
//   backup_identifier        <- "backup identifier"   (content digest + locator CLASS)
//   backup_timestamp         <- "backup timestamp"    (an interval: start and end)
//   method                   <- "the method used"     (tool, version, pinned image, redacted invocation)
//   scope                    <- "the scope covered"   (schemas, excluded relations, extensions)
//   no_intervening_mutation  <- "confirmation that no mutation occurred ..."
//                               — the POLICY is S8/OD-3 territory and is NOT
//                               chosen here; the packet records the measured
//                               pre/post census equality as a FACT only.
//   event_class              <- lane requirement: the DDL event class this
//                               recovery point would protect. Carried VERBATIM,
//                               policy NOT_CHOSEN_BY_THIS_MECHANISM. No code in
//                               scripts/recovery reads it to decide anything.
//   release_binding          <- H.additionally_bound (release SHA + MIGRATION_CORPUS_PACKET);
//                               null in offline rehearsals, and a null is visible.
//   data_classification      <- DATA_PROTECTION: HOSTED input is CUSTOMER_DATA
//                               by contract; the caller cannot downgrade it.
//   source_census            <- the source observation PRI-1..PRI-7 compare against.
//
// No credential, connection string or row appears here: the whole packet must
// pass the closed evidence grammar (validateBackupPacket) before it exists.

import { createHash } from 'node:crypto'

import { CENSUS_SHAPE, canonicalJson, type Census } from './catalog-census'
import { S, validateEvidence, type GrammarViolation, type Shape } from './evidence-privacy'
import type { RecoveryIdentity } from './recovery-target'

export const BACKUP_PACKET_VERSION = '1.0.0'
export const EVENT_CLASS_POLICY = 'NOT_CHOSEN_BY_THIS_MECHANISM'

export type DataClassification = 'SYNTHETIC_FIXTURE' | 'CUSTOMER_DATA_BY_CONTRACT'

export interface DeclaredScope {
  schemas: string[]
  excluded_relations: string[]
  extensions: string[]
  storage_object_bytes: 'OUT_OF_SCOPE'
}

export interface BackupPacket {
  packet_class: 'BACKUP_PACKET'
  packet_version: string
  mechanism: 'STAGING_RECOVERY_OFFLINE_MECHANISM'
  target_identifier: {
    identity_class: 'HOSTED_STAGING' | 'LOCAL_DISPOSABLE'
    project_ref: string | null
    container_id: string | null
    derivation: 'VERIFY_STAGING_TARGET' | 'SUBSTRATE_RUN_LABEL'
  }
  backup_identifier: {
    artifact_id: string
    artifact_sha256: string
    artifact_bytes: number
    storage_locator_class: 'OS_TEMP_OUTSIDE_REPOSITORY'
  }
  backup_timestamp: { capture_started_at: string; capture_finished_at: string }
  method: {
    tool: 'pg_dump'
    tool_version: string
    format: 'custom'
    image_ref: string
    image_id: string
    capture_principal: string
    invocation: string[]
    stderr_sha256: string
    stderr_lines: number
  }
  scope: DeclaredScope
  no_intervening_mutation: {
    policy: 'NOT_CHOSEN_BY_THIS_MECHANISM'
    pre_capture_census_sha256: string
    post_capture_census_sha256: string
    census_pre_post_equal: boolean
  }
  event_class: { value: string | null; policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' }
  release_binding: { release_sha: string | null; migration_corpus_packet_sha256: string | null }
  data_classification: DataClassification
  source_census: Census
}

export const BACKUP_PACKET_SHAPE: Shape = S.obj({
  packet_class: S.enm('BACKUP_PACKET'),
  packet_version: S.enm(BACKUP_PACKET_VERSION),
  mechanism: S.enm('STAGING_RECOVERY_OFFLINE_MECHANISM'),
  target_identifier: S.obj({
    identity_class: S.enm('HOSTED_STAGING', 'LOCAL_DISPOSABLE'),
    project_ref: S.opt(S.str('identifier')),
    container_id: S.opt(S.str('docker_id')),
    derivation: S.enm('VERIFY_STAGING_TARGET', 'SUBSTRATE_RUN_LABEL'),
  }),
  backup_identifier: S.obj({
    artifact_id: S.str('image_id'),
    artifact_sha256: S.str('sha256'),
    artifact_bytes: S.int(),
    storage_locator_class: S.enm('OS_TEMP_OUTSIDE_REPOSITORY'),
  }),
  backup_timestamp: S.obj({ capture_started_at: S.str('iso_timestamp'), capture_finished_at: S.str('iso_timestamp') }),
  method: S.obj({
    tool: S.enm('pg_dump'),
    tool_version: S.str('version'),
    format: S.enm('custom'),
    image_ref: S.str('image_ref'),
    image_id: S.str('image_id'),
    capture_principal: S.str('identifier'),
    invocation: S.arr(S.str('cli_token'), 64),
    stderr_sha256: S.str('sha256'),
    stderr_lines: S.int(),
  }),
  scope: S.obj({
    schemas: S.arr(S.str('identifier')),
    excluded_relations: S.arr(S.str('qualified_identifier')),
    extensions: S.arr(S.str('identifier')),
    storage_object_bytes: S.enm('OUT_OF_SCOPE'),
  }),
  no_intervening_mutation: S.obj({
    policy: S.enm(EVENT_CLASS_POLICY),
    pre_capture_census_sha256: S.str('sha256'),
    post_capture_census_sha256: S.str('sha256'),
    census_pre_post_equal: S.bool(),
  }),
  event_class: S.obj({ value: S.opt(S.str('code')), policy: S.enm(EVENT_CLASS_POLICY) }),
  release_binding: S.obj({ release_sha: S.opt(S.str('git_sha')), migration_corpus_packet_sha256: S.opt(S.str('sha256')) }),
  data_classification: S.enm('SYNTHETIC_FIXTURE', 'CUSTOMER_DATA_BY_CONTRACT'),
  source_census: CENSUS_SHAPE,
})

/**
 * HOSTED input is CUSTOMER_DATA until a CLASSIFICATION_RUN says otherwise
 * (authority DATA_PROTECTION_IN_A_REHEARSAL_RESTORE.fail_closed_posture). Only a
 * LOCAL_DISPOSABLE source may be declared SYNTHETIC_FIXTURE, and only by its caller.
 */
export function classifyData(identity: RecoveryIdentity, declared: DataClassification): DataClassification {
  return identity.identityClass === 'HOSTED_STAGING' ? 'CUSTOMER_DATA_BY_CONTRACT' : declared
}

export function targetIdentifierOf(identity: RecoveryIdentity): BackupPacket['target_identifier'] {
  return identity.identityClass === 'HOSTED_STAGING'
    ? { identity_class: 'HOSTED_STAGING', project_ref: identity.projectRef, container_id: null, derivation: 'VERIFY_STAGING_TARGET' }
    : { identity_class: 'LOCAL_DISPOSABLE', project_ref: null, container_id: identity.containerId, derivation: 'SUBSTRATE_RUN_LABEL' }
}

export function validateBackupPacket(packet: unknown): GrammarViolation[] {
  const violations = validateEvidence(packet, BACKUP_PACKET_SHAPE, '$.backup_packet')
  if (violations.length > 0) return violations
  const p = packet as BackupPacket
  if (p.backup_identifier.artifact_id !== `sha256:${p.backup_identifier.artifact_sha256}`) {
    violations.push({ path: '$.backup_packet.backup_identifier.artifact_id', problem: 'artifact_id must be sha256:<artifact_sha256>' })
  }
  if (p.backup_timestamp.capture_finished_at < p.backup_timestamp.capture_started_at) {
    violations.push({ path: '$.backup_packet.backup_timestamp', problem: 'capture finished before it started' })
  }
  const ti = p.target_identifier
  if (ti.identity_class === 'HOSTED_STAGING' && (ti.project_ref === null || ti.container_id !== null || ti.derivation !== 'VERIFY_STAGING_TARGET')) {
    violations.push({ path: '$.backup_packet.target_identifier', problem: 'a hosted identity is a verified project ref and nothing else' })
  }
  if (ti.identity_class === 'LOCAL_DISPOSABLE' && (ti.container_id === null || ti.project_ref !== null || ti.derivation !== 'SUBSTRATE_RUN_LABEL')) {
    violations.push({ path: '$.backup_packet.target_identifier', problem: 'a local identity is a run-labelled container id and nothing else' })
  }
  if (ti.identity_class === 'HOSTED_STAGING' && p.data_classification !== 'CUSTOMER_DATA_BY_CONTRACT') {
    violations.push({ path: '$.backup_packet.data_classification', problem: 'hosted input is CUSTOMER_DATA_BY_CONTRACT' })
  }
  return violations
}

/** sha256 over canonical JSON — what a RESTORE_PROOF binds to. */
export function packetSha256(packet: BackupPacket): string {
  return createHash('sha256').update(canonicalJson(packet)).digest('hex')
}
