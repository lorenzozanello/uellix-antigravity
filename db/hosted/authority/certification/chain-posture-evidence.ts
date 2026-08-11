// db/hosted/authority/certification/chain-posture-evidence.ts
// F-PI-01 — the OPERATOR ROUTE to the posture the engine certification already
// measures, so the same six evaluators can be run over a document measured on
// the REMOTE project instead of inside a container.
//
// ---------------------------------------------------------------------------
// WHAT WAS MISSING, AND WHAT DELIBERATELY WAS NOT
// ---------------------------------------------------------------------------
// The probe was never the gap. `buildChainPostureSql` exists, is read-only,
// opens with `SET search_path = ''` and measures exactly the fields the
// post-install gate leaves PENDING: ownership, canonical owner contexts, role
// topology, capability reachability, RLS, SECURITY DEFINER / search_path and
// the per-schema CREATE residual. What did not exist was a way for a human to
// RUN it: the only caller was `scripts/remediation-certify.ts`, through
// `docker exec`, against a container.
//
// So nothing here writes SQL. The probe is `buildChainPostureSql`'s output with
// ONE key injected — the attempt id — and the body is parsed by
// `parseChainPosture` and judged by the `evaluate*` functions that
// `certify:remediation` already runs. A second posture contract would be a
// second thing to keep in step with the plan, and the two would disagree the
// first time a package added a transfer.
//
// ---------------------------------------------------------------------------
// THE BASELINE PROBLEM, AND WHY IT IS NOT SOLVED BY INVENTING ONE
// ---------------------------------------------------------------------------
// Two of the six evaluators are DELTAS against the posture before T1. Remotely
// that state no longer exists and cannot be re-measured: the chain is
// installed. Three ways out, and only one of them is evidence.
//
//   * A literal expectation — "memberships = 0", "eleven rows". WRONG, and
//     specifically wrong: staging carries EIGHT legitimate membership rows that
//     predate the chain, one of which is `uellix_owner<-uellix_migrator` WITH
//     SET — the grant that lets the owner window open at all. A residual check
//     that counted `SET` memberships would report the chain's own prerequisite
//     as a leak, and the operator would learn to ignore the number.
//   * A synthetic baseline derived from the role registry. Self-consistent, and
//     it would agree with itself forever.
//   * THE MEASUREMENT THAT WAS TAKEN. `parsePrechainObservationDocument` already
//     governs a document whose `memberships` come from a query whose membership
//     predicate is BYTE-IDENTICAL to the posture probe's (asserted by test, not
//     assumed) — and one such document was measured against staging for the
//     attempt that authorised the T1 that succeeded.
//
// The third is used, selected the way `CLASS_C_SQL_EDITOR_EVIDENCE` selects:
// from a PINNED list, last entry current. Never by recency, never by mtime,
// never by whichever file happens to be in `artifacts/`.
//
// ---------------------------------------------------------------------------
// AND TWO CLAIMS THAT NEED NO BASELINE AT ALL
// ---------------------------------------------------------------------------
// `TEMP_MEMBERSHIPS = 0` and `TEMP_CREATE_GRANTS = 0` are the two the gate names,
// and both are ABSOLUTE properties once the expectation is derived from the
// authority plan rather than counted:
//
//   * the chain temporarily grants membership in each CAPABILITY role so the
//     installer can `SET ROLE` into it. Post-chain nobody may reach one. That is
//     `capabilityReachableBy` empty — and `pg_has_role(..., 'SET')` is
//     TRANSITIVE, so it also closes the intermediate-role path a row inspection
//     cannot see. The legitimate delta is `admin=true inherit=false set=false`,
//     which confers administration and no ability to become the role, so it does
//     not appear here. The distinction is the whole point.
//   * the chain temporarily grants `CREATE ON SCHEMA <s> TO <capability>` for
//     exactly the pairs `buildAuthorityPlan()` declares, and revokes each. Post-
//     chain none of THOSE pairs may be held. Legitimate prechain CREATE grants
//     are not in the derived set and are therefore never read as leakage.
//
// Neither needs a baseline, and neither is a literal: add a transfer segment in
// a new schema and the expected pair set grows without anybody editing a list.
//
// ---------------------------------------------------------------------------
// THIS FILE CONNECTS TO NOTHING
// ---------------------------------------------------------------------------
// No socket, no environment variable, no connection string, no `psql`. It emits
// text and consumes text. The operator is the only thing that touches the
// database, and the only thing it may run is a SELECT.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { buildAuthorityPlan, type AuthorityPlan } from '../classification-manifest'
import {
  ATTEMPT_ID_SHAPE,
  attemptStatus,
  parseAttemptLedger,
  type AttemptStatus,
  type ChainAttemptRecord,
} from '../../fresh-observation'
import {
  parsePrechainObservationDocument,
  PRECHAIN_OBSERVATION_SCHEMA,
} from '../../chain-operator'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  type ProductionIdentifiers,
} from '../../target-identity'
import { CAPABILITY_ROLES } from './prechain-authority-gate'
import {
  CHAIN_POSTURE_SCHEMA,
  buildChainPostureSql,
  deriveExpectedCanonicalOwnerContexts,
  deriveExpectedOwnerTransfers,
  evaluateCanonicalOwnerContexts,
  evaluateOwnerTransfers,
  evaluatePersistentRoleTopology,
  evaluateRlsPolicyEngine,
  evaluateSecurityDefinerGate,
  parseChainPosture,
  type ChainPosture,
  type PostureMembership,
} from './chain-postconditions'

