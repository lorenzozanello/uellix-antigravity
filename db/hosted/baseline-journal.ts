// db/hosted/baseline-journal.ts
// TRAIN 5C2 — Phase F. RR-25: where `baselineUnitsInstalled` comes from.
//
// ---------------------------------------------------------------------------
// THE DEFECT
// ---------------------------------------------------------------------------
// Locally, `pnpm db:migrate:local` runs drizzle's migrator, which writes
// `drizzle.__drizzle_migrations`. Hosted, the plan is `psql -1 -f` per unit,
// which writes nothing. `TargetStateProbe.baselineUnitsInstalled` is documented
// as "as recorded by the operator's ledger" — and no ledger exists, so the
// anti-skip check of PHASE_STELLA_BOOTSTRAP reads a list somebody typed.
//
// ---------------------------------------------------------------------------
// THE ATOMICITY QUESTION, ANSWERED HONESTLY AND SEPARATELY PER CHANNEL
// ---------------------------------------------------------------------------
// The instruction was explicit: do not claim "written only after commit" if the
// row cannot technically be part of the same transaction. It cannot be, in
// general — "after commit" describes two transactions, and a crash between them
// leaves a unit applied and unrecorded. So the design does not claim it. There
// are two channels and they get two different guarantees.
//
//   PSQL UNITS (49 of 50, plus PART A of unit 41)
//   `psql -1 -f` wraps the WHOLE FILE in one transaction. The generator appends
//   the journal INSERT to the derived artefact, so the row and the unit's
//   effects commit or roll back TOGETHER. This is real atomicity, not a
//   sequence: a crash at any point leaves both or neither. There is no window.
//
//   THE MANAGED CHANNEL (PART B of unit 41)
//   Runs through a platform surface we do not control and cannot join a
//   transaction with. So PART B is NEVER journalled by the channel. Its state is
//   RECONSTRUCTED from the catalogue — `pg_policies` — by the same postcondition
//   that verifies it. A fact derived from the catalogue cannot be out of step
//   with the catalogue, which is a stronger property than a row written next to
//   it.
//
// ---------------------------------------------------------------------------
// AND THE JOURNAL IS NOT TRUSTED ON ITS OWN
// ---------------------------------------------------------------------------
// A journal living in the database it describes can be forged by anyone who can
// write to that database. Pretending otherwise would be the "self-asserted
// boolean" this programme keeps finding. The property actually available is
// weaker and sufficient: THE JOURNAL CANNOT SILENTLY DISAGREE WITH THE CATALOGUE.
// `reconcileJournal` compares every APPLIED claim against independently observed
// state, and a claim with no corresponding objects is a refusal — so fabricating
// a row does not buy an attacker a skipped unit, it buys them a failed gate.

import { BASELINE_ORDER, BASELINE_UNITS, baselineUnit } from './baseline-manifest'

/** Schema and table the journal lives in. Created by the journal bootstrap unit. */
export const JOURNAL_SCHEMA = 'uellix_provisioning'
export const JOURNAL_TABLE = `${JOURNAL_SCHEMA}.applied_units`

/**
 * The four statuses the ledger's CHECK constraint admits.
 *
 * `FAILED` is reachable only by the boundary reconciler: a wrapper cannot write
 * it, because a failed unit rolls its own row back. The two MANUAL_BOUNDARY
 * values belong to unit 41 PART B, the one step no psql transaction can cover.
 */
export type JournalStatus =
  | 'APPLIED'
  | 'FAILED'
  | 'MANUAL_BOUNDARY_PENDING'
  | 'MANUAL_BOUNDARY_VERIFIED'

/** One row. Every column is something a later reader genuinely needs. */
export interface JournalRow {
  readonly environment: string
  readonly projectRef: string
  readonly packageId: string
  readonly phase: string
  readonly sourceSha256: string
  /** Present when the unit was applied from a derived artefact. */
  readonly derivedSha256: string | null
  /** Present when the unit carries policies or definers. */
  readonly securitySurfaceDigest: string | null
  readonly status: JournalStatus
  readonly appliedAt: string
  /** `current_user`/`session_user` of the session that applied it. */
  readonly applySessionIdentity: string
}

/*
 * THE DDL AND THE INSERT USED TO LIVE HERE, AND THEY WERE DELETED.
 *
 * `journalBootstrapSql()` and `journalInsertSql()` were exported from this file
 * by Train 5C1 and never called by anything. Train 5C2 implemented the ledger in
 * `baseline-journal-wrapper.ts`, and adversarial review then found the two
 * spellings had already DIVERGED — the dead one allowed two statuses and carried
 * no production veto, while the one actually written to
 * `db/prepared/journal/000_journal_bootstrap.sql` allows four and refuses a row
 * naming production from inside the unit's transaction.
 *
 * A second spelling of the same DDL is worse than none: anyone reading the dead
 * one as documentation of "the schema" would come away with a materially weaker
 * table than the one on disk. So they are gone rather than deprecated. The
 * schema is defined in exactly one place, and `pnpm journal:verify` proves the
 * bytes on disk are that place's output.
 *
 * What remains in this file is the part that has no second spelling: the row
 * TYPE, and `reconcileJournal` — the function that makes a journal safe to
 * consume by refusing to believe it without the catalogue.
 */

