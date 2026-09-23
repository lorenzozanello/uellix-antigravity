// @vitest-environment node
// tests/recovery/restore-runner.test.ts — OR-N3 (wrong target identity accepted
// -> RED), OR-N20 (non-pristine substrate), and the verdict rule OR-N5 at the
// unit level (restore exit 0 but invariant broken -> RED).

import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { decideRehearsalVerdict, type VerdictInput } from '../../scripts/recovery/offline-rehearsal'
import { restoreIntoSubstrate, rolePristineProblem, type RestoreRequest } from '../../scripts/recovery/restore-runner'
import { RUN_LABEL, ROLE_LABEL, type Substrate } from '../../scripts/recovery/substrate'
import { PINNED_IMAGE_BASELINE_ROLES, RECOVERY_TOOL_PIN } from '../../scripts/recovery/tool-pin'
import { FakeDocker } from './fake-docker'
import { samplePacket } from './sample-evidence'

const REPO = path.resolve(import.meta.dirname, '../..')
const RUN = 'abcdef0123456789'

function world(labels: Record<string, string> = { [RUN_LABEL]: RUN, [ROLE_LABEL]: 'restore-substrate' }, name = 'uellix-recovery-restore-substrate-x') {
  const fake = new FakeDocker()
  const c = fake.addContainer({ name, image: RECOVERY_TOOL_PIN.imageId, labels })
  const substrate: Substrate = {
    identity: { identityClass: 'LOCAL_DISPOSABLE', containerId: c.id, containerName: name, runId: RUN, role: 'restore-substrate', imageId: RECOVERY_TOOL_PIN.imageId },
    namedVolume: 'v',
    recordedVolumes: [{ name: 'v', kind: 'named' }],
    createdAt: '2026-09-23T20:00:00.000Z',
    password: 'x',
  }
  const req: RestoreRequest = {
    target: substrate.identity,
    substrate,
    packet: samplePacket(),
    artifactPath: path.join(tmpdir(), 'never-read.dump'),
    repoRoot: REPO,
    rolesCorpusPath: 'unused',
    postRestoreCorpusPath: null,
  }
  return { fake, substrate, req }
}

describe('OR-N3: restore target identity', () => {
  it('a HOSTED identity is never a restore target, whatever it verified as', async () => {
    const { fake, req } = world()
    const out = await restoreIntoSubstrate(fake, { ...req, target: { identityClass: 'HOSTED_STAGING', projectRef: 'bvyzblhqymxruxdguaee', signals: [], sentinelDeferred: false } })
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_TARGET_NOT_DISPOSABLE' })
    expect(fake.calls).toEqual([])
  })

  it('a claimed target that is not the substrate handed in is refused', async () => {
    const { fake, req } = world()
    const out = await restoreIntoSubstrate(fake, { ...req, target: { ...req.substrate.identity, containerId: 'e'.repeat(64) } })
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_TARGET_NOT_THE_SUBSTRATE' })
    const out2 = await restoreIntoSubstrate(fake, { ...req, target: { ...req.substrate.identity, runId: 'ffffffff00000000' } })
    expect(out2).toMatchObject({ ok: false, refusal: 'RESTORE_TARGET_NOT_THE_SUBSTRATE' })
  })

  it.each<[string, Record<string, string>, string?]>([
    ['another run', { [RUN_LABEL]: 'ffffffff00000000', [ROLE_LABEL]: 'restore-substrate' }],
    ['the SOURCE fixture of this run', { [RUN_LABEL]: RUN, [ROLE_LABEL]: 'source-fixture' }],
    ['the canonical local Supabase stack (no labels)', {}, 'supabase_db_uellix-antigravity'],
  ])('a container labelled for %s is refused before any artifact byte moves', async (_l, labels, name) => {
    const { fake, req } = world(labels, name)
    const out = await restoreIntoSubstrate(fake, req)
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_TARGET_OWNERSHIP_REFUSED', refusal_detail: 'SUBSTRATE_NOT_OWNED_BY_RUN' })
    expect(fake.calls.every((c) => c[0] === 'inspect')).toBe(true)
  })

  it('OR-N11 at restore time: a substrate whose network is no longer "none" is refused', async () => {
    const { fake, req } = world()
    fake.containers.get(req.substrate.identity.containerId)!.networkMode = 'bridge'
    const out = await restoreIntoSubstrate(fake, req)
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_TARGET_OWNERSHIP_REFUSED', refusal_detail: 'SUBSTRATE_NETWORK_NOT_ISOLATED' })
  })
})