/* -------------------------------------------------------------------------- */
/* Paths and refusals                                                          */
/* -------------------------------------------------------------------------- */

/** Regenerated per attempt, and `.gitignore`d for the reason every probe is. */
export const POSTURE_PROBE_ARTEFACT = 'artifacts/hosted-chain-posture-probe.sql'
/** Where the DERIVED verdict is written, so a report can only quote it. */
export const POSTURE_STATUS_ARTEFACT = 'artifacts/hosted-chain-posture-status.json'

/**
 * A ledger of its OWN, and not the chain's.
 *
 * A posture observation authorises nothing — it is taken after every write, and
 * the thing it measures is already installed. Appending its attempts to
 * `artifacts/hosted-chain-attempts.jsonl` would make a read-only measurement the
 * latest OPENED chain attempt, which is the entire freshness binding for a
 * WRITE. That is the F-PS-04 defect in the other direction, and the remediation
 * ledger is separate for exactly this reason.
 */
export const POSTURE_ATTEMPT_LEDGER = 'artifacts/hosted-chain-posture-attempts.jsonl'

/** The typed kind. A record without it is not a posture attempt. */
export const POSTURE_ATTEMPT_KIND = 'hosted-chain-posture'

export type PostureEvidenceCode =
  | 'POSTURE_PROBE_ATTEMPT_MALFORMED'
  | 'POSTURE_PROBE_ANCHOR_MOVED'
  | 'POSTURE_PROBE_NOT_READ_ONLY'
  | 'POSTURE_EVIDENCE_REQUIRED'
  | 'POSTURE_EVIDENCE_MALFORMED'
  | 'POSTURE_EVIDENCE_ATTEMPT_MISMATCH'
  | 'POSTURE_ATTEMPT_NOT_OPEN'
  | 'POSTURE_BASELINE_EMPTY'
  | 'POSTURE_BASELINE_PRODUCTION_REF'
  | 'POSTURE_BASELINE_WRONG_TARGET'
  | 'POSTURE_BASELINE_ABSENT'
  | 'POSTURE_BASELINE_MALFORMED'

export class PostureEvidenceRefusal extends Error {
  readonly code: PostureEvidenceCode
  constructor(code: PostureEvidenceCode, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'PostureEvidenceRefusal'
  }
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                   */
/* -------------------------------------------------------------------------- */

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * The anchor the attempt binding is injected at.
 *
 * Matched EXACTLY ONCE or this throws. `buildChainPostureSql` is generated from
 * the derived transfer set, so it legitimately changes when a package adds one;
 * what must never happen is that it changes in a way which silently drops the
 * echo and leaves a document nobody can attribute to an attempt.
 */
const POSTURE_ANCHOR = `SELECT jsonb_build_object(\n  'schema', ${lit(CHAIN_POSTURE_SCHEMA)},\n`

/**
 * Statement keywords that would make this something other than a measurement.
 *
 * `SET search_path = ''` is the one non-SELECT statement the posture probe
 * carries and it is not on this list, deliberately: it is the property the
 * SECURITY DEFINER gate exists to check, it changes no data and no catalog, and
 * removing it would make every unqualified name in the probe resolve through
 * whatever `search_path` the operator's session happens to hold — which is the
 * defect, not the fix.
 */
const MUTATING_KEYWORDS: readonly string[] = [
  'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'MERGE', 'COPY',
  'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'COMMENT',
  'REASSIGN', 'REFRESH', 'IMPORT', 'CALL', 'DO', 'VACUUM', 'ANALYZE',
  'SECURITY LABEL', 'LOCK', 'NOTIFY', 'PREPARE', 'EXECUTE',
]

/**
 * Refuses to hand an operator anything that could write.
 *
 * Run by the GENERATOR, not only by a test. A test proves the probe is
 * read-only on the day it runs; this proves the bytes on disk are, at the
 * moment they are written, on the machine of the person about to paste them
 * into a session against staging.
 *
 * Keywords are matched on word boundaries OUTSIDE string literals — the probe
 * legitimately contains `'CREATE'` as a privilege name inside a quoted string,
 * and a substring test would refuse the correct probe.
 */
export function assertPostureProbeIsReadOnly(sql: string): void {
  const unquoted = sql.replace(/'(?:[^']|'')*'/g, "''")
  const found = MUTATING_KEYWORDS.filter((k) =>
    new RegExp(`\\b${k.replace(/ /g, '\\s+')}\\b`, 'i').test(unquoted),
  )
  if (found.length > 0) {
    throw new PostureEvidenceRefusal(
      'POSTURE_PROBE_NOT_READ_ONLY',
      `the generated posture probe contains ${found.join(', ')} outside a string literal. This file ` +
        `emits a measurement an operator runs against a project that is already installed; a probe ` +
        `that can write is not a probe, and the operator has no way to tell by reading it.`,
    )
  }
  const statements = unquoted.split(';').map((s) => s.trim()).filter((s) => s !== '')
  const selects = statements.filter((s) => /^SELECT\b/i.test(s))
  const sets = statements.filter((s) => /^SET\s+search_path\b/i.test(s))
  if (selects.length !== 1 || sets.length !== 1 || statements.length !== 2) {
    throw new PostureEvidenceRefusal(
      'POSTURE_PROBE_NOT_READ_ONLY',
      `the generated posture probe is ${statements.length} statement(s): ${sets.length} search_path ` +
        `SET and ${selects.length} SELECT. The contract is exactly one of each — a probe that grew a ` +
        `second statement is a probe whose second statement nobody reviewed.`,
    )
  }
}

