// @vitest-environment node
// tests/recovery/artifact-packet.test.ts — OR-P2 (packet grammar + recomputable
// digest), OR-P7 (event_class carried, never interpreted).

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyData, packetSha256, targetIdentifierOf, validateBackupPacket } from '../../scripts/recovery/artifact-packet'
import type { HostedStagingIdentity, LocalDisposableIdentity } from '../../scripts/recovery/recovery-target'
import { samplePacket } from './sample-evidence'

const hosted: HostedStagingIdentity = { identityClass: 'HOSTED_STAGING', projectRef: 'bvyzblhqymxruxdguaee', signals: [], sentinelDeferred: false }
const local: LocalDisposableIdentity = { identityClass: 'LOCAL_DISPOSABLE', containerId: 'c'.repeat(64), containerName: 'x', runId: 'abcdef0123456789', role: 'source-fixture', imageId: 'sha256:' + '0'.repeat(64) }

describe('BACKUP_PACKET', () => {
  it('OR-P2: a well-formed packet validates and its digest is canonical (key order does not matter)', () => {
    const p = samplePacket()
    expect(validateBackupPacket(p)).toEqual([])
    const reordered = JSON.parse(JSON.stringify(p, Object.keys(p).reverse()))
    expect(packetSha256({ ...p })).toBe(packetSha256(Object.assign({}, reordered, p)))
    expect(packetSha256(p)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('artifact_id must be the content digest', () => {
    const p = samplePacket()
    p.backup_identifier.artifact_id = `sha256:${'b'.repeat(64)}`
    expect(validateBackupPacket(p).map((v) => v.problem)).toContain('artifact_id must be sha256:<artifact_sha256>')
  })

  it('HOSTED input is CUSTOMER_DATA_BY_CONTRACT and cannot be declared synthetic', () => {
    expect(classifyData(hosted, 'SYNTHETIC_FIXTURE')).toBe('CUSTOMER_DATA_BY_CONTRACT')
    expect(classifyData(local, 'SYNTHETIC_FIXTURE')).toBe('SYNTHETIC_FIXTURE')
    const p = samplePacket({ target_identifier: targetIdentifierOf(hosted), data_classification: 'SYNTHETIC_FIXTURE' })
    expect(validateBackupPacket(p).map((v) => v.path)).toContain('$.backup_packet.data_classification')
  })

  it('target identifier is structural per class: a hosted ref with a container id, or a name, is refused', () => {
    const mixed = samplePacket({ target_identifier: { identity_class: 'HOSTED_STAGING', project_ref: 'bvyzblhqymxruxdguaee', container_id: 'c'.repeat(64), derivation: 'VERIFY_STAGING_TARGET' }, data_classification: 'CUSTOMER_DATA_BY_CONTRACT' })
    expect(validateBackupPacket(mixed).length).toBeGreaterThan(0)
    const named = samplePacket({ target_identifier: { identity_class: 'HOSTED_STAGING', project_ref: 'Uellix Staging', container_id: null, derivation: 'VERIFY_STAGING_TARGET' }, data_classification: 'CUSTOMER_DATA_BY_CONTRACT' })
    expect(validateBackupPacket(named).map((v) => v.path)).toContain('$.backup_packet.target_identifier.project_ref')
  })

  it('OR-P7: event_class is carried verbatim with its policy NOT chosen; changing it changes nothing else', () => {
    const a = samplePacket({ event_class: { value: 'S1_CORPUS_NO_NEW_RUNTIME', policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' } })
    const b = samplePacket({ event_class: { value: 'STELLA_0017B_BRIDGE_DEPLOYED', policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' } })
    expect(validateBackupPacket(a)).toEqual([])
    expect(validateBackupPacket(b)).toEqual([])
    const strip = (p: typeof a) => ({ ...p, event_class: null })
    expect(JSON.stringify(strip(a))).toBe(JSON.stringify(strip(b)))
    const chosen = samplePacket({ event_class: { value: 'X_EVENT', policy: 'QUIESCE' as 'NOT_CHOSEN_BY_THIS_MECHANISM' } })
    expect(validateBackupPacket(chosen).map((v) => v.path)).toContain('$.backup_packet.event_class.policy')
  })

  it('OR-P7: no recovery module BRANCHES on the event class — it is referenced only where it is validated and copied', () => {
    const dir = path.resolve(import.meta.dirname, '../../scripts/recovery')
    const refs: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      readFileSync(path.join(dir, f), 'utf8')
        .split(/\r?\n/)
        .forEach((line) => {
          if (/\.eventClass\b|\.event_class\b/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) refs.push(`${f}: ${line.trim()}`)
        })
    }
    expect(refs.filter((r) => !r.startsWith('capture.ts') && !r.startsWith('offline-rehearsal.ts'))).toEqual([])
    const captureRefs = refs.filter((r) => r.startsWith('capture.ts'))
    expect(captureRefs).toHaveLength(2)
    expect(captureRefs.some((r) => r.includes("req.eventClass !== null && !CODE.test(req.eventClass)"))).toBe(true)
    expect(captureRefs.some((r) => r.includes('event_class: { value: req.eventClass, policy: EVENT_CLASS_POLICY }'))).toBe(true)
    expect(refs.filter((r) => r.startsWith('offline-rehearsal.ts')).every((r) => /eventClass: opts\.eventClass/.test(r))).toBe(true)
  })
})
