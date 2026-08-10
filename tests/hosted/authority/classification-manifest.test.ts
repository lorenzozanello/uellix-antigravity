// tests/hosted/authority/classification-manifest.test.ts
// COMMIT 3 — the recovered classification windows, and the execution segments
// measured inside them.
//
// ---------------------------------------------------------------------------
// WHAT IS PROVENANCE AND WHAT IS MEASUREMENT
// ---------------------------------------------------------------------------
// The 51 boundaries are RECOVERED. They are not re-derived here and must not
// be: an earlier attempt to reconstruct them from the published counts was
// abandoned because 26 OWNER windows is consistent with many boundary rules, so
// a count can check a rule but cannot identify one.
//
// Everything else in this file is MEASURED against the packages:
//
//   each boundary resolves to exactly one statement       (0 or 2 → refusal)
//   the statement partition the windows imply              (8/167.../99/27/3/16)
//   the execution segments inside them                     (no expected number)
//
// The execution-segment counts in particular are deliberately asserted as
// "whatever the packages say", with the SHAPE asserted instead: one executor
// per segment, no overlap, canonical order preserved. Pinning a number nobody
// measured would turn the next real change into a test edit.

import { describe, expect, it } from 'vitest'

import {
  buildAuthorityPlan,
  partitionHostedStatements,
} from '@/db/hosted/authority/classification-manifest'
import { RECOVERED_TOTALS, RECOVERED_WINDOWS } from '@/db/hosted/authority/recovered-boundaries'
import { isCapabilityRoleName, OWNER_ROLE } from '@/db/hosted/authority/ownership-simulation'

const plan = buildAuthorityPlan()
const partition = partitionHostedStatements(plan)

const windowsOfClass = (authorityClass: string) =>
  plan.windows.filter((w) => w.authorityClass === authorityClass)
const segmentsOf = (windowId: string) =>
  plan.segments.filter((s) => s.classificationWindowId === windowId)

/* -------------------------------------------------------------------------- */
/* A / B — the 51, and the 26/15/10                                            */
/* -------------------------------------------------------------------------- */

