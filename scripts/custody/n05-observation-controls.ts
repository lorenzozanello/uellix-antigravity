// scripts/custody/n05-observation-controls.ts
//
// FROM WHAT THE OBSERVER SAW TO THE CONTROL STATES. PURE, AND THEREFORE TESTED
// ON EVERY PLATFORM.
//
// Three rules the first version broke, each now structural:
//
//   NO PROCESS IS CLEAN BECAUSE OF ITS NAME. The first RC-7 exempted
//   conhost.exe by name; the independent certification read its environment
//   block and found the value. Here every descendant of every delivered
//   consumer is judged by its OWN environment block, and a descendant whose
//   block could not be read is a FAILURE, never a pass.
//
//   ZERO SUBJECTS IS NOT_RUN. A control over processes that observed none of
//   the processes it is about reports NOT_RUN, which the summary treats as
//   blocking. It can never report PASSED.
//
//   AN OBSERVER NOT SHOWN TO SEE IS NOT BELIEVED. Every negative result below
//   is conditional on the positive control: the observer must have found an
//   injected fixture in BOTH a command line and an environment block, in
//   EVERY representation it searches. Until it has, the process controls are
//   NOT_RUN — a clean result from a blind observer is not a clean result.

import { encodeBase64Bytes } from '../../db/custody/base64-bytes'
import type { ControlState } from '../../db/custody/n05-control-state'
import type { PebObservedProcess } from './n05-peb-observer'

/**
 * THE GOVERNED REPRESENTATIONS: every form in which the implemented transport
 * puts the value into a process-visible byte sequence, and no others.
 *
 *   raw      the environment entry of the delivered consumer.
 *   base64   the stdin framing of a deposit and the blob line of a retrieval,
 *            both produced by `encodeBase64Bytes` / the bridge's own
 *            [Convert]::ToBase64String over the same bytes.
 *
 * The first RC-3 searched only the raw form, so the base64 form in a consumer
 * argv passed it (independent certification, mutant D13). Nothing else is
 * derived: the transport creates no third encoding, and inventing a codec zoo
 * would make the control's scope a guess rather than a measurement.
 */
export function governedRepresentations(value: Buffer): Buffer[] {
  return [Buffer.from(value), encodeBase64Bytes(value)]
}

/** Bit positions of the classifier markers passed to the observer. */
export const CLASS_BRIDGE = 1 << 0
export const CLASS_CONSUMER = 1 << 1

export interface ObservationInput {
  readonly processes: readonly PebObservedProcess[]
  /** The launcher: the process that reads the vault through the bridge and sets the consumer's block. */
  readonly launcherPid: number
  /** Consumers that were DELIVERED the value, by pid, as reported at spawn. */
  readonly deliveredConsumerPids: readonly number[]
  /** Positive-control fixture processes, by pid. */
  readonly fixturePids: readonly number[]
  /** How many governed representations were searched (bits in govCmd/govEnv). */
  readonly governedCount: number
  /** How many fixture representations were searched (bits in fixCmd/fixEnv). */
  readonly fixtureCount: number
  /** The fewest bridge processes RC-3 must have observed (deposit + retrieval at least). */
  readonly minBridgeSubjects: number
}

export interface ObservationControls {
  readonly OBS0: ControlState
  readonly NP10: ControlState
  readonly RC3: ControlState
  readonly RC7: ControlState
  readonly subjects: {
    readonly treeSize: number
    readonly bridges: number
    readonly deliveredConsumersObserved: number
    readonly consumerDescendants: readonly string[]
    readonly fixturesObserved: number
    readonly launcherObserved: boolean
  }
  /** Why each non-PASSED control is not PASSED. Names and pids only. */
  readonly reasons: readonly string[]
}

function descendants(procs: readonly PebObservedProcess[], roots: readonly number[]): Set<number> {
  const set = new Set(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const p of procs) {
      if (!set.has(p.pid) && set.has(p.ppid)) {
        set.add(p.pid)
        grew = true
      }
    }
  }
  return set
}

const ALL = (n: number): number => (n >= 31 ? -1 : (1 << n) - 1)
const tag = (p: PebObservedProcess): string => `${p.name}(pid ${p.pid}, parent ${p.ppid})`

