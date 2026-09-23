// tests/recovery/sample-evidence.ts — a grammar-valid census, BACKUP_PACKET and
// bound census record shaped like the real e2e rehearsal's. The packet is built
// by the SAME pure builder capture uses, so it cannot drift from production.
// Pure data: no row values, only catalog facts, counts and digests.

import { buildBackupPacket, type BackupPacket, type BackupPacketInput, type SourceCensusRecord } from '../../scripts/recovery/artifact-packet'
import type { Census } from '../../scripts/recovery/catalog-census'
import type { InvariantResult } from '../../scripts/recovery/post-restore-invariants'
import { buildRestoreProof, type RestoreProof } from '../../scripts/recovery/restore-proof'
import type { RestoreOutcome } from '../../scripts/recovery/restore-runner'
import type { DestructionProof, Substrate } from '../../scripts/recovery/substrate'
import { RECOVERY_TOOL_PIN } from '../../scripts/recovery/tool-pin'

const H = (c: string) => c.repeat(64)

export function sampleCensus(): Census {
  return {
    server_version_num: 170006,
    schemas: [
      { name: 'public', owner: 'pg_database_owner', acl: ['PUBLIC:USAGE:pg_database_owner', 'pg_database_owner:CREATE:pg_database_owner', 'pg_database_owner:USAGE:pg_database_owner'] },
      { name: 'uellix_provisioning', owner: 'fixture_app_owner', acl: [] },
    ],
    relations: [
      { schema: 'public', name: 'fixture_audit', kind: 'r', owner: 'fixture_app_owner', rls: false, force_rls: false, acl_sha256: H('1') },
      { schema: 'public', name: 'fixture_audit_id_seq', kind: 'S', owner: 'fixture_app_owner', rls: false, force_rls: false, acl_sha256: H('1') },
      { schema: 'public', name: 'fixture_member', kind: 'r', owner: 'fixture_app_owner', rls: true, force_rls: true, acl_sha256: H('1') },
      { schema: 'public', name: 'fixture_org', kind: 'r', owner: 'fixture_app_owner', rls: false, force_rls: false, acl_sha256: H('1') },
      { schema: 'uellix_provisioning', name: 'applied_units', kind: 'r', owner: 'fixture_app_owner', rls: false, force_rls: false, acl_sha256: H('1') },
    ],
    row_counts: [
      { schema: 'public', name: 'fixture_audit', rows: 2 },
      { schema: 'public', name: 'fixture_member', rows: 5 },
      { schema: 'public', name: 'fixture_org', rows: 3 },
      { schema: 'uellix_provisioning', name: 'applied_units', rows: 4 },
    ],
    policies: [
      { schema: 'public', table: 'fixture_member', name: 'fixture_member_owner_all', command: '*', permissive: true, roles: ['fixture_app_owner'], qual_sha256: H('2'), with_check_sha256: H('2') },
    ],
    triggers: [
      { schema: 'public', table: 'fixture_member', name: 'fixture_member_stamp', enabled: 'O', definition_sha256: H('3') },
      { schema: 'public', table: 'fixture_org', name: 'fixture_org_stamp_disabled', enabled: 'D', definition_sha256: H('4') },
    ],
    sequences: [{ schema: 'public', name: 'fixture_audit_id_seq', last_value: 2 }],
    identity_columns: [{ schema: 'public', table: 'fixture_org', column: 'id', identity: 'a' }],
    functions: [{ schema: 'public', name: 'fixture_capability_probe', identity_args_sha256: H('5'), security_definer: true, owner: 'fixture_app_owner', acl_sha256: H('6') }],
    extensions: [
      { name: 'pg_trgm', version: '1.6', schema: 'public' },
      { name: 'plpgsql', version: '1.0', schema: 'pg_catalog' },
    ],
    extension_dependencies: ['pg_trgm'],
    roles_referenced: ['fixture_app_owner', 'fixture_capability', 'pg_database_owner'],
    journal: { relation: 'uellix_provisioning.applied_units', row_count: 4, max_id: 4, content_sha256: H('7') },
  }
}

