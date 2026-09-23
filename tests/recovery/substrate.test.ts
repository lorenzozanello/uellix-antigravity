// @vitest-environment node
// tests/recovery/substrate.test.ts — OR-N10 (cleanup leaves a volume -> RED),
// OR-N11 (network-enabled substrate -> RED), destruction proof shape.
// The fake's volume semantics are calibrated against the real daemon in
// tests/postgres/recovery-offline.pg.test.ts.

import { describe, expect, it } from 'vitest'

import { validateEvidence } from '../../scripts/recovery/evidence-privacy'
import {
  createSubstrate,
  destroySubstrate,
  DESTRUCTION_PROOF_SHAPE,
  networkIsolationProblem,
  RUN_LABEL,
  ROLE_LABEL,
  SubstrateRefusal,
  type Substrate,
} from '../../scripts/recovery/substrate'
import { RECOVERY_TOOL_PIN } from '../../scripts/recovery/tool-pin'
import { FakeDocker, healthyExec } from './fake-docker'

const RUN = 'abcdef0123456789'
const images = { [RECOVERY_TOOL_PIN.imageRef]: RECOVERY_TOOL_PIN.imageId }
const noSleep = () => undefined

function make(fake: FakeDocker): Substrate {
  return createSubstrate(fake, { runId: RUN, role: 'restore-substrate', sleepMs: noSleep, readyAttempts: 2 })
}

describe('substrate creation', () => {
  it('creates an isolated, labelled, pinned container with PGDATA on a run-named volume, password only in the env', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec })
    const s = make(fake)
    expect(s.identity.identityClass).toBe('LOCAL_DISPOSABLE')
    expect(s.identity.containerId).toMatch(/^[0-9a-f]{64}$/)
    const runCall = fake.calls.find((c) => c[0] === 'run')!
    expect(runCall).toEqual(expect.arrayContaining(['--network', 'none', `${RUN_LABEL}=${RUN}`, `${ROLE_LABEL}=restore-substrate`]))
    // DP / SECRET_CUSTODY: the throwaway password travels in the env, never argv.
    expect(runCall.join(' ')).not.toContain(s.password)
    expect(fake.envCalls[0].POSTGRES_PASSWORD).toBe(s.password)
    expect(fake.volumes.get(s.namedVolume)?.labels[RUN_LABEL]).toBe(RUN)
  })

  it('OR-N11: refuses a container whose inspected network is not "none", and hands back the partial for teardown', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec, forceNetworkMode: 'bridge' })
    let refusal: unknown
    try {
      make(fake)
    } catch (e) {
      refusal = e
    }
    expect(refusal).toBeInstanceOf(SubstrateRefusal)
    expect((refusal as SubstrateRefusal).code).toBe('SUBSTRATE_NETWORK_NOT_ISOLATED')
    expect((refusal as SubstrateRefusal).partial?.identity.containerId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('networkIsolationProblem: none only; bridge, host or an extra network are problems', () => {
    expect(networkIsolationProblem({ HostConfig: { NetworkMode: 'none' }, NetworkSettings: { Networks: { none: {} } } })).toBeNull()
    expect(networkIsolationProblem({ HostConfig: { NetworkMode: 'bridge' }, NetworkSettings: { Networks: { bridge: {} } } })).not.toBeNull()
    expect(networkIsolationProblem({ HostConfig: { NetworkMode: 'host' }, NetworkSettings: { Networks: { host: {} } } })).not.toBeNull()
    expect(networkIsolationProblem({ HostConfig: { NetworkMode: 'none' }, NetworkSettings: { Networks: { none: {}, bridge: {} } } })).not.toBeNull()
  })

  it('refuses an image whose local id is not the pin (the 17.6.1.143 vs 17.6.1.155 skew class)', () => {
    const fake = new FakeDocker({ imageIds: { [RECOVERY_TOOL_PIN.imageRef]: 'sha256:' + '8'.repeat(64) }, exec: healthyExec })
    expect(() => make(fake)).toThrow(/SUBSTRATE_IMAGE_NOT_PINNED/)
    expect(fake.calls.some((c) => c[0] === 'run')).toBe(false)
  })

  it('refuses an invalid run id before touching docker', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec })
    expect(() => createSubstrate(fake, { runId: 'BAD RUN', role: 'restore-substrate' })).toThrow(/SUBSTRATE_RUN_ID_INVALID/)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('destruction proof', () => {
  it('destroys container, anonymous AND named volumes, and proves absence by id and by label', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec, anonymousVolumePerContainer: true })
    const s = make(fake)
    expect(s.recordedVolumes.map((v) => v.kind).sort()).toEqual(['anonymous', 'named'])
    const proof = destroySubstrate(fake, s)
    expect(proof.verdict).toBe('DESTROYED_AND_VERIFIED_ABSENT')
    expect(proof.volumes.every((v) => v.absent)).toBe(true)
    expect(fake.calls).toContainEqual(['rm', '-f', '-v', s.identity.containerId])
    expect(fake.volumes.size).toBe(0)
    expect(validateEvidence(proof, DESTRUCTION_PROOF_SHAPE)).toEqual([])
  })

  it('OR-N10: a named volume that survives makes the proof FAIL', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec })
    const s = make(fake)
    const stuck = new FakeDocker({ imageIds: images, exec: healthyExec, undeletableVolumes: [s.namedVolume] })
    stuck.volumes = fake.volumes
    stuck.containers = fake.containers
    const proof = destroySubstrate(stuck, s)
    expect(proof.verdict).toBe('DESTRUCTION_NOT_PROVEN')
    expect(proof.volumes.find((v) => v.name === s.namedVolume)?.absent).toBe(false)
    expect(proof.volumes_remaining_with_substrate_label).toBe(1)
  })

  it('OR-N10: an anonymous volume left by rm without -v makes the proof FAIL (the precedent weakness)', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec, anonymousVolumePerContainer: true, rmIgnoresV: true })
    const s = make(fake)
    const proof = destroySubstrate(fake, s)
    expect(proof.verdict).toBe('DESTRUCTION_NOT_PROVEN')
    expect(proof.volumes.find((v) => v.kind === 'anonymous')?.absent).toBe(false)
  })

  it('two substrates of the same role in one run: destroying one is proven while the other still exists', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec })
    const a = make(fake)
    const b = make(fake)
    expect(destroySubstrate(fake, a).verdict).toBe('DESTROYED_AND_VERIFIED_ABSENT')
    expect(fake.containers.has(b.identity.containerId)).toBe(true)
    expect(destroySubstrate(fake, b).verdict).toBe('DESTROYED_AND_VERIFIED_ABSENT')
  })

  it('a container that survives removal makes the proof FAIL', () => {
    const fake = new FakeDocker({ imageIds: images, exec: healthyExec })
    const s = make(fake)
    const survivor = { ...s, identity: { ...s.identity, containerId: 'f'.repeat(64) } }
    // rm targets an id that does not exist; the real container (by name) remains.
    const proof = destroySubstrate(fake, survivor)
    expect(proof.verdict).toBe('DESTRUCTION_NOT_PROVEN')
  })
})