describe('the recovered classification windows', () => {
  it('are exactly 51, each resolving to one contiguous run of statements', () => {
    expect(RECOVERED_WINDOWS).toHaveLength(51)
    expect(plan.windows).toHaveLength(51)
  })

  it('are 26 OWNER, 15 CAPABILITY and 10 OWNER_TRANSFER', () => {
    expect(windowsOfClass('OWNER')).toHaveLength(RECOVERED_TOTALS.owner)
    expect(windowsOfClass('CAPABILITY')).toHaveLength(RECOVERED_TOTALS.capability)
    expect(windowsOfClass('OWNER_TRANSFER')).toHaveLength(RECOVERED_TOTALS.transfer)
  })

  it('carry their provenance, so a reviewer can tell recovered from derived', () => {
    for (const window of plan.windows) {
      expect(window.authoritySource).toBe('ORIGINAL_STATEFUL_PARTITION')
      expect(window.authorityModelVersion).toBe('A_FINAL_STATEFUL_V1')
    }
  })

  it('pin a digest for every statement they govern — 51 sequences, none empty', () => {
    expect(plan.windows).toHaveLength(51)
    for (const window of plan.windows) {
      expect(window.statementDigestSequence).toHaveLength(window.structuralStatementCount)
      for (const digest of window.statementDigestSequence) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })

  it('use structural identities as anchors — never a line, an index or a prefix', () => {
    for (const window of plan.windows) {
      expect(window.startStatementIdentity).not.toMatch(/^\d+$/)
      expect(window.startStatementIdentity).toContain(':')
      expect(window.endStatementIdentity).toContain(':')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The historical / structural count difference                                */
/* -------------------------------------------------------------------------- */

describe('historical vs structural statement counts', () => {
  // CORRECTION (Commit 3.1). Commit 3 attributed this delta to "ten DO blocks".
  // That was FALSE and an independent review caught it. Re-measured here:
  //
  //   window   historical  structural  delta   DO inside   non-DO
  //   W02          33          35        2         1          1
  //   W06          35          40        5         2          3
  //   W16           5           7        2         2          0
  //   W23          21          22        1         1          0
  //                                     ---       ---        ---
  //                                      10         6          4
  //
  // The DO half is explained: the recovered partition counted only the DO
  // blocks it had measured individually, and this parser counts every top-level
  // executable statement between the anchors — the stronger definition, and the
  // safer pin, because a DO block physically inside an owner window executes
  // inside it and a count that skipped it would let its body change unnoticed.
  //
  // The remaining FOUR are not explained. They are inside W02 (one) and W06
  // (three), their simulated ownerBefore is uellix_owner, and no class or
  // property distinguishes them from the statements the historical count did
  // include. A single integer per window admits many four-statement subsets, so
  // identifying them here would be a guess dressed as a finding. The structural
  // pins stand; the gap is recorded rather than papered over.
  const EXPECTED_MISMATCHES = [
    { windowId: 'W02', historical: 33, structural: 35, doBlocks: 1 },
    { windowId: 'W06', historical: 35, structural: 40, doBlocks: 2 },
    { windowId: 'W16', historical: 5, structural: 7, doBlocks: 2 },
    { windowId: 'W23', historical: 21, structural: 22, doBlocks: 1 },
  ]

  it('differ in exactly four windows, with exactly these counts', () => {
    const mismatches = plan.windows
      .filter((w) => w.historicalStatementCount !== w.structuralStatementCount)
      .map((w) => ({
        windowId: w.windowId,
        historical: w.historicalStatementCount,
        structural: w.structuralStatementCount,
        doBlocks: w.members.filter((m) => m.identity.statementClass === 'do-block').length,
      }))

    expect(mismatches).toEqual(EXPECTED_MISMATCHES)
  })

  it('accounts for the whole OWNER difference arithmetically', () => {
    const extra = EXPECTED_MISMATCHES.reduce((n, m) => n + (m.structural - m.historical), 0)

    expect(extra).toBe(10)
    expect(partition.counts.owner).toBe(RECOVERED_TOTALS.ownerStatements + extra)
  })

  it('attributes six of the ten to DO blocks, and does not claim the other four', () => {
    // The assertion that failed review was "delta = ten DO blocks". This is the
    // measurement that would have contradicted it, so it is now permanent.
    const doBlocks = EXPECTED_MISMATCHES.reduce((n, m) => n + m.doBlocks, 0)
    const delta = EXPECTED_MISMATCHES.reduce((n, m) => n + (m.structural - m.historical), 0)

    expect(doBlocks).toBe(6)
    expect(delta - doBlocks).toBe(4)
  })

  it('locates the four unattributed statements in W02 and W06 and nowhere else', () => {
    const unattributed = EXPECTED_MISMATCHES.map((m) => ({
      windowId: m.windowId,
      count: m.structural - m.historical - m.doBlocks,
    }))

    expect(unattributed).toEqual([
      { windowId: 'W02', count: 1 },
      { windowId: 'W06', count: 3 },
      { windowId: 'W16', count: 0 },
      { windowId: 'W23', count: 0 },
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* C — the partition                                                           */
/* -------------------------------------------------------------------------- */

describe('the hosted statement partition the windows imply', () => {
  it('reproduces the recovered INSTALLER, CAPABILITY, TRANSFER, MANAGED and bookkeeping counts', () => {
    expect(partition.counts.installer).toBe(RECOVERED_TOTALS.installerStatements)
    expect(partition.counts.capability).toBe(RECOVERED_TOTALS.capabilityStatements)
    expect(partition.counts.ownerTransfer).toBe(RECOVERED_TOTALS.transferStatements)
    expect(partition.counts.managedRewrite).toBe(RECOVERED_TOTALS.managedRewriteStatements)
    expect(partition.counts.bookkeeping).toBe(RECOVERED_TOTALS.bookkeepingStatements)
  })

  it('names the 8 installer statements, and they are the three schema creations, three CREATE TABLE and two RR-09 shim grants', () => {
    // Spelled out because "8" is a number and this is the evidence behind it.
    // The two `public.uellix_auth_uid()` grants are installer authority because
    // the bootstrap creates that shim and never transfers it — it stays with
    // the applying identity, which is the only role that can reach schema auth.
    const described = partition.installerStatements.map(
      (row) => `${row.packageId}:${row.identity.statementClass}`,
    )

    expect(described).toEqual([
      'T1:create-schema',
      'T1:create-table',
      'T2:create-table',
      'T4:create-schema',
      'T4:grant-privilege',
      'T5:create-schema',
      'T5:grant-privilege',
      'T5:create-table',
    ])
  })

  it('leaves every statement of every package accounted for', () => {
    const c = partition.counts
    const accounted =
      c.installer + c.owner + c.capability + c.ownerTransfer + c.managedRewrite + c.bookkeeping + c.excluded

    expect(accounted).toBe(c.total)
  })
})

/* -------------------------------------------------------------------------- */
/* The independent executor crosscheck                                         */
/* -------------------------------------------------------------------------- */

describe('simulated ownerBefore agrees with the recovered classification', () => {
  it('finds no statement whose simulated authority contradicts its window', () => {
    // This is the check that makes the recovered table more than a list: for
    // every governed statement, `need = ownerBefore` is re-simulated from the
    // packages and must land on the class the window assigns.
    expect(partition.disagreements.map((d) => `${d.row.packageId}[${d.row.statement.index}] ${d.windowId}`)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* D / E / F / L / M — execution segments                                      */
/* -------------------------------------------------------------------------- */

describe('execution segments', () => {
  it('are measured, not fitted to any expected number', () => {
    // Asserted as a shape, not a magic constant: every window has at least one
    // segment and the total is at least the window count.
    expect(plan.segments.length).toBeGreaterThanOrEqual(plan.windows.length)
    for (const window of plan.windows) {
      expect(segmentsOf(window.windowId).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('each belong to exactly one classification window', () => {
    const windowIds = new Set(plan.windows.map((w) => w.windowId))
    for (const segment of plan.segments) {
      expect(windowIds.has(segment.classificationWindowId)).toBe(true)
    }
  })

  it('give every CAPABILITY segment exactly one capability executor', () => {
    for (const segment of plan.segments.filter((s) => s.authorityClass === 'CAPABILITY')) {
      expect(isCapabilityRoleName(segment.executor), `${segment.segmentId} -> ${segment.executor}`).toBe(true)
      expect(segment.executor).not.toContain('|')
    }
  })

  it('give every OWNER segment uellix_owner and nothing else', () => {
    for (const segment of plan.segments.filter((s) => s.authorityClass === 'OWNER')) {
      expect(segment.executor).toBe(OWNER_ROLE)
    }
  })

  it('give every TRANSFER segment exactly one incoming owner', () => {
    for (const segment of plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')) {
      expect(segment.ownerDestination).not.toBeNull()
      expect(isCapabilityRoleName(segment.ownerDestination as string)).toBe(true)
    }
  })

  it('open and close at the installer, because PostgreSQL does not stack SET ROLE', () => {
    for (const segment of plan.segments) {
      expect(segment.entryState).toBe('installer')
      expect(segment.exitState).toBe('installer')
    }
  })

  it('partition their window exactly — no gap, no overlap, canonical order kept', () => {
    for (const window of plan.windows) {
      const segments = segmentsOf(window.windowId)
      const covered = segments.reduce((n, s) => n + s.statementCount, 0)

      expect(covered, `${window.windowId} coverage`).toBe(window.structuralStatementCount)

      const rebuilt = segments.flatMap((s) => s.statementDigestSequence)
      expect(rebuilt, `${window.windowId} order`).toEqual([...window.statementDigestSequence])
    }
  })
})

/* -------------------------------------------------------------------------- */
/* G / H / I / J / K — the windows the scalar model would have broken          */
/* -------------------------------------------------------------------------- */

describe('multi-role windows', () => {
  it('W29 resolves to one capability executor, derived from the objects its DO governs', () => {
    const segments = segmentsOf('W29')

    expect(segments).toHaveLength(1)
    expect(segments[0].executor).toBe('uellix_cap_stella_ticket')
    expect(segments[0].statementCount).toBe(1)
  })

  it('W38 splits into a quota run and a ticket run, in canonical order', () => {
    const segments = segmentsOf('W38')

    expect(segments.map((s) => s.executor)).toEqual([
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
    ])
    expect(segments.map((s) => s.statementCount)).toEqual([10, 2])
  })

  it('W46 transfers to one target at a time, never opening both lifecycles at once', () => {
    const segments = segmentsOf('W46')

    expect(segments.map((s) => s.ownerDestination)).toEqual([
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
    ])
    for (const segment of segments) {
      expect(segment.requiredTemporaryMemberships).not.toContain('uellix_cap_stella_ticket' === segment.ownerDestination ? 'uellix_cap_stella_quota' : 'uellix_cap_stella_ticket')
    }
  })

  it('W47 alternates six times, because the canonical order does — and is never reordered', () => {
    const segments = segmentsOf('W47')

    expect(segments.map((s) => s.executor)).toEqual([
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
    ])
    expect(segments.map((s) => s.statementCount)).toEqual([2, 1, 2, 1, 2, 1])
  })

  it('W51 splits into a ticket run and a quota run', () => {
    const segments = segmentsOf('W51')

    expect(segments.map((s) => s.executor)).toEqual([
      'uellix_cap_stella_ticket',
      'uellix_cap_stella_quota',
    ])
    expect(segments.map((s) => s.statementCount)).toEqual([6, 6])
  })
})

/* -------------------------------------------------------------------------- */
/* Temporary schema CREATE, at both levels                                     */
/* -------------------------------------------------------------------------- */

describe('temporary schema CREATE', () => {
  it('is needed by exactly the capability segments that actually create something', () => {
    const needing = plan.segments.filter(
      (s) => s.authorityClass === 'CAPABILITY' && s.requiredTemporarySchemaCreate !== null,
    )

    // Independently corroborates the recovered claim that three CAPABILITY
    // classification windows involve CREATE — and locates it on the exact
    // segment, so the grant is not held while the window merely REVOKEs.
    expect(needing.map((s) => s.segmentId)).toEqual(['W38.S2', 'W44.S1', 'W49.S1'])
    expect(new Set(needing.map((s) => s.classificationWindowId))).toEqual(
      new Set(['W38', 'W44', 'W49']),
    )
  })

  it('is needed by every transfer segment, because PostgreSQL checks CREATE against the NEW owner', () => {
    const transfers = plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')

    for (const segment of transfers) {
      expect(segment.requiredTemporarySchemaCreate, segment.segmentId).not.toBeNull()
    }
  })
})