export const SAMPLE_CONTAINER = 'c'.repeat(64)

export function samplePacketInput(overrides: Partial<BackupPacketInput> = {}): BackupPacketInput {
  return {
    identity: { identityClass: 'LOCAL_DISPOSABLE', containerId: SAMPLE_CONTAINER, containerName: 'x', runId: 'abcdef0123456789', role: 'source-fixture', imageId: RECOVERY_TOOL_PIN.imageId },
    artifactSha256: H('a'),
    captureStartedAt: '2026-09-23T20:00:35.000Z',
    captureFinishedAt: '2026-09-23T20:00:36.000Z',
    toolVersion: '17.6',
    imageRefPinned: RECOVERY_TOOL_PIN.imageRef,
    imageIdObserved: RECOVERY_TOOL_PIN.imageId,
    toolingSha: null,
    invocation: ['pg_dump', '-h', '127.0.0.1', '-U', 'recovery_capture_ro', '-d', 'fixture_src', '--no-password', '-Fc', '-n', 'public', '-n', 'uellix_provisioning', '-e', 'pg_trgm'],
    scope: { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'] },
    preCensus: sampleCensus(),
    postCensus: sampleCensus(),
    eventClass: null,
    releaseSha: null,
    migrationCorpusPacketSha256: null,
    ...overrides,
  }
}

export function samplePacket(overrides: Partial<BackupPacketInput> = {}): BackupPacket {
  return buildBackupPacket(samplePacketInput(overrides))
}

export function sampleCensusRecord(census: Census = sampleCensus()): SourceCensusRecord {
  return { record_class: 'SOURCE_CATALOG_CENSUS_RECORD', census, data_classification: 'SYNTHETIC_FIXTURE' }
}

/** A RESTORE_PROOF built by the production builder from sample parts. */
export function sampleRestoreProof(invariants: InvariantResult[] = []): RestoreProof {
  const sub = (role: 'source-fixture' | 'restore-substrate', id: string): Substrate => ({
    identity: { identityClass: 'LOCAL_DISPOSABLE', containerId: id, containerName: `uellix-recovery-${role}-x`, runId: 'abcdef0123456789', role, imageId: RECOVERY_TOOL_PIN.imageId },
    namedVolume: 'v',
    recordedVolumes: [{ name: 'v', kind: 'named' }],
    createdAt: '2026-09-23T20:00:37.000Z',
    observed: { imageId: RECOVERY_TOOL_PIN.imageId, networkMode: 'none' },
    password: 'never-emitted',
  })
  const destruction: DestructionProof = {
    container_id: H('d'),
    run_id: 'abcdef0123456789',
    role: 'restore-substrate',
    created_at: '2026-09-23T20:00:37.000Z',
    destroyed_at: '2026-09-23T20:00:50.000Z',
    container_remove: { exit_code: 0, diagnostic: 'NONE' },
    volumes: [{ name: 'v', kind: 'named', remove_exit_code: 0, absent: true }],
    container_absent_by_id: true,
    containers_remaining_with_substrate_label: 0,
    volumes_remaining_with_substrate_label: 0,
    verdict: 'DESTROYED_AND_VERIFIED_ABSENT',
  }
  const restore: RestoreOutcome = {
    ok: true,
    refusal: null,
    refusal_detail: null,
    restore_database: 'recovery_restore_abcdef0123456789',
    restore_started_at: '2026-09-23T20:00:40.000Z',
    restore_finished_at: '2026-09-23T20:00:41.000Z',
    streamed_sha256: H('a'),
    steps: [],
    roles_at_start: [],
    roles_after_restore: [],
    tool_refusals: [],
    target_observation: { image_id: RECOVERY_TOOL_PIN.imageId, network_mode: 'none' },
    substrate_server_version_num: 170006,
  }
  return buildRestoreProof({
    packet: samplePacket(),
    sourceCensus: sampleCensusRecord(),
    sourceSubstrate: sub('source-fixture', H('e')),
    restoreSubstrate: sub('restore-substrate', H('d')),
    restore,
    invariants,
    restoreDestruction: destruction,
  })
}