export type ReconcileProblem = {
  readonly kind:
    | 'JOURNAL_CLAIMS_UNKNOWN_UNIT'
    | 'JOURNAL_SHA_MISMATCH'
    | 'JOURNAL_WRONG_PROJECT'
    | 'JOURNAL_WRONG_ENVIRONMENT'
    | 'JOURNAL_DUPLICATE_APPLIED'
    | 'JOURNAL_CONTRADICTS_CATALOG'
    | 'JOURNAL_MISSING_UNIT'
  readonly detail: string
}

/**
 * Turns journal rows into `baselineUnitsInstalled`, or refuses.
 *
 * This is the function that makes the journal safe to consume, and every check
 * in it exists because the journal alone is not trustworthy:
 *
 *   - a row naming a unit the manifest does not have is a fabricated row;
 *   - a row whose sha does not match the manifest is a row about a DIFFERENT
 *     version of that unit, which is worse than no row;
 *   - a row naming another project is a journal copied from somewhere else;
 *   - and the catalogue check is the one that matters: a unit claimed APPLIED
 *     whose objects are not there did not apply, whatever the row says.
 */
export function reconcileJournal(input: {
  readonly rows: readonly JournalRow[]
  readonly expectedProjectRef: string
  /**
   * Independently observed. `null` = not measured, and unmeasured means the
   * catalogue cross-check cannot run, which is itself a refusal.
   */
  readonly observedTables: readonly string[] | null
  /**
   * Tables each unit creates, derived from the corpus by the caller (the
   * scanner already produces this). Supplied rather than imported so the
   * cross-check measures the SAME corpus the plan was built from.
   */
  readonly tablesCreatedByUnit?: Readonly<Record<string, readonly string[]>>
}): { readonly installed: readonly string[]; readonly problems: readonly ReconcileProblem[] } {
  const problems: ReconcileProblem[] = []
  const applied = input.rows.filter((r) => r.status === 'APPLIED')

  const seen = new Set<string>()
  for (const row of applied) {
    if (row.projectRef !== input.expectedProjectRef) {
      problems.push({
        kind: 'JOURNAL_WRONG_PROJECT',
        detail: `a row names project ${row.projectRef}, the target is ${input.expectedProjectRef}. A journal copied from another database describes another database.`,
      })
      continue
    }
    if (row.environment !== 'staging') {
      problems.push({ kind: 'JOURNAL_WRONG_ENVIRONMENT', detail: `a row declares environment ${row.environment}.` })
      continue
    }
    if (seen.has(row.packageId)) {
      problems.push({
        kind: 'JOURNAL_DUPLICATE_APPLIED',
        detail: `${row.packageId} is recorded APPLIED twice. 28 of the 40 Drizzle units cannot survive a second application, so two rows describe a state the manifest says cannot exist.`,
      })
      continue
    }
    seen.add(row.packageId)

    let unit
    try {
      unit = baselineUnit(row.packageId)
    } catch {
      problems.push({
        kind: 'JOURNAL_CLAIMS_UNKNOWN_UNIT',
        detail: `${row.packageId} is not a unit of the manifest. Either the journal was written by something else, or a unit was removed without the journal noticing.`,
      })
      continue
    }
    if (row.sourceSha256 !== unit.sha256) {
      problems.push({
        kind: 'JOURNAL_SHA_MISMATCH',
        detail: `${row.packageId} was applied from ${row.sourceSha256.slice(0, 12)}…, the manifest pins ${unit.sha256.slice(0, 12)}…. The database holds a different version of this unit than the repository describes.`,
      })
    }
  }

  // THE CATALOGUE CROSS-CHECK. Without it the journal is a claim about itself.
  if (input.observedTables === null) {
    problems.push({
      kind: 'JOURNAL_CONTRADICTS_CATALOG',
      detail:
        'no catalogue observation supplied, so no APPLIED claim could be cross-checked. A journal read ' +
        'without the catalogue is a self-attestation, which is the defect this journal exists to remove.',
    })
  } else {
    const observed = new Set(input.observedTables)
    // Generic, derived from the corpus by the caller rather than a hand-picked
    // case: for every unit claimed APPLIED that CREATES tables, at least one of
    // its tables must exist. A fabricated row for a table-creating unit is the
    // cheap high-value forgery, and this is what makes it not work.
    for (const packageId of seen) {
      const creates = input.tablesCreatedByUnit?.[packageId] ?? []
      if (creates.length === 0) continue
      const absent = creates.filter((t) => !observed.has(t))
      if (absent.length === creates.length) {
        problems.push({
          kind: 'JOURNAL_CONTRADICTS_CATALOG',
          detail: `${packageId} is recorded APPLIED but none of the ${creates.length} table(s) it creates exists (${creates.slice(0, 3).join(', ')}). The row is not describing this database.`,
        })
      } else if (absent.length > 0) {
        problems.push({
          kind: 'JOURNAL_CONTRADICTS_CATALOG',
          detail: `${packageId} is recorded APPLIED but ${absent.length} of its tables are missing: ${absent.slice(0, 3).join(', ')}. Under psql -1 a unit is all-or-nothing, so a partial result means the row is wrong or something else dropped the objects.`,
        })
      }
    }
  }

  const installed = BASELINE_ORDER.filter((id) => seen.has(id))
  const missing = BASELINE_ORDER.filter((id) => !seen.has(id))
  if (missing.length > 0 && installed.length > 0) {
    problems.push({
      kind: 'JOURNAL_MISSING_UNIT',
      detail: `${missing.length} unit(s) have no APPLIED row, starting with ${missing[0]}. A partial baseline is not a smaller baseline.`,
    })
  }

  return { installed, problems }
}
