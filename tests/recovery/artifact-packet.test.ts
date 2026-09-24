// @vitest-environment node
// tests/recovery/artifact-packet.test.ts — OR-P2 (packet grammar + recomputable
// digest), the bound source census record, and data classification.
// Frozen top-level shape: tests/recovery/authority-packet-shape.test.ts.
// event_class neutrality (behavioral): tests/recovery/event-class-neutrality.test.ts.

import { describe, expect, it } from 'vitest'

import {
  buildBackupPacket,
  classifyData,
  declaredExtensions,
  NO_MUTATION_CONFIRMATION,
  packetSha256,
  validateBackupPacket,
  validateSourceCensusRecord,
  type BackupPacket,
} from '../../scripts/recovery/artifact-packet'
import { censusSha256 } from '../../scripts/recovery/catalog-census'
import type { HostedStagingIdentity, LocalDisposableIdentity } from '../../scripts/recovery/recovery-target'
import { sampleCensus, sampleCensusRecord, samplePacket, samplePacketInput } from './sample-evidence'

const hosted: HostedStagingIdentity = { identityClass: 'HOSTED_STAGING', projectRef: 'bvyzblhqymxruxdguaee', signals: [], sentinelDeferred: false }
const local: LocalDisposableIdentity = { identityClass: 'LOCAL_DISPOSABLE', containerId: 'c'.repeat(64), containerName: 'x', runId: 'abcdef0123456789', role: 'source-fixture', imageId: 'sha256:' + '0'.repeat(64) }

describe('BACKUP_PACKET', () => {
  it('OR-P2: a built packet validates and its digest is canonical (key order does not matter)', () => {
    const p = samplePacket()
    expect(validateBackupPacket(p)).toEqual([])
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as BackupPacket
    expect(packetSha256(reordered)).toBe(packetSha256(p))
    expect(packetSha256(p)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('backup identifier = content digest + storage locator class, nothing else', () => {
    expect(samplePacket()['backup identifier']).toEqual({ content_digest: `sha256:${'a'.repeat(64)}`, storage_locator: { locator_class: 'OS_TEMP_OUTSIDE_REPOSITORY' } })
  })

  it('declared extensions are read back from the exact invocation, not from a separate field', () => {
    expect(declaredExtensions(samplePacket())).toEqual(['pg_trgm'])
    expect(declaredExtensions(samplePacket({ invocation: ['pg_dump', '-Fc', '-n', 'public'] }))).toEqual([])
  })

  it('the confirmation content never CONFIRMS: the posture is not chosen here', () => {
    const c = samplePacket()[NO_MUTATION_CONFIRMATION]
    expect(c.confirmation).toBe('NOT_ESTABLISHED_BY_THIS_MECHANISM')
    expect(c.establishment_posture).toBe('NOT_CHOSEN_BY_THIS_MECHANISM')
  })

  it('pre_post_equal is derived from the digests and a contradiction is refused', () => {
    const post = sampleCensus()
    post.row_counts[0].rows = 3
    const p = samplePacket({ postCensus: post })
    expect(p[NO_MUTATION_CONFIRMATION].capture_census.pre_post_equal).toBe(false)
    p[NO_MUTATION_CONFIRMATION].capture_census.pre_post_equal = true
    expect(validateBackupPacket(p).map((v) => v.problem)).toContain('pre_post_equal contradicts the digests')
  })

  it('target identifier is structural per class: a hosted ref with a container id, or a display name, is refused', () => {
    const p = buildBackupPacket(samplePacketInput({ identity: hosted }))
    expect(validateBackupPacket(p)).toEqual([])
    const mixed = { ...p, 'target identifier': { ...p['target identifier'], container_id: 'c'.repeat(64) } }
    expect(validateBackupPacket(mixed).length).toBeGreaterThan(0)
    const named = { ...p, 'target identifier': { ...p['target identifier'], project_ref: 'Uellix Staging' } }
    expect(validateBackupPacket(named).map((v) => v.path)).toContain('$.backup_packet.target identifier.project_ref')
  })

  it('event_class is nested in the confirmation content and must be a code; its policy cannot be set', () => {
    const p = samplePacket({ eventClass: 'STELLA_0017B_BRIDGE_DEPLOYED' })
    expect(p[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class).toEqual({ value: 'STELLA_0017B_BRIDGE_DEPLOYED', policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' })
    const chosen = samplePacket()
    ;(chosen[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class as { policy: string }).policy = 'QUIESCE'
    expect(validateBackupPacket(chosen).length).toBeGreaterThan(0)
  })
})

describe('SOURCE_CATALOG_CENSUS_RECORD (bound, not a frozen packet)', () => {
  it('validates when its census is the one the packet digests', () => {
    expect(validateSourceCensusRecord(sampleCensusRecord(), samplePacket())).toEqual([])
    expect(censusSha256(sampleCensus())).toBe(samplePacket()[NO_MUTATION_CONFIRMATION].capture_census.pre_capture_census_sha256)
  })

  it('a record whose census differs from the bound one is refused (no silent re-binding)', () => {
    const other = sampleCensus()
    other.row_counts[1].rows = 99
    expect(validateSourceCensusRecord(sampleCensusRecord(other), samplePacket()).map((v) => v.problem)).toContain('census is not the one the packet is bound to')
  })

  it('HOSTED input is CUSTOMER_DATA_BY_CONTRACT and cannot be declared synthetic', () => {
    expect(classifyData(hosted, 'SYNTHETIC_FIXTURE')).toBe('CUSTOMER_DATA_BY_CONTRACT')
    expect(classifyData(local, 'SYNTHETIC_FIXTURE')).toBe('SYNTHETIC_FIXTURE')
    const hostedPacket = buildBackupPacket(samplePacketInput({ identity: hosted }))
    expect(validateSourceCensusRecord(sampleCensusRecord(), hostedPacket).map((v) => v.path)).toContain('$.source_census_record.data_classification')
  })
})
