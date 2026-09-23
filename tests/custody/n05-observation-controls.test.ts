// @vitest-environment node
// tests/custody/n05-observation-controls.test.ts
//
// THE PROCESS CONTROLS, DERIVED FROM SYNTHETIC OBSERVATIONS.
//
// The demonstration's RC-3, NP10, RC-7 and OBS0 are pure functions of what the
// PEB observer reports, so every rule the independent certification found
// broken is pinned here, on every platform:
//
//   - a conhost.exe (or ANY process) under a delivered consumer that carries
//     the variable makes RC-7 FAIL — there is no name exemption to hide in;
//   - zero observed subjects is NOT_RUN, never PASSED;
//   - a base64 representation in a command line fails RC-3 and NP10;
//   - an observer that did not find the injected fixture makes every process
//     control NOT_RUN, because a clean result from a blind reader is nothing.

import { describe, expect, it } from 'vitest'
import {
  CLASS_BRIDGE,
  CLASS_CONSUMER,
  deriveObservationControls,
  governedRepresentations,
  type ObservationInput,
} from '@/scripts/custody/n05-observation-controls'
import type { PebObservedProcess } from '@/scripts/custody/n05-peb-observer'

const LAUNCHER = 100

function p(pid: number, ppid: number, name: string, extra: Partial<PebObservedProcess> = {}): PebObservedProcess {
  return {
    pid,
    ppid,
    name,
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
    ...extra,
  }
}

/** A clean, fully observed run: three bridges, one delivered consumer, two fixtures. */
function cleanRun(): PebObservedProcess[] {
  return [
    p(LAUNCHER, 1, 'node'),
    p(201, LAUNCHER, 'powershell', { classes: CLASS_BRIDGE }),
    p(202, LAUNCHER, 'powershell', { classes: CLASS_BRIDGE }),
    p(203, LAUNCHER, 'powershell', { classes: CLASS_BRIDGE }),
    p(211, 201, 'conhost'),
    p(300, LAUNCHER, 'node', { classes: CLASS_CONSUMER, envVar: true, govEnv: 0b01 }),
    p(400, LAUNCHER, 'node', { fixCmd: 0b01, fixEnv: 0b10 }),
    p(401, LAUNCHER, 'node', { fixCmd: 0b10, fixEnv: 0b01 }),
  ]
}

function input(processes: PebObservedProcess[], over: Partial<ObservationInput> = {}): ObservationInput {
  return {
    processes,
    launcherPid: LAUNCHER,
    deliveredConsumerPids: [300],
    fixturePids: [400, 401],
    governedCount: 2,
    fixtureCount: 2,
    minBridgeSubjects: 3,
    ...over,
  }
}

describe('a clean, fully observed run passes', () => {
  it('reports every process control PASSED', () => {
    const d = deriveObservationControls(input(cleanRun()))
    expect([d.OBS0, d.NP10, d.RC3, d.RC7]).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED'])
    expect(d.subjects.deliveredConsumersObserved).toBe(1)
    expect(d.subjects.consumerDescendants).toEqual([])
  })
})

describe('B-1 regression: nothing is clean because of its name', () => {
  it('FAILS RC-7 when a conhost.exe under the consumer carries the variable', () => {
    const run = [...cleanRun(), p(310, 300, 'conhost', { envVar: true, govEnv: 0b01 })]
    const d = deriveObservationControls(input(run))
    expect(d.RC7).toBe('FAILED')
    expect(d.reasons.join(' ')).toContain('conhost(pid 310')
  })

  it('FAILS RC-7 when a runtime helper under the consumer carries the value (the esbuild case)', () => {
    const run = [...cleanRun(), p(311, 300, 'esbuild', { envVar: true, govEnv: 0b01 })]
    expect(deriveObservationControls(input(run)).RC7).toBe('FAILED')
  })

  it('FAILS RC-7 when a consumer descendant could not be read, instead of assuming it clean', () => {
    const run = [...cleanRun(), p(312, 300, 'conhost', { envReadable: false })]
    expect(deriveObservationControls(input(run)).RC7).toBe('FAILED')
  })

  it('FAILS RC-7 when the launcher itself carried the variable (a process.env write)', () => {
    const run = cleanRun().map((x) => (x.pid === LAUNCHER ? { ...x, envVar: true } : x))
    expect(deriveObservationControls(input(run)).RC7).toBe('FAILED')
  })

  it('FAILS RC-7 when a bridge carried the variable', () => {
    const run = cleanRun().map((x) => (x.pid === 202 ? { ...x, envVar: true } : x))
    expect(deriveObservationControls(input(run)).RC7).toBe('FAILED')
  })

  it('FAILS RC-7 when the delivered consumer did NOT show the variable: the reader proved nothing', () => {
    const run = cleanRun().map((x) => (x.pid === 300 ? { ...x, envVar: false, govEnv: 0 } : x))
    expect(deriveObservationControls(input(run)).RC7).toBe('FAILED')
  })
})