export function deriveObservationControls(input: ObservationInput): ObservationControls {
  const reasons: string[] = []
  const byPid = new Map(input.processes.map((p) => [p.pid, p]))
  const tree = descendants(input.processes, [input.launcherPid])
  const fixtureTree = descendants(input.processes, input.fixturePids)

  // --- OBS0: the observer is proven able to see every representation ------
  const fixtures = input.fixturePids.map((pid) => byPid.get(pid)).filter((p): p is PebObservedProcess => !!p)
  let OBS0: ControlState
  if (fixtures.length === 0 || input.fixtureCount === 0) {
    OBS0 = 'NOT_RUN'
    reasons.push('OBS0: no positive-control fixture process was observed.')
  } else {
    const cmd = fixtures.reduce((m, p) => m | p.fixCmd, 0)
    const env = fixtures.reduce((m, p) => m | p.fixEnv, 0)
    const want = ALL(input.fixtureCount)
    OBS0 = (cmd & want) === want && (env & want) === want ? 'PASSED' : 'FAILED'
    if (OBS0 === 'FAILED') reasons.push(`OBS0: fixture representations seen in argv mask ${cmd}, env mask ${env}; required ${want} in both.`)
  }
  const blind = OBS0 !== 'PASSED'

  // Subjects: every process in the launcher's tree except the fixtures, which
  // carry fixture material on purpose and are judged by OBS0 alone.
  const subjects = input.processes.filter((p) => tree.has(p.pid) && !fixtureTree.has(p.pid))
  const bridges = subjects.filter((p) => (p.classes & CLASS_BRIDGE) !== 0)
  const launcher = byPid.get(input.launcherPid)
  const delivered = input.deliveredConsumerPids
    .map((pid) => byPid.get(pid))
    .filter((p): p is PebObservedProcess => !!p && p.cmdReadable && p.envReadable)
  const deliveredSet = new Set(delivered.map((p) => p.pid))
  const consumerDesc = descendants(input.processes, delivered.map((p) => p.pid))
  const consumerDescendants = input.processes.filter((p) => consumerDesc.has(p.pid) && !deliveredSet.has(p.pid))

  // --- NP10: no governed representation in ANY command line of the tree ---
  let NP10: ControlState
  if (blind) {
    NP10 = 'NOT_RUN'
  } else if (subjects.length === 0) {
    NP10 = 'NOT_RUN'
    reasons.push('NP10: the observer saw no process in the launcher tree.')
  } else {
    const unreadable = subjects.filter((p) => !p.cmdReadable)
    const hits = subjects.filter((p) => p.govCmd !== 0)
    NP10 = unreadable.length === 0 && hits.length === 0 ? 'PASSED' : 'FAILED'
    for (const p of unreadable) reasons.push(`NP10: command line of ${tag(p)} could not be read.`)
    for (const p of hits) reasons.push(`NP10: governed representation mask ${p.govCmd} in the command line of ${tag(p)}.`)
  }

  // --- RC3: the three named subject classes were observed, and are clean ---
  let RC3: ControlState
  if (blind) {
    RC3 = 'NOT_RUN'
  } else if (bridges.length < input.minBridgeSubjects || delivered.length === 0 || !launcher?.cmdReadable) {
    RC3 = 'NOT_RUN'
    reasons.push(
      `RC3: subjects observed — bridge ${bridges.length} (need ${input.minBridgeSubjects}), ` +
        `delivered consumer ${delivered.length} (need 1), launcher ${launcher?.cmdReadable === true}.`
    )
  } else {
    const named = [...bridges, ...delivered, launcher]
    const hits = named.filter((p) => p.govCmd !== 0)
    RC3 = hits.length === 0 ? 'PASSED' : 'FAILED'
    for (const p of hits) reasons.push(`RC3: governed representation mask ${p.govCmd} in the command line of ${tag(p)}.`)
  }

  // --- RC7: the value is in the delivered consumer's block and NOWHERE else ---
  let RC7: ControlState
  if (blind) {
    RC7 = 'NOT_RUN'
  } else if (delivered.length === 0) {
    RC7 = 'NOT_RUN'
    reasons.push('RC7: no delivered consumer was observed with a readable environment block.')
  } else {
    const failures: string[] = []
    // Capability of TRUE in the very scope the value was set in: each delivered
    // consumer's own block must show the variable, or the reader proves nothing.
    for (const c of delivered) {
      if (!c.envVar) failures.push(`RC7: delivered consumer ${tag(c)} did not show the variable in its own block.`)
    }
    for (const d of consumerDescendants) {
      if (!d.envReadable) failures.push(`RC7: environment block of consumer descendant ${tag(d)} could not be read.`)
      else if (d.envVar || d.govEnv !== 0) failures.push(`RC7: consumer descendant ${tag(d)} CARRIES the delivered variable or value.`)
    }
    for (const p of subjects) {
      if (deliveredSet.has(p.pid) || consumerDesc.has(p.pid)) continue
      if (p.envVar || p.govEnv !== 0) failures.push(`RC7: ${tag(p)} is not the delivered consumer and carries the variable or value.`)
    }
    if (launcher !== undefined && (launcher.envVar || launcher.govEnv !== 0)) {
      failures.push('RC7: the launcher itself carried the variable or value in its own environment block.')
    }
    RC7 = failures.length === 0 ? 'PASSED' : 'FAILED'
    reasons.push(...failures)
  }

  return {
    OBS0,
    NP10,
    RC3,
    RC7,
    subjects: {
      treeSize: subjects.length,
      bridges: bridges.length,
      deliveredConsumersObserved: delivered.length,
      consumerDescendants: consumerDescendants.map(tag),
      fixturesObserved: fixtures.length,
      launcherObserved: launcher?.cmdReadable === true,
    },
    reasons,
  }
}