/**
 * The certified posture probe, wrapped so the SERVER echoes the attempt.
 *
 * The BODY is `buildChainPostureSql`'s output, unmodified. The id is `att_`
 * followed by 32 hex characters — a shape that cannot contain a quote — which is
 * why it is compiled in as a literal rather than escaped, and why it is a
 * literal rather than a `-v` variable: a variable is supplied at run time by the
 * person the binding is protecting.
 */
export function buildChainPostureProbeSql(attemptId: string, root: string = process.cwd()): string {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new PostureEvidenceRefusal(
      'POSTURE_PROBE_ATTEMPT_MALFORMED',
      `refusing to build a probe for attempt id ${JSON.stringify(attemptId)}: an attempt id is att_ ` +
        `followed by 32 hex characters.`,
    )
  }
  const base = buildChainPostureSql(
    deriveExpectedOwnerTransfers(root),
    deriveExpectedCanonicalOwnerContexts(root),
  )
  const occurrences = base.split(POSTURE_ANCHOR).length - 1
  if (occurrences !== 1) {
    throw new PostureEvidenceRefusal(
      'POSTURE_PROBE_ANCHOR_MOVED',
      `the injection anchor was found ${occurrences} time(s) in the posture SQL, expected exactly 1. ` +
        `The probe must echo the attempt it was built for; one that silently lost the echo would let ` +
        `last week's output be read as this week's measurement.`,
    )
  }
  const sql = base.replace(
    POSTURE_ANCHOR,
    `${POSTURE_ANCHOR}  'attemptId', ${lit(attemptId)},\n`,
  )
  assertPostureProbeIsReadOnly(sql)
  return sql
}

/* -------------------------------------------------------------------------- */
/* The attempt ledger                                                          */
/* -------------------------------------------------------------------------- */

export interface PostureAttemptRecord extends ChainAttemptRecord {
  readonly kind: typeof POSTURE_ATTEMPT_KIND
}

/**
 * The posture attempts in a ledger, and nothing else.
 *
 * The STRICT direction, like `parseRemediationAttemptLedger`: a line that parses
 * as a generic attempt but does not declare this kind is dropped. There are no
 * historical posture records to be kind to, so there is no reason to be lenient.
 */
export function parsePostureAttemptLedger(raw: string | null): readonly PostureAttemptRecord[] {
  return parseAttemptLedger(raw).filter(
    (r): r is PostureAttemptRecord => r.kind === POSTURE_ATTEMPT_KIND,
  )
}

export function postureAttemptStatus(
  records: readonly PostureAttemptRecord[],
  attemptId: string,
): AttemptStatus {
  return attemptStatus(records, attemptId)
}

/** One ledger line. The caller appends it; nothing here writes. */
export function postureAttemptLine(
  event: 'OPENED' | 'CONSUMED',
  attemptId: string,
  targetProjectRef: string,
  at: string,
): string {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new PostureEvidenceRefusal(
      'POSTURE_PROBE_ATTEMPT_MALFORMED',
      `refusing to write a ledger line for attempt id ${JSON.stringify(attemptId)}.`,
    )
  }
  return `${JSON.stringify({
    attemptId,
    event,
    targetProjectRef,
    at,
    kind: POSTURE_ATTEMPT_KIND,
  })}\n`
}

/* -------------------------------------------------------------------------- */
/* The evidence document                                                       */
/* -------------------------------------------------------------------------- */

export interface ChainPostureEvidence {
  readonly attemptId: string
  readonly posture: ChainPosture
}

/**
 * Parse, bind to the attempt, and DELEGATE the body.
 *
 * The attempt is checked BEFORE the body: a document measured for a different
 * attempt is not weaker evidence about this database, it is evidence about a
 * different moment, and there is nothing to learn from type-checking it first.
 *
 * The body is `parseChainPosture`, unchanged. The injected `attemptId` is one
 * extra key in the same object, so the document this reader consumes is still
 * exactly the document the certified parser governs.
 */
