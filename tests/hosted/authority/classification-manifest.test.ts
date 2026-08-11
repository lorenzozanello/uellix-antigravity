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
  RECOVERED_CHAIN_PACKAGE_IDS,
} from '@/db/hosted/authority/classification-manifest'
import { RECOVERED_TOTALS, RECOVERED_WINDOWS } from '@/db/hosted/authority/recovered-boundaries'
import { FORWARD_TOTALS, FORWARD_WINDOWS } from '@/db/hosted/authority/forward-boundaries'
import { isCapabilityRoleName, OWNER_ROLE } from '@/db/hosted/authority/ownership-simulation'

const plan = buildAuthorityPlan()
/**
 * SCOPED TO THE RECOVERED CHAIN, deliberately.
 *
 * The integers below — 8 installer, 167 owner, 99 capability, 27 transfer, 3
 * managed, 16 bookkeeping — were transferred from a partition taken over
 * T1..T9. Once M-8 appended a tenth package there were exactly two ways to keep
 * this file green: edit those integers to match new code, or compare them
 * against the chain they were measured over. The first would turn evidence into
 * a fit, which is the failure `recovered-boundaries.ts` opens by refusing.
 */
const partition = partitionHostedStatements(plan, RECOVERED_CHAIN_PACKAGE_IDS)

const recoveredWindows = plan.windows.filter((w) => w.authoritySource === 'ORIGINAL_STATEFUL_PARTITION')
const authoredWindows = plan.windows.filter((w) => w.authoritySource === 'AUTHORED_FORWARD_REMEDIATION')

const windowsOfClass = (authorityClass: string) =>
  plan.windows.filter((w) => w.authorityClass === authorityClass)
const recoveredOfClass = (authorityClass: string) =>
  recoveredWindows.filter((w) => w.authorityClass === authorityClass)
const segmentsOf = (windowId: string) =>
  plan.segments.filter((s) => s.classificationWindowId === windowId)

/* -------------------------------------------------------------------------- */
/* A / B — the 51, and the 26/15/10                                            */
/* -------------------------------------------------------------------------- */