describe('OR-N20: role-pristine substrate', () => {
  it('the pinned image baseline is pristine', () => {
    expect(rolePristineProblem([...PINNED_IMAGE_BASELINE_ROLES])).toBeNull()
  })

  it('a pre-existing application role (the masking hazard) is not pristine', () => {
    expect(rolePristineProblem([...PINNED_IMAGE_BASELINE_ROLES, 'fixture_app_owner'])).toMatch(/beyond the pinned image baseline/)
  })

  it('a missing baseline role means the image is not the pin', () => {
    expect(rolePristineProblem(PINNED_IMAGE_BASELINE_ROLES.filter((r) => r !== 'anon'))).toMatch(/absent/)
  })
})

describe('OR-N5: the rehearsal verdict never trusts exit status alone', () => {
  const pass: VerdictInput = {
    captureOk: true,
    restore: { ok: true },
    invariants: [
      { id: 'PRI-1', verdict: 'PASS' },
      { id: 'PRI-5', verdict: 'PASS' },
      { id: 'PRI-7', verdict: 'UNKNOWN' },
    ],
    acceptedUnknowns: ['PRI-7'],
    destruction: [{ verdict: 'DESTROYED_AND_VERIFIED_ABSENT' }, { verdict: 'DESTROYED_AND_VERIFIED_ABSENT' }],
    expectedDestructions: 2,
    artifactDisposed: true,
  }

  it('all green -> PASS', () => {
    expect(decideRehearsalVerdict(pass)).toEqual({ verdict: 'OFFLINE_REHEARSAL_PASS', reasons: [] })
  })

  it('restore ok but one invariant FAIL -> FAIL', () => {
    const v = decideRehearsalVerdict({ ...pass, invariants: [...pass.invariants, { id: 'PRI-2', verdict: 'FAIL' }] })
    expect(v).toEqual({ verdict: 'OFFLINE_REHEARSAL_FAIL', reasons: ['INVARIANT_FAIL_PRI_2'] })
  })

  it('an UNKNOWN not accepted in writing -> FAIL', () => {
    expect(decideRehearsalVerdict({ ...pass, acceptedUnknowns: [] }).reasons).toEqual(['INVARIANT_UNKNOWN_NOT_ACCEPTED_PRI_7'])
  })

  it('no invariants, or no negative-capable check passing -> FAIL', () => {
    expect(decideRehearsalVerdict({ ...pass, invariants: [] }).reasons).toEqual(['NO_INVARIANTS_EVALUATED', 'NO_NEGATIVE_CAPABLE_CHECK_PASSED'])
    expect(decideRehearsalVerdict({ ...pass, invariants: [{ id: 'PRI-1', verdict: 'PASS' }] }).reasons).toEqual(['NO_NEGATIVE_CAPABLE_CHECK_PASSED'])
  })

  it('an unproven destruction, a missing destruction or an undisposed artifact -> FAIL', () => {
    expect(decideRehearsalVerdict({ ...pass, destruction: [{ verdict: 'DESTRUCTION_NOT_PROVEN' }, pass.destruction[0]] }).reasons).toEqual(['DESTRUCTION_NOT_PROVEN'])
    expect(decideRehearsalVerdict({ ...pass, destruction: [pass.destruction[0]] }).reasons).toEqual(['SUBSTRATE_DESTRUCTION_MISSING'])
    expect(decideRehearsalVerdict({ ...pass, artifactDisposed: false }).reasons).toEqual(['ARTIFACT_DISPOSAL_NOT_PROVEN'])
  })

  it('capture or restore failure -> FAIL even with green invariants', () => {
    expect(decideRehearsalVerdict({ ...pass, restore: { ok: false } }).reasons).toEqual(['RESTORE_FAILED'])
    expect(decideRehearsalVerdict({ ...pass, captureOk: false }).reasons).toEqual(['CAPTURE_FAILED'])
  })
})
