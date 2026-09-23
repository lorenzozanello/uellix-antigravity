// @vitest-environment node
// tests/recovery/event-class-neutrality.test.ts — OR-P7 / NB-3, BEHAVIORAL.
//
// The earlier version of this control grepped the source for `.eventClass` /
// `.event_class`; the recert of ec573e9b defeated it with an alias
// (destructuring, helper indirection) that changed behavior without matching
// the pattern. This file has no source-text oracle at all. For identical
// recovery inputs it varies ONLY event_class and requires that nothing the
// mechanism DOES varies: the docker calls issued, the SQL sent, the capture
// packet apart from the event_class value itself, the restore steps and
// outcome, the invariant selection and results, and the rehearsal verdict.
// Cleanup (destroySubstrate) takes no packet and therefore no event class.

import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NO_MUTATION_CONFIRMATION, type BackupPacket } from '../../scripts/recovery/artifact-packet'
import { captureLogicalBackup } from '../../scripts/recovery/capture'
import { DEFAULT_INVARIANT_PLAN, type InvariantContext } from '../../scripts/recovery/post-restore-invariants'
import { finalizeRehearsal } from '../../scripts/recovery/restore-proof'
import { restoreIntoSubstrate } from '../../scripts/recovery/restore-runner'
import { sampleCensus, sampleCensusRecord, samplePacket } from './sample-evidence'
import { scriptedWorld, type ScriptedWorld } from './scripted-world'

const REPO = path.resolve(import.meta.dirname, '../..')
const CLASSES = [null, 'S1_CORPUS_NO_NEW_RUNTIME', 'STELLA_0017B_BRIDGE_DEPLOYED', 'QUIESCE', 'ACCEPT', 'X1']
const ROLES = path.join(REPO, 'tests/recovery/fixtures/recovery-fixture-roles.sql')
const POST = path.join(REPO, 'db/baseline/stella_g2_post_restore.sql')

/** The packet minus the event_class VALUE and the wall-clock capture interval. */
function neutral(p: BackupPacket): unknown {
  const c = structuredClone(p)
  c[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class.value = null
  c['backup timestamp'] = { capture_started_at: 'T', capture_finished_at: 'T' }
  return c
}

const worlds: ScriptedWorld[] = []
afterEach(() => {
  while (worlds.length) worlds.pop()!.cleanup()
})

async function runFor(eventClass: string | null) {
  const w = scriptedWorld({ repoRoot: REPO })
  worlds.push(w)
  const cap = await captureLogicalBackup(w.fake, w.captureRequest({ eventClass }))
  if (!cap.ok) throw new Error(`capture refused: ${cap.code}`)
  const captureCalls = JSON.stringify(w.fake.calls)
  const capturePsql = JSON.stringify(w.psqlInputs)
  const restore = await restoreIntoSubstrate(w.fake, {
    target: w.restoreSubstrate.identity,
    substrate: w.restoreSubstrate,
    packet: cap.packet,
    sourceCensus: cap.sourceCensus,
    artifactPath: cap.artifactPath,
    repoRoot: REPO,
    rolesCorpusPath: ROLES,
    postRestoreCorpusPath: POST,
  })
  return {
    packet: cap.packet,
    captureCalls,
    capturePsql,
    allCalls: JSON.stringify(w.fake.calls),
    allPsql: JSON.stringify(w.psqlInputs),
    restore: JSON.stringify({ ...restore, restore_started_at: 'T', restore_finished_at: 'T' }),
  }
}

describe('event_class is descriptive metadata only (behavioral differential)', () => {
  it('capture and restore behave identically for every event class; only the carried value differs', async () => {
    const runs = []
    for (const c of CLASSES) runs.push(await runFor(c))
    const [ref, ...rest] = runs
    for (const [i, r] of rest.entries()) {
      const cls = CLASSES[i + 1]
      expect(r.packet[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class).toEqual({ value: cls, policy: 'NOT_CHOSEN_BY_THIS_MECHANISM' })
      expect(neutral(r.packet), `packet for ${cls}`).toEqual(neutral(ref.packet))
      expect(r.captureCalls, `capture docker calls for ${cls}`).toBe(ref.captureCalls)
      expect(r.capturePsql, `capture SQL for ${cls}`).toBe(ref.capturePsql)
      expect(r.allCalls, `restore docker calls for ${cls}`).toBe(ref.allCalls)
      expect(r.allPsql, `restore SQL for ${cls}`).toBe(ref.allPsql)
      expect(r.restore, `restore outcome for ${cls}`).toBe(ref.restore)
    }
  })

  it('invariant selection and results are identical across event classes, on a faithful AND on a broken restore', () => {
    const ctxFor = (eventClass: string | null, broken: boolean): InvariantContext => {
      const restored = sampleCensus()
      if (broken) restored.triggers[0].enabled = 'D'
      return {
        packet: samplePacket({ eventClass }),
        sourceCensus: sampleCensus(),
        restored,
        restoredCensusProblem: null,
        restore: { ok: true, refusal: null, refusal_detail: null, restore_database: 'd', restore_started_at: 'T', restore_finished_at: 'T', streamed_sha256: null, steps: [], roles_at_start: ['a'], roles_after_restore: ['a', 'fixture_app_owner', 'fixture_capability', 'pg_database_owner'], tool_refusals: [], target_observation: null, substrate_server_version_num: 170006 },
        probeResults: [{ probe: { role: 'fixture_capability', fn: 'public.fixture_capability_probe' }, sqlstate: null, exitCode: 0 }],
        rollbackCensus: { census: restored, problem: null },
        restoredCensusSha256: 'a'.repeat(64),
      }
    }
    for (const broken of [false, true]) {
      const ref = JSON.stringify(DEFAULT_INVARIANT_PLAN.map((e) => [e.id, e.evaluate(ctxFor(null, broken))]))
      for (const c of CLASSES) expect(JSON.stringify(DEFAULT_INVARIANT_PLAN.map((e) => [e.id, e.evaluate(ctxFor(c, broken))])), `${c} broken=${broken}`).toBe(ref)
    }
  })

  it('the rehearsal verdict and its reasons are identical across event classes', () => {
    const verdictFor = (eventClass: string | null) => {
      const { bundle } = finalizeRehearsal({
        runId: 'abcdef0123456789',
        packet: samplePacket({ eventClass }),
        sourceCensus: sampleCensusRecord(),
        restoreProof: null,
        captureRefusal: null,
        restore: null,
        invariants: [],
        acceptedUnknowns: ['PRI-7'],
        destructions: [],
        otherDestructions: [],
        expectedDestructions: 1,
        artifactDisposal: { artifact_sha256: null, disposed_at: '2026-09-23T20:00:00.000Z', directory_absent: true, verdict: 'DISPOSED_AND_VERIFIED_ABSENT' },
        setupRefusal: null,
        secrets: [],
      })
      return JSON.stringify([bundle.rehearsal_record.verdict, bundle.rehearsal_record.verdict_reasons])
    }
    const ref = verdictFor(null)
    for (const c of CLASSES) expect(verdictFor(c), String(c)).toBe(ref)
  })
})
