// tests/custody/d1-peb-identity.test.ts
//
// R2-N-PID-REUSE (manifest amendment v1.0.1). The recertification of 979b1440
// found the PEB observer keyed by PID alone: Windows reuses a PID as soon as a
// process is gone, so one record could merge two processes (a clean launcher
// "holding" another process's value, or a holder reclassified as clean), and a
// new process reusing a baseline PID was never inspected. Records are now keyed
// by (pid, creation time) and the tree is resolved by parentOf. These controls
// are pure (synthetic dumps), so the reuse is deterministic; the last one runs
// the real observer on Windows for the structural identity only.

import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  PEB_OBSERVER_POWERSHELL_SOURCE,
  PebObserver,
  childrenOf,
  identityReasons,
  parentOf,
  processKey,
  recordForSpawn,
  type PebObservedProcess,
} from '@/scripts/custody/n05-peb-observer'

function rec(pid: number, createdMs: number, over: Partial<PebObservedProcess> = {}): PebObservedProcess {
  return {
    pid,
    createdMs,
    lastSeenMs: createdMs + 10,
    ppid: -1,
    name: 'node',
    cmdReadable: true,
    envReadable: true,
    envVar: false,
    govCmd: 0,
    govEnv: 0,
    fixCmd: 0,
    fixEnv: 0,
    classes: 0,
    reads: 3,
    alive: false,
    firstSeenAt: 'x',
    ...over,
  }
}

// A clean launcher (pid 100) and, after it exits, an unrelated holder that reuses pid 100.
const LAUNCHER = rec(100, 1_000, { ppid: 1 })
const REUSER = rec(100, 5_000, { ppid: 1, envVar: true, govEnv: 1, name: 'other' })
const TOOL = rec(200, 1_100, { ppid: 100, envVar: true, govEnv: 1 })
const REUSER_CHILD = rec(300, 5_100, { ppid: 100 })
const DUMP = [LAUNCHER, REUSER, TOOL, REUSER_CHILD]

describe('R2-N-PID-REUSE: two processes that share a PID stay two records', () => {
  it('identity is (pid, creation time): the dump has no duplicate key', () => {
    expect(processKey(LAUNCHER)).not.toBe(processKey(REUSER))
    expect(identityReasons({ polls: 3, processes: DUMP })).toEqual([])
  })
  it('the launcher spawned in [900, 1200] is the clean record, not the reuser that holds the value', () => {
    const l = recordForSpawn(DUMP, 100, { fromMs: 900, toMs: 1_200 })
    expect(l).toBe(LAUNCHER)
    expect([l!.envVar, l!.govEnv]).toEqual([false, 0])
  })
  it('a spawn window that matches both records is ambiguous and fails closed (null)', () => {
    expect(recordForSpawn(DUMP, 100, { fromMs: 0, toMs: 10_000 })).toBeNull()
    expect(recordForSpawn(DUMP, 100, { fromMs: 2_000, toMs: 3_000 })).toBeNull()
  })
  it('each child is attributed to the same-pid record created most recently before it', () => {
    expect(parentOf(DUMP, TOOL)).toBe(LAUNCHER)
    expect(parentOf(DUMP, REUSER_CHILD)).toBe(REUSER)
    expect(childrenOf(DUMP, LAUNCHER)).toEqual([TOOL])
    expect(childrenOf(DUMP, REUSER)).toEqual([REUSER_CHILD])
  })
  it('a child created before any record of its ppid has no parent (never attributed to a later reuser)', () => {
    const orphan = rec(400, 500, { ppid: 100 })
    expect(parentOf([...DUMP, orphan], orphan)).toBeNull()
  })
  it('the old pid-keyed reading would have reclassified the clean launcher (the finding, reproduced)', () => {
    // A pid-keyed merge ORs masks: the launcher would appear to hold the value.
    const merged = DUMP.filter((p) => p.pid === 100).reduce((a, p) => ({ envVar: a.envVar || p.envVar, govEnv: a.govEnv | p.govEnv }), { envVar: false, govEnv: 0 })
    expect(merged).toEqual({ envVar: true, govEnv: 1 })
  })
  it('a duplicate identity, or a readable record without a creation time, is reported', () => {
    expect(identityReasons({ polls: 1, processes: [LAUNCHER, { ...LAUNCHER }] })).toEqual(['two records share one (pid, creation time) identity'])
    expect(identityReasons({ polls: 1, processes: [rec(7, 0)] })).toEqual(['pid 7 was read without a creation time'])
    expect(identityReasons({ polls: 1, processes: [rec(7, 0, { envReadable: false, cmdReadable: false })] })).toEqual([])
  })
})

describe('the observer program reads identity through the handle it reads the PEB from', () => {
  it('keys records by pid and creation time, and never skips by PID alone', () => {
    expect(PEB_OBSERVER_POWERSHELL_SOURCE).toContain('GetProcessTimes')
    expect(PEB_OBSERVER_POWERSHELL_SOURCE).toContain('Dictionary<string, Rec> recs')
    expect(PEB_OBSERVER_POWERSHELL_SOURCE).toContain('baseline.Contains(key) && !watch.Contains(key)')
    expect(PEB_OBSERVER_POWERSHELL_SOURCE).not.toMatch(/baseline\.Contains\(pr\.Id\)/)
  })
  it.runIf(process.platform === 'win32')(
    'the real observer: a spawned child is found by (pid, spawn window), with a creation time, and no key repeats',
    async () => {
      const obs = await PebObserver.start({ rootPid: process.pid, envVarName: 'D1_PEB_IDENTITY_TEST', governed: [], fixture: [Buffer.from('d1-peb-identity-fixture', 'latin1')], classes: [] })
      try {
        const pids: Array<{ pid: number; fromMs: number; toMs: number }> = []
        for (let k = 0; k < 3; k++) {
          const fromMs = Date.now()
          const ch = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<400){}'], { stdio: 'ignore', env: { ...process.env, D1_OBSERVER_FIXTURE: 'd1-peb-identity-fixture' } })
          await new Promise((r) => ch.on('close', r))
          pids.push({ pid: ch.pid ?? -1, fromMs, toMs: Date.now() })
        }
        const d = await obs.dump()
        expect(identityReasons(d)).toEqual([])
        for (const s of pids) {
          const r = recordForSpawn(d.processes, s.pid, s)
          expect(r, `pid ${s.pid}`).not.toBeNull()
          expect(r!.createdMs).toBeGreaterThan(0)
          expect(r!.fixEnv).not.toBe(0)
        }
      } finally {
        await obs.stop()
      }
    },
    60_000
  )
})
