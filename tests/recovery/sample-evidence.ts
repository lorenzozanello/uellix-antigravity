// tests/recovery/sample-evidence.ts — a grammar-valid census and BACKUP_PACKET
// shaped like the one the real e2e rehearsal produces for the synthetic fixture.
// Pure data: no row values, only catalog facts, counts and digests.

import type { BackupPacket } from '../../scripts/recovery/artifact-packet'
import type { Census } from '../../scripts/recovery/catalog-census'
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

export function samplePacket(overrides: Partial<BackupPacket> = {}): BackupPacket {
  return {
    packet_class: 'BACKUP_PACKET',
    packet_version: '1.0.0',
    mechanism: 'STAGING_RECOVERY_OFFLINE_MECHANISM',
    target_identifier: { identity_class: 'LOCAL_DISPOSABLE', project_ref: null, container_id: H('c'), derivation: 'SUBSTRATE_RUN_LABEL' },
    backup_identifier: { artifact_id: `sha256:${H('a')}`, artifact_sha256: H('a'), artifact_bytes: 13379, storage_locator_class: 'OS_TEMP_OUTSIDE_REPOSITORY' },
    backup_timestamp: { capture_started_at: '2026-09-23T20:00:35.000Z', capture_finished_at: '2026-09-23T20:00:36.000Z' },
    method: {
      tool: 'pg_dump',
      tool_version: '17.6',
      format: 'custom',
      image_ref: RECOVERY_TOOL_PIN.imageRef,
      image_id: RECOVERY_TOOL_PIN.imageId,
      capture_principal: 'recovery_capture_ro',
      invocation: ['pg_dump', '-h', '127.0.0.1', '-U', 'recovery_capture_ro', '-d', 'fixture_src', '--no-password', '-Fc', '-n', 'public', '-e', 'pg_trgm'],
      stderr_sha256: H('e'),
      stderr_lines: 0,
    },
    scope: { schemas: ['public', 'uellix_provisioning'], excluded_relations: [], extensions: ['pg_trgm'], storage_object_bytes: 'OUT_OF_SCOPE' },
    no_intervening_mutation: { policy: 'NOT_CHOSEN_BY_THIS_MECHANISM', pre_capture_census_sha256: H('b'), post_capture_census_sha256: H('b'), census_pre_post_equal: true },
    event_class: { value: null, policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' },
    release_binding: { release_sha: null, migration_corpus_packet_sha256: null },
    data_classification: 'SYNTHETIC_FIXTURE',
    source_census: sampleCensus(),
    ...overrides,
  }
}
