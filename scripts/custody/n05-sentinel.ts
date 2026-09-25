// scripts/custody/n05-sentinel.ts
//
// SENT-DAG-1, AS A GENERATOR. NEVER AS A VALUE.
//
// This file is deliberately NOT under `db/`. The custody mechanism is
// production code; the sentinel is demonstration scaffolding, and keeping the
// two apart is what makes "no test value in production source" checkable by
// looking at a directory rather than by reading every line.
//
// No sentinel value is stored here. `generateSentinel()` produces a fresh one
// per call from `crypto.randomBytes`, which is SENT-DAG-1's own "freshly
// generated per demonstration run" property: a match found after a later run
// cannot be confused with a stale leak from an earlier one.
//
// ===========================================================================
// A DECLARED CONFLICT BETWEEN THE LANE MANDATE AND THE CERTIFIED AUTHORITY
// ===========================================================================
// The lane mandate for CV1-D1-AUDITOR-CUSTODY-REALIZATION-R1 says a valid
// sentinel "must not resemble a DSN/password/token".
//
// The certified N05 readiness authority says the opposite, in terms, at
// SENTINEL_CONTRACT.derived_properties_this_artifact_adds:
//
//   SP-1  "SHAPED LIKE THE REAL VALUE, which is a connection string carrying
//          userinfo. A sentinel of a different shape would leave the WCM-C2
//          command-line search and the WCM-C5 absence check searching for a
//          pattern the real value does not have, which is a check that cannot
//          fail for the right reason."
//
//   SP-4  "IT MUST NOT BE SUPPRESSED BY THE REPOSITORY SECRET SCANNER. It must
//          carry NO fixture marker in its own body and its password component
//          must be at least six characters."
//
// These cannot both be honoured. The repository's own source-of-truth
// hierarchy puts certified repository authority above conversation context, so
// THIS FILE IMPLEMENTS SP-1 AND SP-4 AND DEPARTS FROM THE MANDATE'S PHRASING.
// The departure is narrow, deliberate and disclosed rather than guessed:
//
//   honoured from the mandate   The sentinel is unmistakably non-production to
//                               a human reader. Its host is under `.invalid`,
//                               which RFC 6761 guarantees can never resolve,
//                               and its entry lives under a reserved target
//                               prefix that names the demonstration.
//
//   departed from              "must not resemble a DSN". It must, and does,
//                               resemble one — because the WCM-C2 and WCM-C5
//                               searches hunt the shape the REAL value has,
//                               and a stand-in of a different shape makes both
//                               searches unable to fail for the right reason.
//
// The non-production markers are placed in the USERNAME and HOST, never in the
// PASSWORD component, because `scripts/scan-secrets.ts` tests only the
// password against `isUnmistakablePlaceholder`. A marker in the password is
// exactly mutant NM12 of the N05 test manifest: it makes the repository's own
// leak gate stop seeing the sentinel, which is the one divergence from the
// real value that runs in the unsafe direction.
//
// This is an OWNER DECISION POINT, not a technical one, and it is reported as
// such rather than resolved here.

import { randomBytes } from 'node:crypto'
import { isUnmistakablePlaceholder } from '../scan-secrets'
import { SWEEPABLE_TARGET_PREFIXES } from '../../db/custody/wcm-credential-store'

/**
 * The reserved Credential Manager namespace for this demonstration.
 *
 * Every entry the harness creates begins with it, and `sweepCredentials` in
 * the mechanism REFUSES any prefix outside `SWEEPABLE_TARGET_PREFIXES`, of
 * which this is the only member. That refusal, not this comment, is what
 * bounds the blast radius of a sweep to entries this demonstration created.
 */
export const SENTINEL_TARGET_PREFIX: string = SWEEPABLE_TARGET_PREFIXES[0]

/**
 * The environment variable the real consumer reads, carried verbatim from
 * `db/safety/resolve-capability-database-url.ts`.
 *
 * The demonstration uses the REAL name against the REAL consumer. A
 * demonstration against a name nothing reads would prove delivery into a
 * variable no consumer consults, which is ES-3's whole point about there being
 * exactly one delivery target.
 */
