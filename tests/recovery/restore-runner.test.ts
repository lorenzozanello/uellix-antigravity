// @vitest-environment node
// tests/recovery/restore-runner.test.ts — OR-N3 (wrong target identity accepted
// -> RED), OR-N20 (non-pristine substrate), NB-3 BEHAVIORAL oracles (bytes that
// change DURING the stream; the runner actually USING the TOC check), the
// non-destructive TOC selection (NB-5), and the verdict rule OR-N5 at the unit
// level (restore exit 0 but invariant broken -> RED).

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { captureLogicalBackup } from '../../scripts/recovery/capture'
import { decideRehearsalVerdict, type VerdictInput } from '../../scripts/recovery/restore-proof'
import { IN_CONTAINER_TOC_LIST, restoreIntoSubstrate, rolePristineProblem, type RestoreRequest } from '../../scripts/recovery/restore-runner'
import { RUN_LABEL, ROLE_LABEL, type Substrate } from '../../scripts/recovery/substrate'
import { PINNED_IMAGE_BASELINE_ROLES, RECOVERY_TOOL_PIN } from '../../scripts/recovery/tool-pin'
import { FakeDocker } from './fake-docker'
import { sampleCensusRecord, samplePacket } from './sample-evidence'
import { scriptedWorld, TOC_LISTING, type ScriptedWorld } from './scripted-world'

const REPO = path.resolve(import.meta.dirname, '../..')
const RUN = 'abcdef0123456789'
const ROLES = path.join(REPO, 'tests/recovery/fixtures/recovery-fixture-roles.sql')
const POST = path.join(REPO, 'db/baseline/stella_g2_post_restore.sql')

function world(labels: Record<string, string> = { [RUN_LABEL]: RUN, [ROLE_LABEL]: 'restore-substrate' }, name = 'uellix-recovery-restore-substrate-x') {
  const fake = new FakeDocker()
  const c = fake.addContainer({ name, image: RECOVERY_TOOL_PIN.imageId, labels })
  const substrate: Substrate = {
    identity: { identityClass: 'LOCAL_DISPOSABLE', containerId: c.id, containerName: name, runId: RUN, role: 'restore-substrate', imageId: RECOVERY_TOOL_PIN.imageId },
    namedVolume: 'v',
    recordedVolumes: [{ name: 'v', kind: 'named' }],
    createdAt: '2026-09-23T20:00:00.000Z',
    observed: { imageId: RECOVERY_TOOL_PIN.imageId, networkMode: 'none' },
    password: 'x',
  }
  const req: RestoreRequest = {
    target: substrate.identity,
    substrate,
    packet: samplePacket(),
    sourceCensus: sampleCensusRecord(),
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

  it('a census record that is not the one the packet is bound to is refused before any artifact byte moves', async () => {
    const { fake, req } = world()
    const other = sampleCensusRecord()
    other.census.row_counts[0].rows = 42
    const out = await restoreIntoSubstrate(fake, { ...req, sourceCensus: other })
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_SOURCE_CENSUS_NOT_BOUND' })
    expect(fake.streamCalls).toEqual([])
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

describe('scripted end-to-end restore (behavioral)', () => {
  let w: ScriptedWorld | null = null
  afterEach(() => w?.cleanup())

  async function captured(onStream?: Parameters<typeof scriptedWorld>[0]['onStream'], tocListing?: string) {
    w = scriptedWorld({ repoRoot: REPO, onStream, tocListing })
    const cap = await captureLogicalBackup(w.fake, w.captureRequest())
    if (!cap.ok) throw new Error(`scripted capture refused: ${cap.code}`)
    const req: RestoreRequest = {
      target: w.restoreSubstrate.identity,
      substrate: w.restoreSubstrate,
      packet: cap.packet,
      sourceCensus: cap.sourceCensus,
      artifactPath: cap.artifactPath,
      repoRoot: REPO,
      rolesCorpusPath: ROLES,
      postRestoreCorpusPath: POST,
    }
    return { w, req }
  }

  it('a faithful artifact restores with -L selection, NO DROP SCHEMA anywhere, and records the observed target', async () => {
    const { w, req } = await captured()
    const out = await restoreIntoSubstrate(w.fake, req)
    expect(out.refusal).toBeNull()
    expect(out.steps.map((s) => [s.step, s.status])).toEqual([
      ['TOC', 'SUCCESS'],
      ['ROLES_CORPUS', 'SUCCESS'],
      ['CREATE_DATABASE', 'SUCCESS'],
      ['TOC_SELECTION', 'SUCCESS'],
      ['PG_RESTORE', 'SUCCESS'],
      ['POST_RESTORE_CORPUS', 'SUCCESS'],
    ])
    const restoreCall = w.fake.streamCalls.find((c) => c.includes('-d'))!
    expect(restoreCall).toEqual(expect.arrayContaining(['-L', IN_CONTAINER_TOC_LIST, '--exit-on-error']))
    expect(w.psqlInputs.some((sql) => /DROP\s+SCHEMA/i.test(sql))).toBe(false)
    expect(out.target_observation).toEqual({ image_id: RECOVERY_TOOL_PIN.imageId, network_mode: 'none' })
  })

  it('NB-3: bytes that change AFTER validation but BEFORE the TOC stream -> STOP (no restore)', async () => {
    const { w, req } = await captured((_args, file, i) => {
      if (i === 0) writeFileSync(file, Buffer.from('PGDMP tampered after validation'))
    })
    const out = await restoreIntoSubstrate(w.fake, req)
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' })
    expect(w.fake.streamCalls).toHaveLength(1)
  })

  it('NB-3: bytes that change DURING the pg_restore stream (after TOC passed) -> STOP, nothing after it runs', async () => {
    const { w, req } = await captured((args, file, i) => {
      if (i === 1 && args.includes('-d')) writeFileSync(file, Buffer.from('PGDMP tampered mid-restore'))
    })
    const out = await restoreIntoSubstrate(w.fake, req)
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_STREAM_DIGEST_MISMATCH' })
    expect(out.steps.map((s) => s.step)).not.toContain('POST_RESTORE_CORPUS')
    expect(out.steps.at(-1)?.step).toBe('PG_RESTORE')
  })

  it('NB-3: the runner USES the TOC check — a listing missing a captured table is refused before any role or database is created', async () => {
    const { w, req } = await captured(undefined, TOC_LISTING.replace(/^222; .*$/m, ''))
    const out = await restoreIntoSubstrate(w.fake, req)
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_ARTIFACT_STRUCTURE_REFUSED', refusal_detail: 'ARTIFACT_TOC_RELATIONS_MISMATCH' })
    expect(out.steps.map((s) => s.step)).toEqual(['TOC'])
  })

  it('the runner USES the TOC header: an archive dumped by another pg_dump version is refused as tool skew', async () => {
    const { w, req } = await captured(undefined, TOC_LISTING.replace('Dumped by pg_dump version: 17.6', 'Dumped by pg_dump version: 16.4'))
    const out = await restoreIntoSubstrate(w.fake, req)
    expect(out).toMatchObject({ ok: false, refusal: 'RESTORE_TOOL_PIN_REFUSED' })
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