export function parseChainPostureEvidence(
  raw: string | null,
  expectedAttemptId: string,
): ChainPostureEvidence {
  if (!ATTEMPT_ID_SHAPE.test(expectedAttemptId)) {
    throw new PostureEvidenceRefusal(
      'POSTURE_PROBE_ATTEMPT_MALFORMED',
      `the caller supplied attempt id ${JSON.stringify(expectedAttemptId)}, which is not att_ ` +
        `followed by 32 hex characters.`,
    )
  }
  if (raw === null || raw.trim() === '') {
    throw new PostureEvidenceRefusal(
      'POSTURE_EVIDENCE_REQUIRED',
      'no posture document was supplied. The absence of a measurement is not a measurement of ' +
        'absence, and PENDING_OPERATOR_EVIDENCE is the honest verdict until one exists.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PostureEvidenceRefusal(
      'POSTURE_EVIDENCE_MALFORMED',
      `the posture document is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `It is emitted as a single jsonb cell precisely so that this is the only parse that happens.`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PostureEvidenceRefusal(
      'POSTURE_EVIDENCE_MALFORMED',
      'the posture document is not a JSON object.',
    )
  }
  const doc = parsed as Record<string, unknown>

  if (doc.attemptId !== expectedAttemptId) {
    throw new PostureEvidenceRefusal(
      'POSTURE_EVIDENCE_ATTEMPT_MISMATCH',
      `the document echoes attempt ${JSON.stringify(doc.attemptId)} and the open attempt is ` +
        `${expectedAttemptId}. The id is compiled into the probe, so a disagreement means this ` +
        `measurement was taken for a different attempt — which is what a stale observation IS.`,
    )
  }

  // The CERTIFIED parser, unchanged. Its refusals surface as themselves.
  return { attemptId: expectedAttemptId, posture: parseChainPosture(raw) }
}

/* -------------------------------------------------------------------------- */
/* Expectations DERIVED from the authority plan                                */
/* -------------------------------------------------------------------------- */

/**
 * `schema -> grantee` for every temporary `GRANT CREATE ON SCHEMA` the chain
 * opens, derived from the segments that declare one.
 *
 * The grantee is the segment's `ownerDestination` where it has one and its
 * `executor` otherwise — a CAPABILITY window opens CREATE for the role it runs
 * as, an OWNER_TRANSFER segment for the role it is transferring TO. Both are
 * read from the plan; neither is written down here.
 */
export function deriveTemporaryCapabilityCreateGrants(
  plan: AuthorityPlan = buildAuthorityPlan(),
): readonly string[] {
  const pairs = new Set<string>()
  for (const segment of plan.segments) {
    const schema = segment.requiredTemporarySchemaCreate
    if (schema === null || schema === undefined) continue
    const grantee = segment.ownerDestination ?? segment.executor
    if (typeof grantee !== 'string' || grantee === '') continue
    pairs.add(`${schema} -> ${grantee}`)
  }
  return [...pairs].sort()
}

/**
 * The roles the chain temporarily BECOMES and must not still be able to become.
 *
 * `uellix_owner` is excluded and the exclusion is the substance of the check.
 * The chain does temporarily assume it — `requiredTemporaryMemberships` says so
 * — but `uellix_owner<-uellix_migrator WITH SET` is a PRECHAIN row that exists
 * before T1 and must survive T9: it is what lets the owner window open at all.
 * Reporting it as a residual would fail a perfect run, and teaching an operator
 * to expect one false positive is how a residual probe stops being read.
 *
 * What must be gone is the CAPABILITY reach, and that is intersected with the
 * registry rather than assumed, so a plan that started elevating something else
 * would widen this rather than slip past it.
 */
export function deriveTemporaryCapabilityMemberships(
  plan: AuthorityPlan = buildAuthorityPlan(),
  capabilityRoles: readonly string[] = CAPABILITY_ROLES,
): readonly string[] {
  const roles = new Set<string>()
  for (const segment of plan.segments) {
    for (const role of segment.requiredTemporaryMemberships ?? []) {
      if (capabilityRoles.includes(role)) roles.add(role)
    }
  }
  return [...roles].sort()
}

/* -------------------------------------------------------------------------- */
/* The two baseline-free residual gates                                        */
/* -------------------------------------------------------------------------- */

export interface ResidualVerdict {
  readonly pass: boolean
  readonly expected: readonly string[]
  readonly residual: readonly string[]
  readonly unmeasured: readonly string[]
}

/**
 * `TEMP_MEMBERSHIPS` — nobody may still be able to become a capability role.
 *
 * Two independent readings of the same property, because they fail differently:
 *
 *   * `capabilityReachableBy` is `pg_has_role(..., 'SET')`, computed by the
 *     server, TRANSITIVE, and therefore the only one that sees a reach through
 *     an intermediate role. It excludes superusers by construction — a superuser
 *     can always, and listing that would be listing PostgreSQL.
 *   * the membership ROWS, which do see a superuser member, and which say WHICH
 *     grant would have to be revoked.
 *
 * A capability role the document does not mention is UNMEASURED, not clean. An
 * absent key is the absence of a measurement, and a residual gate that read it
 * as zero would pass hardest on the probe that measured least.
 */
export function evaluateTemporaryMembershipResidual(
  posture: ChainPosture,
  expected: readonly string[] = deriveTemporaryCapabilityMemberships(),
): ResidualVerdict {
  const reachable = posture.capabilityReachableBy ?? {}
  const residual: string[] = []
  const unmeasured: string[] = []

  for (const role of expected) {
    if (!Object.prototype.hasOwnProperty.call(reachable, role)) {
      unmeasured.push(role)
      continue
    }
    for (const by of reachable[role] ?? []) residual.push(`${by} -> ${role} (SET, per pg_has_role)`)
  }

  for (const m of posture.memberships) {
    if (!expected.includes(m.role)) continue
    if (m.setOption || m.inheritOption) {
      residual.push(
        `${m.role}<-${m.member} (admin=${m.adminOption} inherit=${m.inheritOption} set=${m.setOption})`,
      )
    }
  }

  return {
    pass: residual.length === 0 && unmeasured.length === 0 && expected.length > 0,
    expected,
    residual: [...new Set(residual)].sort(),
    unmeasured: unmeasured.sort(),
  }
}

/**
 * `TEMP_CREATE_GRANTS` — none of the pairs the chain opens is still held.
 *
 * A schema's OWNER holds CREATE inherently, so `grantee === owner` is filtered
 * exactly as `evaluateSchemaCreateResidual` filters it: counting that would
 * report every schema the chain creates as a residual.
 *
 * A schema absent from `schemaCreateGrants` is UNMEASURED. `acldefault` puts the
 * owner's own CREATE in the answer for every schema that exists, so a governed
 * schema with no row at all means the probe did not reach it.
 */
export function evaluateTemporaryCreateResidual(
  posture: ChainPosture,
  expected: readonly string[] = deriveTemporaryCapabilityCreateGrants(),
): ResidualVerdict {
  const held = new Set(
    posture.schemaCreateGrants
      .filter((g) => g.grantee !== g.owner)
      .map((g) => `${g.schema} -> ${g.grantee}`),
  )
  const measuredSchemas = new Set(posture.schemaCreateGrants.map((g) => g.schema))

  const residual = expected.filter((pair) => held.has(pair))
  const unmeasured = expected.filter((pair) => !measuredSchemas.has(pair.split(' -> ')[0] as string))

  return {
    pass: residual.length === 0 && unmeasured.length === 0 && expected.length > 0,
    expected,
    residual: [...residual].sort(),
    unmeasured: [...new Set(unmeasured)].sort(),
  }
}

/* -------------------------------------------------------------------------- */
/* The prechain topology baseline — declared, never discovered                 */
/* -------------------------------------------------------------------------- */

export interface PrechainTopologyEntry {
  readonly path: string
  /** The attempt the document echoes. Checked; never inferred from the name. */
  readonly attemptId: string
  /** ISO date the operator measured it. Documentation; never the selector. */
  readonly measuredOn: string
  readonly projectRef: string
  readonly note: string
}

/**
 * THE DECLARED PRECHAIN TOPOLOGY, as a pinned list.
 *
 * Selection is by DECLARATION — last entry current — for the reason
 * `CLASS_C_SQL_EDITOR_EVIDENCE` is a list and not a glob: evidence that governs
 * a verdict must not be appointable by whoever can write to a directory.
 * Adding an entry is a code change, so it arrives through review with the
 * measurement that justifies it.
 *
 * The file lives under `docs/ops/staging/evidence/` and not under `artifacts/`,
 * and that is the point rather than a preference: the working copy is rewritten
 * by the next attempt that runs the same tool.
 */
export const PRECHAIN_TOPOLOGY_EVIDENCE: readonly PrechainTopologyEntry[] = [
  {
    path: 'docs/ops/staging/evidence/2026-08-11-att_d08da545-prechain-observation.json',
    attemptId: 'att_d08da5453e8899b91e2ab8c18e08b1b9',
    measuredOn: '2026-08-11',
    projectRef: KNOWN_STAGING_PROJECT_REF,
    note:
      'CURRENT. The prechain authority observation measured for the attempt the ledger records as ' +
      'CONSUMED for grounding_0002_document_versions — the T1 write that succeeded. It is therefore ' +
      'the role topology of staging immediately BEFORE the first governed package committed, which ' +
      'is exactly what the chain membership delta is a delta from.\n' +
      '\n' +
      'Its eight rows include uellix_owner<-uellix_migrator WITH SET. That row is a PREREQUISITE of ' +
      'the chain, not a product of it, and it is the specific reason this baseline is a measurement ' +
      'rather than a literal: an expectation of "no SET memberships" would fail a perfect run.',
  },
]

export type PrechainTopologyResolution =
  | { readonly ok: true; readonly entry: PrechainTopologyEntry }
  | { readonly ok: false; readonly code: PostureEvidenceCode; readonly detail: string }

/**
 * Picks the authoritative baseline, or refuses.
 *
 * Production is vetoed BEFORE the target match, so a production artefact is
 * refused by the check that names production rather than by one that happens to
 * reject it today for another reason.
 */
export function resolvePrechainTopologyEvidence(
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  ledger: readonly PrechainTopologyEntry[] = PRECHAIN_TOPOLOGY_EVIDENCE,
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
): PrechainTopologyResolution {
  const entry = ledger[ledger.length - 1]
  if (entry === undefined) {
    return {
      ok: false,
      code: 'POSTURE_BASELINE_EMPTY',
      detail:
        'no prechain topology is declared, so the membership delta has nothing to be a delta from. ' +
        'Unmeasured is refused; it is not zero.',
    }
  }
  if (production.projectRefs.includes(entry.projectRef)) {
    return {
      ok: false,
      code: 'POSTURE_BASELINE_PRODUCTION_REF',
      detail: `${entry.path} describes ${entry.projectRef}, a KNOWN PRODUCTION project.`,
    }
  }
  if (entry.projectRef !== targetProjectRef) {
    return {
      ok: false,
      code: 'POSTURE_BASELINE_WRONG_TARGET',
      detail:
        `${entry.path} describes ${entry.projectRef}; the target is ${targetProjectRef}. An ` +
        `observation of another database is not weaker evidence about this one — it is evidence ` +
        `about something else.`,
    }
  }
  return { ok: true, entry }
}

/**
 * The membership rows the chain started from, and where they came from.
 *
 * A DISTINCT TYPE rather than a `ChainPosture` with empty arrays, deliberately.
 * `evaluateSchemaCreateResidual` also takes a baseline posture, and an empty one
 * would make it report every legitimate grant on the project as a residual. A
 * type that cannot be passed there cannot be passed there by mistake.
 */
export interface PrechainTopologyBaseline {
  readonly source: string
  readonly attemptId: string
  readonly memberships: readonly PostureMembership[]
}

/**
 * Loads the declared baseline through the parser that already governs it.
 *
 * `parsePrechainObservationDocument` type-checks every field and binds the
 * document to the attempt the ledger entry declares. A hand-rolled reader here
 * would be a second spelling of a contract that already exists, and it would
 * accept the first document the real one refuses.
 */
export function loadPrechainTopologyBaseline(
  raw: string | null,
  entry: PrechainTopologyEntry,
): PrechainTopologyBaseline {
  if (raw === null || raw.trim() === '') {
    throw new PostureEvidenceRefusal(
      'POSTURE_BASELINE_ABSENT',
      `${entry.path} is absent or empty. It is the declared prechain topology and it cannot be ` +
        `re-measured: the chain is installed, and the state it describes no longer exists.`,
    )
  }
  let observation
  try {
    observation = parsePrechainObservationDocument(raw, entry.attemptId)
  } catch (error) {
    throw new PostureEvidenceRefusal(
      'POSTURE_BASELINE_MALFORMED',
      `${entry.path} is not a ${PRECHAIN_OBSERVATION_SCHEMA} document bound to ${entry.attemptId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return {
    source: entry.path,
    attemptId: entry.attemptId,
    memberships: observation.memberships.map((m) => ({
      role: m.role,
      member: m.member,
      grantor: m.grantor,
      adminOption: m.adminOption,
      inheritOption: m.inheritOption,
      setOption: m.setOption,
    })),
  }
}

/**
 * `evaluatePersistentRoleTopology`, driven by a measured prechain baseline.
 *
 * `evaluatePersistentRoleTopology` reads exactly ONE field of its second
 * argument — `memberships` — and reads `memberships` plus
 * `capabilityReachableBy` of its first. The shim therefore carries the measured
 * baseline rows and empty everything else, and those empties are never
 * consulted: they are padding to satisfy the type, not a claim. The real posture
 * supplies every field the verdict actually rests on.
 */
export function evaluateRemoteRoleTopology(
  posture: ChainPosture,
  baseline: PrechainTopologyBaseline,
): ReturnType<typeof evaluatePersistentRoleTopology> & { readonly baselineSource: string } {
  const shim = {
    schema: CHAIN_POSTURE_SCHEMA,
    transferredOwners: {},
    canonicalContextOwners: {},
    functions: [],
    relations: [],
    policies: [],
    triggers: [],
    memberships: baseline.memberships,
    schemaCreateGrants: [],
    roleAttributes: [],
    capabilityReachableBy: {},
  } satisfies ChainPosture

  return { ...evaluatePersistentRoleTopology(posture, shim), baselineSource: baseline.source }
}

/* -------------------------------------------------------------------------- */
/* The status                                                                  */
/* -------------------------------------------------------------------------- */

export interface PostureStatusInputs {
  /** The attempt the tool opened, read from the ledger — never from a flag. */
  readonly expectedAttemptId: string
  /** The posture document the operator saved verbatim. */
  readonly raw: string | null
  /** The posture attempt ledger's bytes. */
  readonly attemptLedger: string | null
  /** Reads a repo-relative path. Injected so tests never touch the tree. */
  readonly readArtefact: (repoRelativePath: string) => string | null
  readonly root?: string
  readonly expectedProjectRef?: string
  readonly production?: ProductionIdentifiers
}

export interface PostureStatus {
  readonly generatedBy: string
  readonly attemptId: string
  readonly attemptStatus: AttemptStatus
  readonly observationPresent: boolean
  readonly baseline: { readonly source: string | null; readonly attemptId: string | null }
  readonly refusal: { readonly code: string; readonly detail: string } | null
  readonly measurements: Record<string, unknown> | null
  readonly verdicts: Readonly<Record<string, string>>
  readonly blockers: readonly string[]
  /**
   * The ONE value a report may quote. It says the REMOTE posture is the posture
   * the plan requires — not that anything may now be enabled.
   */
  readonly postureVerified: boolean
}

const GENERATED_BY =
  'pnpm posture:status:write --attempt=<id> --observation=<file> — do not hand-edit; derived from the observation'

export function computePostureStatus(inputs: PostureStatusInputs): PostureStatus {
  const root = inputs.root ?? process.cwd()
  const expectedProjectRef = inputs.expectedProjectRef ?? KNOWN_STAGING_PROJECT_REF
  const production = inputs.production ?? KNOWN_PRODUCTION_IDENTIFIERS

  const base = {
    generatedBy: GENERATED_BY,
    attemptId: inputs.expectedAttemptId,
    attemptStatus: postureAttemptStatus(
      parsePostureAttemptLedger(inputs.attemptLedger),
      inputs.expectedAttemptId,
    ),
    observationPresent: inputs.raw !== null && inputs.raw.trim() !== '',
    baseline: { source: null as string | null, attemptId: null as string | null },
    measurements: null,
    blockers: [] as readonly string[],
    postureVerified: false,
  }

  const refuse = (code: string, detail: string): PostureStatus => ({
    ...base,
    refusal: { code, detail },
    verdicts: { REMOTE_CHAIN_POSTURE: 'PENDING_OPERATOR_EVIDENCE' },
    blockers: [`${code}: ${detail}`],
  })

  // THE ATTEMPT FIRST. A document measured through a spent attempt is stale
  // whatever it contains, and type-checking it first would be reading a
  // measurement before establishing that it is this one.
  if (base.attemptStatus !== 'OPEN') {
    return refuse(
      'POSTURE_ATTEMPT_NOT_OPEN',
      base.attemptStatus === 'UNKNOWN'
        ? `attempt ${inputs.expectedAttemptId} was never opened in ${POSTURE_ATTEMPT_LEDGER}. An ` +
            `attempt is opened before the probe runs; one that appears only now was not the attempt ` +
            `anything measured.`
        : `attempt ${inputs.expectedAttemptId} is spent — it was consumed by a status already or ` +
            `superseded by a later attempt. One observation is judged once.`,
    )
  }

  let evidence: ChainPostureEvidence
  try {
    evidence = parseChainPostureEvidence(inputs.raw, inputs.expectedAttemptId)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'POSTURE_EVIDENCE_MALFORMED'
    return refuse(code, error instanceof Error ? error.message : String(error))
  }

  const resolved = resolvePrechainTopologyEvidence(expectedProjectRef, PRECHAIN_TOPOLOGY_EVIDENCE, production)
  if (!resolved.ok) return refuse(resolved.code, resolved.detail)

  let baseline: PrechainTopologyBaseline
  try {
    baseline = loadPrechainTopologyBaseline(inputs.readArtefact(resolved.entry.path), resolved.entry)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'POSTURE_BASELINE_MALFORMED'
    return refuse(code, error instanceof Error ? error.message : String(error))
  }

  const posture = evidence.posture
  const expectedTransfers = deriveExpectedOwnerTransfers(root)
  const expectedContexts = deriveExpectedCanonicalOwnerContexts(root)

  const ownerTransfers = evaluateOwnerTransfers(expectedTransfers, posture)
  const canonicalOwnerContexts = evaluateCanonicalOwnerContexts(expectedContexts, posture)
  const temporaryMemberships = evaluateTemporaryMembershipResidual(posture)
  const temporaryCreateGrants = evaluateTemporaryCreateResidual(posture)
  const persistentRoleTopology = evaluateRemoteRoleTopology(posture, baseline)
  const securityDefinerGate = evaluateSecurityDefinerGate(posture)
  const rlsPolicyEngine = evaluateRlsPolicyEngine(posture)

  const verdicts: Record<string, string> = {
    POSTURE_ATTEMPT_BINDING: 'BOUND',
    PRECHAIN_TOPOLOGY_BASELINE: 'MEASURED_REMOTELY',
    OWNER_TRANSFERS_REMOTE: ownerTransfers.pass
      ? `${ownerTransfers.correct}_OF_${ownerTransfers.total}_CORRECT`
      : 'INCOMPLETE',
    CANONICAL_OWNER_CONTEXT_REMOTE: canonicalOwnerContexts.pass
      ? `${canonicalOwnerContexts.correct}_OF_${canonicalOwnerContexts.total}_CORRECT`
      : 'INCOMPLETE',
    TEMP_MEMBERSHIPS: temporaryMemberships.pass ? 'ZERO' : 'NONZERO',
    TEMP_CREATE_GRANTS: temporaryCreateGrants.pass ? 'ZERO' : 'NONZERO',
    PERSISTENT_ROLE_TOPOLOGY_REMOTE: persistentRoleTopology.pass ? 'EXPECTED' : 'DRIFTED',
    SD_GATE_REMOTE: securityDefinerGate.pass ? 'PASS' : 'FAIL',
    RLS_POLICY_ENGINE_REMOTE: rlsPolicyEngine.pass ? 'PASS' : 'FAIL',
  }

  const failed = Object.entries(verdicts).filter(([, v]) =>
    ['FAIL', 'INCOMPLETE', 'NONZERO', 'DRIFTED'].includes(v),
  )

  const blockers = [
    ...ownerTransfers.wrong.map((w) => `OWNER_TRANSFERS_REMOTE: ${w}`),
    ...canonicalOwnerContexts.wrong.map((w) => `CANONICAL_OWNER_CONTEXT_REMOTE: ${w}`),
    ...temporaryMemberships.residual.map((w) => `TEMP_MEMBERSHIPS: ${w}`),
    ...temporaryMemberships.unmeasured.map((w) => `TEMP_MEMBERSHIPS: ${w} was not measured at all`),
    ...temporaryCreateGrants.residual.map((w) => `TEMP_CREATE_GRANTS: ${w}`),
    ...temporaryCreateGrants.unmeasured.map((w) => `TEMP_CREATE_GRANTS: ${w} was not measured at all`),
    ...persistentRoleTopology.unexpected.map((w) => `PERSISTENT_ROLE_TOPOLOGY_REMOTE: +${w}`),
    ...persistentRoleTopology.missing.map((w) => `PERSISTENT_ROLE_TOPOLOGY_REMOTE: missing ${w}`),
    ...persistentRoleTopology.removed.map((w) => `PERSISTENT_ROLE_TOPOLOGY_REMOTE: -${w}`),
    ...persistentRoleTopology.capabilityReachableBy.map((w) => `PERSISTENT_ROLE_TOPOLOGY_REMOTE: REACHABLE ${w}`),
    ...securityDefinerGate.withoutEmptySearchPath.map((w) => `SD_GATE_REMOTE: ${w}`),
    ...securityDefinerGate.withPublicExecute.map((w) => `SD_GATE_REMOTE: PUBLIC EXECUTE ${w}`),
    ...rlsPolicyEngine.duplicates.map((w) => `RLS_POLICY_ENGINE_REMOTE: duplicate ${w}`),
    ...rlsPolicyEngine.policiesOnUnprotectedRelations.map(
      (w) => `RLS_POLICY_ENGINE_REMOTE: policy on ${w} with row security DISABLED`,
    ),
  ]

  return {
    ...base,
    baseline: { source: baseline.source, attemptId: baseline.attemptId },
    refusal: null,
    measurements: {
      ownerTransfers,
      canonicalOwnerContexts,
      temporaryMemberships,
      temporaryCreateGrants,
      persistentRoleTopology,
      securityDefinerGate,
      rlsPolicyEngine,
    },
    verdicts,
    blockers,
    postureVerified: failed.length === 0,
  }
}

export const serializePostureStatus = (status: PostureStatus): string =>
  `${JSON.stringify(status, null, 2)}\n`

export type PostureStatusVerification =
  | { readonly ok: true; readonly present: boolean; readonly note: string }
  | { readonly ok: false; readonly present: true; readonly note: string }

export function verifyPostureStatus(
  onDisk: string | null,
  expected: string,
): PostureStatusVerification {
  if (onDisk === null) {
    return { ok: true, present: false, note: `${POSTURE_STATUS_ARTEFACT} not present yet — nothing to verify` }
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    return {
      ok: false,
      present: true,
      note:
        `${POSTURE_STATUS_ARTEFACT} DIVERGED from what the contract computes today. Either the ` +
        `observation changed, or the status was edited. A status a document quotes and nothing ` +
        `recomputes is a number that will eventually be wrong in the direction that flatters the ` +
        `author.`,
    }
  }
  return {
    ok: true,
    present: true,
    note: 'the recorded verdict is what the contract computes over the recorded observation',
  }
}

/** Convenience for a caller that already knows the repo root. Reads, never writes. */
export const readRepoFile =
  (root: string) =>
  (rel: string): string | null => {
    try {
      return readFileSync(path.join(root, rel), 'utf8')
    } catch {
      return null
    }
  }