describe('the recovered classification windows', () => {
  it('are exactly 51, each resolving to one contiguous run of statements', () => {
    // STILL 51. M-8 added a tenth chain package with two AUTHORED windows, and
    // the number on this line did not move — which is the property the split
    // into two files exists to protect. Had they been appended to
    // RECOVERED_WINDOWS, this assertion would have been edited to 53 and the
    // recovered set would have quietly stopped being a transferred measurement.
    expect(RECOVERED_WINDOWS).toHaveLength(51)
    expect(recoveredWindows).toHaveLength(51)
  })

  it('are 26 OWNER, 15 CAPABILITY and 10 OWNER_TRANSFER', () => {
    expect(recoveredOfClass('OWNER')).toHaveLength(RECOVERED_TOTALS.owner)
    expect(recoveredOfClass('CAPABILITY')).toHaveLength(RECOVERED_TOTALS.capability)
    expect(recoveredOfClass('OWNER_TRANSFER')).toHaveLength(RECOVERED_TOTALS.transfer)
  })

  it('carry their provenance, so a reviewer can tell recovered from derived', () => {
    // The point of the marker, exercised in BOTH directions. A test that only
    // asserted the recovered side would pass just as happily if the authored
    // windows were also stamped ORIGINAL_STATEFUL_PARTITION — which is the one
    // mistake that would make the whole distinction decorative.
    for (const window of recoveredWindows) {
      expect(window.authoritySource).toBe('ORIGINAL_STATEFUL_PARTITION')
      expect(window.authorityModelVersion).toBe('A_FINAL_STATEFUL_V1')
    }
    for (const window of authoredWindows) {
      expect(window.authoritySource).toBe('AUTHORED_FORWARD_REMEDIATION')
      expect(window.authorityModelVersion).toBe('FORWARD_AUTHORED_V1')
    }
    expect(recoveredWindows.length + authoredWindows.length).toBe(plan.windows.length)
  })

  it('pin a digest for every statement they govern — none empty, recovered or authored', () => {
    expect(plan.windows).toHaveLength(RECOVERED_WINDOWS.length + FORWARD_WINDOWS.length)
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

describe('OWNER_AUTHORITY_STATEMENTS 167 vs OWNER_WINDOW_EXECUTABLE_STATEMENTS 177', () => {
  // TWO DIFFERENT QUANTITIES, and the whole confusion has been about conflating
  // them:
  //
  //   OWNER_AUTHORITY_STATEMENTS        167  what the recovered A_FINAL canon
  //                                          counted as authority statements
  //   OWNER_WINDOW_EXECUTABLE_STATEMENTS 177  every top-level executable
  //                                          statement between the anchors —
  //                                          the pin, and the stronger one
  //
  // THE ATTRIBUTION HISTORY, because two explanations have already been wrong:
  //
  //   Commit 3   claimed "delta = ten DO blocks".        FALSE.
  //   Commit 3.1 claimed "six DO + four non-DO".         UNPROVEN, and the
  //              bound below shows the split cannot be that way round.
  //
  // WHAT IS MEASURED (Commit 3.2):
  //
  //   window  historical  structural  delta  DO inside  DO that are anchors
  //   W02         33          35        2        1              1
  //   W06         35          40        5        2              1
  //   W16          5           7        2        2              0
  //   W23         21          22        1        1              0
  //                                    ---      ---            ---
  //                                     10        6              2
  //
  // A window's start and end anchors ARE the boundary, so the historical count
  // necessarily includes them and they cannot be additions. Two of the six DO
  // blocks are start anchors (W02's and W06's). Therefore:
  //
  //   DO additions     <= 4
  //   non-DO additions >= 6
  //
  // WHAT IS NOT KNOWN, and why it is not guessed at: the canon that produced
  // the historical integers (`rerun-canon.mjs` / `afinal-canon.mjs`) is not in
  // this repository, and the integers reached it by transcription. An
  // exhaustive search over 27 statement properties and every union of up to
  // three of them found ZERO rules reproducing (2, 5, 2, 1) once anchors are
  // excluded from candidacy. A single integer per window admits many subsets,
  // so naming ten statements here would be a fit, not a finding.
  const EXPECTED = [
    { windowId: 'W02', historical: 33, structural: 35, doInside: 1, doAsAnchor: 1 },
    { windowId: 'W06', historical: 35, structural: 40, doInside: 2, doAsAnchor: 1 },
    { windowId: 'W16', historical: 5, structural: 7, doInside: 2, doAsAnchor: 0 },
    { windowId: 'W23', historical: 21, structural: 22, doInside: 1, doAsAnchor: 0 },
  ]

  const measured = () =>
    plan.windows
      .filter((w) => w.historicalStatementCount !== w.structuralStatementCount)
      .map((w) => {
        const dos = w.members.filter((m) => m.identity.statementClass === 'do-block')
        const first = w.members[0].statement.index
        const last = w.members[w.members.length - 1].statement.index
        return {
          windowId: w.windowId,
          historical: w.historicalStatementCount,
          structural: w.structuralStatementCount,
          doInside: dos.length,
          doAsAnchor: dos.filter((m) => m.statement.index === first || m.statement.index === last)
            .length,
        }
      })

  it('differs in exactly four windows, with exactly these counts', () => {
    expect(measured()).toEqual(EXPECTED)
  })

  it('accounts for the whole difference arithmetically', () => {
    const delta = EXPECTED.reduce((n, m) => n + (m.structural - m.historical), 0)

    expect(delta).toBe(10)
    expect(RECOVERED_TOTALS.ownerStatements).toBe(167)
    expect(partition.counts.owner).toBe(177)
    expect(partition.counts.owner).toBe(RECOVERED_TOTALS.ownerStatements + delta)
  })

  it('bounds the DO share at four, because two of the six DO blocks are anchors', () => {
    // This is the assertion that would have caught the Commit 3.1 narrative,
    // so it is permanent. An anchor is the boundary; it cannot be an addition.
    const rows = measured()
    const doInside = rows.reduce((n, m) => n + m.doInside, 0)
    const doAsAnchor = rows.reduce((n, m) => n + m.doAsAnchor, 0)
    const delta = rows.reduce((n, m) => n + (m.structural - m.historical), 0)

    expect(doInside).toBe(6)
    expect(doAsAnchor).toBe(2)
    expect(doInside - doAsAnchor).toBe(4) // DO additions, upper bound
    expect(delta - (doInside - doAsAnchor)).toBe(6) // non-DO additions, lower bound
  })

  it('records that the historical spans are NOT a canonical/hosted artefact', () => {
    // Category C, eliminated by measurement: resolving the same four boundaries
    // against db/prepared/** gives spans of 35, 40, 7 and 22 — identical to the
    // hosted ones. The delta is not something the RR-09 rewrite introduced.
    expect(measured().map((m) => m.structural)).toEqual([35, 40, 7, 22])
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
    //
    // W52.S1 is M-8's, and it is here for the same reason W44.S1 and W49.S1
    // are: `CREATE OR REPLACE` against a routine the capability role already
    // owns needs CREATE on the containing schema, measured. Its sibling
    // W53.S1 — the COMMENT — is deliberately ABSENT from this list, which is
    // the whole reason grounding_0005 declares two one-statement windows
    // instead of one two-statement window. Merging them would have added
    // W52.S1 here covering both statements and held CREATE on
    // uellix_grounding while a comment was written.
    expect(needing.map((s) => s.segmentId)).toEqual(['W38.S2', 'W44.S1', 'W49.S1', 'W52.S1'])
    expect(new Set(needing.map((s) => s.classificationWindowId))).toEqual(
      new Set(['W38', 'W44', 'W49', 'W52']),
    )
    expect(
      needing.find((s) => s.segmentId === 'W52.S1')?.statementCount,
      "M-8's CREATE segment must cover exactly the one statement that needs CREATE",
    ).toBe(1)
    expect(
      plan.segments.find((s) => s.segmentId === 'W53.S1')?.requiredTemporarySchemaCreate,
      'the COMMENT segment must NOT open CREATE on the schema',
    ).toBeNull()
  })

  it('is needed by every transfer segment, because PostgreSQL checks CREATE against the NEW owner', () => {
    const transfers = plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')

    for (const segment of transfers) {
      expect(segment.requiredTemporarySchemaCreate, segment.segmentId).not.toBeNull()
    }
  })
})
