// scripts/custody/d1-n09-valid-until.ts
//
// DAG NODE N09, AS A PURE FUNCTION, PREPARED BEFORE ITS OPERAND EXISTS.
//
// N09's act: "Compute planned FINAL WITNESS + 24 hours as an EXACT UTC
// instant", exit condition "one exact UTC instant, expressed in UTC and not in
// a local Windows time zone". The operand is N08's owner-supplied planned
// FINAL WITNESS timestamp, which does not exist yet. Nothing here computes a
// timestamp for any real instant; it makes the arithmetic mechanical, so that
// when N08 arrives nobody does it by hand.
//
// It also checks the one relationship the owner stated for the planned
// removal instant (N31): it is INDEPENDENT of the expiry and never set equal to
// it by assumption, it is not earlier than the planned FINAL WITNESS (N31's own
// exit condition), and if it would fall after the expiry, the expiry is the
// hard outer bound and the removal must occur no later than it.

/** OD-3, ratified: VALID_UNTIL = planned FINAL WITNESS + 24 hours. */
export const VALID_UNTIL_OFFSET_MS = 24 * 60 * 60 * 1000

/**
 * The only accepted input shape: a full ISO-8601 UTC instant with an explicit
 * `Z`, e.g. 2026-09-24T09:30:00Z (seconds and milliseconds optional). A bare
 * date, a local time, or an offset such as +02:00 is refused: the DAG demands
 * UTC, and "a local-time VALID UNTIL is a different instant wearing the same
 * digits".
 */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/

export function parseUtcInstant(label: string, text: string): Date {
  const m = UTC_INSTANT.exec(text)
  if (m === null) {
    throw new Error(
      `${label} must be an exact UTC instant such as 2026-09-24T09:30:00Z; got "${text}". ` +
        'A date alone, a local time or a numeric offset is refused, and no clock time is filled in.'
    )
  }
  const d = new Date(text)
  // Round-trip the calendar fields, so 2026-02-30T00:00Z is refused rather
  // than silently rolled into March.
  const [, y, mo, da, h, mi] = m
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(y) ||
    d.getUTCMonth() + 1 !== Number(mo) ||
    d.getUTCDate() !== Number(da) ||
    d.getUTCHours() !== Number(h) ||
    d.getUTCMinutes() !== Number(mi)
  ) {
    throw new Error(`${label} "${text}" is not a real calendar instant.`)
  }
  return d
}

/** N09: the exact UTC VALID UNTIL for a planned FINAL WITNESS instant. */
export function computeValidUntilUtc(plannedFinalWitnessUtc: string): string {
  const witness = parseUtcInstant('planned FINAL WITNESS (N08)', plannedFinalWitnessUtc)
  return new Date(witness.getTime() + VALID_UNTIL_OFFSET_MS).toISOString()
}

export interface RemovalCheck {
  readonly ok: boolean
  readonly expiryUtc: string
  /** The removal the custody record may carry: the planned instant, bounded by the expiry. */
  readonly mustBeRemovedNoLaterThanUtc: string
  readonly problems: readonly string[]
}

/**
 * N31 against N08 and N09. The planned removal is validated, never adjusted:
 * a planned removal after the expiry is reported, not rewritten, because the
 * owner's planned instant is an owner datum and the expiry is only its bound.
 */
export function checkPlannedRemoval(params: {
  readonly plannedFinalWitnessUtc: string
  readonly plannedRemovalUtc: string
}): RemovalCheck {
  const witness = parseUtcInstant('planned FINAL WITNESS (N08)', params.plannedFinalWitnessUtc)
  const removal = parseUtcInstant('planned removal (N31)', params.plannedRemovalUtc)
  const expiryUtc = computeValidUntilUtc(params.plannedFinalWitnessUtc)
  const expiry = new Date(expiryUtc)
  const problems: string[] = []
  if (removal.getTime() < witness.getTime()) {
    problems.push('The planned removal is EARLIER than the planned FINAL WITNESS; N31 forbids it (OD-1: rotation after the witness).')
  }
  if (removal.getTime() > expiry.getTime()) {
    problems.push(
      'The planned removal is LATER than the expiry. The expiry is the hard outer bound: the removal must occur no later than ' +
        `${expiryUtc}. The owner's planned instant is not rewritten; it must be re-supplied or the expiry accepted as the removal deadline.`
    )
  }
  return {
    ok: problems.length === 0,
    expiryUtc,
    mustBeRemovedNoLaterThanUtc: removal.getTime() <= expiry.getTime() ? removal.toISOString() : expiryUtc,
    problems,
  }
}