describe('zero observed subjects is NOT_RUN, never PASSED', () => {
  it('reports RC-7 and RC-3 NOT_RUN when no delivered consumer was observed', () => {
    const d = deriveObservationControls(input(cleanRun().filter((x) => x.pid !== 300)))
    expect(d.RC7).toBe('NOT_RUN')
    expect(d.RC3).toBe('NOT_RUN')
  })

  it('reports RC-3 NOT_RUN when fewer bridges were observed than the run started', () => {
    const d = deriveObservationControls(input(cleanRun().filter((x) => x.pid !== 203)))
    expect(d.RC3).toBe('NOT_RUN')
  })

  it('reports NP10 NOT_RUN when the observer saw nothing of the launcher tree', () => {
    const fixturesOnly = cleanRun().filter((x) => x.pid >= 400)
    const d = deriveObservationControls(input(fixturesOnly, { launcherPid: 999 }))
    expect(d.NP10).toBe('NOT_RUN')
  })
})

describe('RC-3 and NP10 see the raw AND the base64 representation', () => {
  it.each([
    ['raw', 0b01],
    ['base64', 0b10],
  ])('FAIL when the consumer argv carries the %s value', (_label, mask) => {
    const run = cleanRun().map((x) => (x.pid === 300 ? { ...x, govCmd: mask } : x))
    const d = deriveObservationControls(input(run))
    expect(d.RC3).toBe('FAILED')
    expect(d.NP10).toBe('FAILED')
  })

  it('FAIL when a bridge argv carries the value', () => {
    const run = cleanRun().map((x) => (x.pid === 201 ? { ...x, govCmd: 0b10 } : x))
    expect(deriveObservationControls(input(run)).RC3).toBe('FAILED')
  })

  it('FAIL NP10 when any process in the tree carries it, bridge or not', () => {
    const run = [...cleanRun(), p(500, LAUNCHER, 'taskkill', { govCmd: 0b01 })]
    expect(deriveObservationControls(input(run)).NP10).toBe('FAILED')
  })

  it('FAIL NP10 when a process in the tree could not be read', () => {
    const run = [...cleanRun(), p(501, 201, 'cvtres', { cmdReadable: false, envReadable: false })]
    expect(deriveObservationControls(input(run)).NP10).toBe('FAILED')
  })
})

describe('OBS0: a blind observer makes every process control NOT_RUN', () => {
  it('when no fixture was observed', () => {
    const d = deriveObservationControls(input(cleanRun().filter((x) => x.pid < 400)))
    expect(d.OBS0).toBe('NOT_RUN')
    expect([d.NP10, d.RC3, d.RC7]).toEqual(['NOT_RUN', 'NOT_RUN', 'NOT_RUN'])
  })

  it('when the fixture was seen in argv but not in an environment block', () => {
    const run = cleanRun().map((x) => (x.pid >= 400 ? { ...x, fixEnv: 0 } : x))
    const d = deriveObservationControls(input(run))
    expect(d.OBS0).toBe('FAILED')
    expect(d.RC7).toBe('NOT_RUN')
  })

  it('when only ONE of the two representations was ever detected', () => {
    const run = cleanRun().map((x) => (x.pid >= 400 ? { ...x, fixCmd: 0b01, fixEnv: 0b01 } : x))
    expect(deriveObservationControls(input(run)).OBS0).toBe('FAILED')
  })
})

describe('the governed representations are exactly the ones the transport creates', () => {
  it('are the raw bytes and their base64, in that order, and nothing else', () => {
    const v = Buffer.from('synthetic-value-for-representation-test', 'utf8')
    const reps = governedRepresentations(v)
    expect(reps.map((r) => r.toString('latin1'))).toEqual([v.toString('latin1'), v.toString('base64')])
  })
})