export const AUDITOR_ENV_VAR_NAME = 'UELLIX_AUDITOR_DATABASE_URL'

/**
 * The login role the auditor consumer requires. NON-SECRET: it is a role name
 * that appears in this repository in a dozen places, and the consumer refuses
 * a DSN that does not declare it.
 */
const AUDITOR_ROLE = 'uellix_auditor'

/**
 * A host that can never resolve. RFC 6761 reserves `.invalid` for exactly
 * this: guaranteed non-resolution, by specification rather than by luck.
 */
const UNRESOLVABLE_HOST = 'n05-sentinel.invalid'

/** 32 characters of base62. Well past the scanner's six-character floor. */
const PASSWORD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const PASSWORD_LENGTH = 32

export interface Sentinel {
  /** The value. Held as a Buffer so the harness can zero it. */
  readonly value: Buffer
  /** The Credential Manager entry name. NON-SECRET. */
  readonly target: string
  /** The username stored beside the value. NON-SECRET. */
  readonly username: string
}

function randomPassword(): string {
  // Rejection sampling on the byte, so the distribution over the 62 characters
  // is uniform. Modulo on 256 would skew the first 8 characters upward, which
  // matters less here than it would for a real key but costs nothing to avoid.
  const out: string[] = []
  while (out.length < PASSWORD_LENGTH) {
    for (const byte of randomBytes(PASSWORD_LENGTH)) {
      if (byte >= 248) continue
      out.push(PASSWORD_CHARS[byte % 62]!)
      if (out.length === PASSWORD_LENGTH) break
    }
  }
  return out.join('')
}

/**
 * Generate a fresh sentinel.
 *
 * The loop is not decoration. A random base62 run can contain `fake`, `dummy`
 * or `sample` by chance, and `isUnmistakablePlaceholder` would then suppress
 * the scanner finding — mutant NM12 arriving by accident rather than by
 * design, in maybe one run in a hundred thousand, presenting as a broken gate.
 * The generator asks the scanner's OWN predicate and regenerates rather than
 * leaving that to probability.
 */
export function generateSentinel(): Sentinel {
  let password = randomPassword()
  let guard = 0
  while (isUnmistakablePlaceholder(password)) {
    if (++guard > 64) {
      throw new Error(
        'Could not generate a sentinel password the secret scanner will see. ' +
          'This should be impossible; investigate isUnmistakablePlaceholder before proceeding.'
      )
    }
    password = randomPassword()
  }

  const suffix = randomBytes(6).toString('hex').toUpperCase()
  const value = `postgresql://${AUDITOR_ROLE}:${password}@${UNRESOLVABLE_HOST}:5432/n05_sentinel`

  return {
    value: Buffer.from(value, 'utf8'),
    target: `${SENTINEL_TARGET_PREFIX}-${suffix}`,
    username: AUDITOR_ROLE,
  }
}

/**
 * The properties a certifier can check without ever seeing a sentinel.
 *
 * Returned as data rather than asserted in place, so a control can exercise
 * the predicate on a deliberately malformed sentinel and watch it fail.
 */
export function describeSentinelConformance(value: string): {
  readonly dsnShaped: boolean
  readonly carriesUserinfo: boolean
  readonly passwordAtLeastSixChars: boolean
  readonly passwordCarriesNoFixtureMarker: boolean
  readonly hostIsUnresolvable: boolean
} {
  const match = /^postgres(?:ql)?:\/\/([^:@/]+):([^@/]+)@([^/:?]+)/.exec(value)
  const password = match?.[2] ?? ''
  const host = match?.[3] ?? ''
  return {
    dsnShaped: match !== null,
    carriesUserinfo: (match?.[1]?.length ?? 0) > 0 && password.length > 0,
    passwordAtLeastSixChars: password.length >= 6,
    passwordCarriesNoFixtureMarker: password.length > 0 && !isUnmistakablePlaceholder(password),
    hostIsUnresolvable: host.endsWith('.invalid'),
  }
}
