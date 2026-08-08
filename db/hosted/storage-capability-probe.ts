// db/hosted/storage-capability-probe.ts
// TRAIN 5C2 — the last boundary before the Storage question can be answered.
//
// ---------------------------------------------------------------------------
// WHY THE CANONICAL POLICY IS THE WRONG PROBE
// ---------------------------------------------------------------------------
// The previous train proposed `select_evidence` as the first thing the operator
// creates through the Dashboard. That was a design error and the operator caught
// it: unit 41 PART A has NOT been applied, so `public.can_read_evidence_object`
// does not exist on the target. A failure would then have at least three
// candidate causes —
//
//     ownership / capability of the channel,
//     42883 because the helper is absent,
//     something else about the bucket or the roles,
//
// — and the whole point of the probe is to answer exactly one question. An
// ambiguous negative is worse than no probe: it would look like a measurement
// and license a conclusion the evidence does not support.
//
// ---------------------------------------------------------------------------
// SO THE PROBE MEASURES THE CHANNEL AND NOTHING ELSE
// ---------------------------------------------------------------------------
// One question: CAN THIS CHANNEL CREATE A POLICY ON storage.objects AT ALL?
//
// Everything that could make the answer mean something else is removed: no
// helper, no auth.uid(), no bucket_id, no Uellix function, no role beyond the one
// the canonical policies already use. What remains is `USING (false)` — a
// predicate that depends on nothing.
//
// ---------------------------------------------------------------------------
// AND IT CANNOT GRANT ACCESS. THIS IS THE PART THAT MATTERS
// ---------------------------------------------------------------------------
// PERMISSIVE policies are combined with OR. Adding a PERMISSIVE policy to a table
// can therefore only ever ADD visible rows, never remove them, and `USING (false)`
// adds none: for every row, `false` contributes nothing to the disjunction. The
// probe is SECURITY-MONOTONE — its existence cannot widen access by any amount.
//
// `AS PERMISSIVE` is stated EXPLICITLY rather than left to the default, and that
// is not pedantry. A RESTRICTIVE policy with `USING (false)` is ANDed into
// whatever the permissive policies admit, so it can only ever REMOVE access —
// the same eight words, the opposite direction. Reviewer A was right to narrow
// the original claim here: on a table with no permissive policies it removes
// nothing, because there was nothing to remove. But the moment the canonical
// three exist it removes all of it, and a probe whose effect depends on when it
// is run is not the security-monotone probe that was designed. The postcondition
// checks `pg_policies.permissive` for exactly this reason.

import { EXPECTED_STORAGE_POLICIES } from './storage-policy-artifact'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from './target-identity'

/**
 * Unmistakably temporary, unmistakably ours, and dated.
 *
 * `uellix_tmp_` announces the intent; the date says which operation created it,
 * so a leftover found in three months can be traced to this train rather than
 * guessed at. It deliberately does NOT end in `_evidence`: a name in the shape of
 * the canonical ones invites exactly the confusion between "the channel works"
 * and "the Uellix policies are installed" that this whole file is built to keep
 * apart.
 */
export const CAPABILITY_PROBE_POLICY = 'uellix_tmp_capability_probe_20260807'

export const CAPABILITY_PROBE_TARGET = { schema: 'storage', table: 'objects' } as const
export const CAPABILITY_PROBE_ROLE = 'authenticated'

/** The probe's field values, for a channel that asks for fields, not SQL. */
export const CAPABILITY_PROBE_FIELDS = {
  policyname: CAPABILITY_PROBE_POLICY,
  schema: CAPABILITY_PROBE_TARGET.schema,
  table: CAPABILITY_PROBE_TARGET.table,
  permissive: 'PERMISSIVE',
  cmd: 'SELECT',
  roles: [CAPABILITY_PROBE_ROLE],
  using: 'false',
  withCheck: null,
} as const

/** The probe's SQL, for a channel that asks for SQL. Identical in meaning. */
export const CAPABILITY_PROBE_SQL = `CREATE POLICY "${CAPABILITY_PROBE_POLICY}"
ON storage.objects
AS PERMISSIVE
FOR SELECT
TO ${CAPABILITY_PROBE_ROLE}
USING (false);`

export const CAPABILITY_PROBE_CLEANUP_SQL = `DROP POLICY "${CAPABILITY_PROBE_POLICY}" ON storage.objects;`

/**
 * The read-only precondition. NOTHING here writes, and nothing here is optional.
 *
 * `existing_policy_count` is the one that is easy to leave out and the one the
 * cleanup check depends on: verifying cleanup by the ABSENCE of the probe name
 * alone would pass a cleanup that also removed a policy it should not have. The
 * count taken before and after is what makes "only the probe was removed"
 * checkable rather than assumed.
 */
export const CAPABILITY_PROBE_PRECONDITION_SQL = `-- READ ONLY. Run inside BEGIN READ ONLY; … ROLLBACK;
SELECT
  current_user,
  session_user,
  current_setting('transaction_read_only')                          AS read_only,
  to_regclass('storage.objects') IS NOT NULL                        AS table_exists,
  -- to_regclass, NOT ::regclass. The cast RAISES 42P01 when the relation is
  -- absent, which would make the whole query fail and leave the designed
  -- "table does not exist" refusal unreachable from this SQL.
  (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('storage.objects')) AS rls_enabled,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects')        AS existing_policy_count,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = '${CAPABILITY_PROBE_POLICY}')               AS probe_already_present;

-- AND THE INVENTORY ITSELF, not just its size.
--
-- Adversarial review: step 0 tells the operator to record "existing_policy_count
-- AND the policy names", and the query above produces only the count. On a target
-- with any pre-existing policy the operator could not satisfy the precondition by
-- running what they were given — they would have had to improvise a query, in a
-- module whose stated design is that the operator composes nothing. It returns
-- WHOLE ROWS rather than names, because cleanup verification compares rows.
SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
 ORDER BY policyname;`

/**
 * The read-only postcondition. Every column the contract names, compared for
 * EQUALITY by `verifyCapabilityProbeSurface` — never EXISTS, never substring.
 */
export const CAPABILITY_PROBE_POSTCONDITION_SQL = `-- READ ONLY.
SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
 ORDER BY policyname;`

/* -------------------------------------------------------------------------- */
/* Precondition                                                               */
/* -------------------------------------------------------------------------- */

export interface CapabilityPrecondition {
  readonly projectRef: string
  readonly declaredEnvironment: string
  readonly tableExists: boolean | null
  readonly rlsEnabled: boolean | null
  readonly probeAlreadyPresent: boolean | null
  /** Total policies on storage.objects BEFORE the probe. Needed by cleanup. */
  readonly existingPolicyCount: number | null
  /** Names of those policies, so a stale probe under another spelling is seen. */
  readonly existingPolicyNames: readonly string[] | null
}

export interface CapabilityVerdict {
  readonly ok: boolean
  readonly problems: readonly string[]
}

export function evaluateCapabilityPrecondition(p: CapabilityPrecondition): CapabilityVerdict {
  const problems: string[] = []

  if (!/^[a-z]{20}$/.test(p.projectRef)) {
    problems.push(`projectRef '${p.projectRef}' is not a 20-lowercase-letter Supabase project ref.`)
  }
  // Checked against the constant, not against a boolean somebody passed. The
  // same hole this programme already found in the policy boundary.
  if (KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(p.projectRef)) {
    problems.push(
      `projectRef '${p.projectRef}' is a KNOWN PRODUCTION project. A capability probe is still a WRITE, ` +
        `and the fact that it grants nothing does not make it acceptable against production.`,
    )
  }
  // PINNED TO THE ONE PROJECT, not merely "not production".
  //
  // Adversarial review: absence from a denylist of one entry is a weak target
  // check. Every Supabase project has storage.objects with RLS on and no
  // canonical Uellix policies, so any OTHER project the operator happens to have
  // open passes every remaining precondition — and the probe would then measure
  // the wrong project while the record says "capability demonstrated in staging".
  if (p.projectRef !== KNOWN_STAGING_PROJECT_REF) {
    problems.push(
      `projectRef '${p.projectRef}' is not the known staging project ` +
        `'${KNOWN_STAGING_PROJECT_REF}'. Not-production is not the same as the-right-project.`,
    )
  }
  if (p.declaredEnvironment !== 'staging') {
    problems.push(`declaredEnvironment is '${p.declaredEnvironment}', not 'staging'.`)
  }
  if (p.tableExists !== true) {
    problems.push(
      p.tableExists === null
        ? 'storage.objects existence was not measured. Unmeasured is refused.'
        : 'storage.objects does not exist, so a failure would say nothing about the channel.',
    )
  }
  if (p.rlsEnabled !== true) {
    problems.push(
      p.rlsEnabled === null
        ? 'RLS on storage.objects was not measured. A policy on a table without RLS is inert, and an inert probe proves nothing about enforcement.'
        : 'RLS is NOT enabled on storage.objects. Do not enable it — the platform owns that decision and refuses the attempt.',
    )
  }
  if (p.probeAlreadyPresent !== false) {
    problems.push(
      p.probeAlreadyPresent === null
        ? 'the probe policy name was not checked for. Unmeasured is refused.'
        : `a policy named ${CAPABILITY_PROBE_POLICY} ALREADY EXISTS. A CREATE that fails with 42710 ` +
          `(duplicate_object) would be read as "the channel cannot create policies", which is the ` +
          `opposite of what it means. Clean up the stale one first.`,
    )
  }
  if (p.existingPolicyCount === null || p.existingPolicyNames === null) {
    problems.push(
      'the pre-probe policy inventory was not taken. Cleanup is verified by comparing the count and the ' +
        'names before and after; without a "before", removing the probe AND something else looks identical ' +
        'to removing the probe.',
    )
  } else if (p.existingPolicyCount !== p.existingPolicyNames.length) {
    problems.push(
      `the pre-probe count (${p.existingPolicyCount}) disagrees with the number of names recorded ` +
        `(${p.existingPolicyNames.length}).`,
    )
  }
  // Unit 41 must NOT have been applied yet. If it had, the canonical policies
  // would be present and the operator could mistake their existence for the
  // probe's result.
  // A PREVIOUS PROBE UNDER ANOTHER SPELLING. `uellix_tmp_capability_probe_2026
  // 0806` from an earlier attempt is not "pre-existing" — it is our litter, and
  // the cleanup check would otherwise be OBLIGED to preserve it.
  const staleProbes = (p.existingPolicyNames ?? []).filter(
    (n) => n.startsWith('uellix_tmp_') && n !== CAPABILITY_PROBE_POLICY,
  )
  if (staleProbes.length > 0) {
    problems.push(
      `storage.objects carries ${staleProbes.length} leftover Uellix probe polic(y|ies) under another ` +
        `spelling: ${staleProbes.join(', ')}. Remove them first — otherwise the cleanup check will treat ` +
        `them as pre-existing and require them to SURVIVE.`,
    )
  }

  const canonical = (p.existingPolicyNames ?? []).filter((n) =>
    (EXPECTED_STORAGE_POLICIES as readonly string[]).includes(n),
  )
  if (canonical.length > 0) {
    problems.push(
      `the canonical Uellix policies are already present (${canonical.join(', ')}). The capability probe ` +
        `is for a project where they are NOT, and running it now would measure a question already answered.`,
    )
  }

  return { ok: problems.length === 0, problems }
}

/* -------------------------------------------------------------------------- */
/* Outcome                                                                    */
/* -------------------------------------------------------------------------- */

export type CapabilityOutcome =
  | 'CAPABILITY_PROBE_CREATE_SUCCEEDED'
  | 'CAPABILITY_PROBE_CREATE_FAILED'

export interface CapabilityProbeRecord {
  readonly outcome: CapabilityOutcome
  /** Sanitized. Empty on success. */
  readonly error: string
  readonly timestamp: string
  readonly projectRef: string
  readonly policyName: string
}

const SECRET_SHAPES: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s'"]+/gi, // connection strings
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWTs
  /\bsb[ps]_[A-Za-z0-9_-]{8,}/g, // Supabase keys
  /\b(?:password|api[_-]?key|secret|token)\s*[=:]\s*\S+/gi,
]

/**
 * Keeps the message and drops anything shaped like a credential.
 *
 * A PostgreSQL error for this probe is short and structural — `42501
 * insufficient_privilege`, `must be owner of table objects` — and that text is
 * the whole diagnostic value. But an error surfaced through a platform UI can
 * carry a request context, and a record nobody can paste is a record nobody
 * keeps.
 */
export function sanitizeProbeError(raw: string): string {
  let out = raw
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[REDACTED]')
  return out.replace(/\s+/g, ' ').trim().slice(0, 500)
}

/**
 * The ONLY constructor for a probe record, so sanitisation cannot be skipped.
 *
 * `sanitizeProbeError` existing as a helper somebody may remember to call is not
 * a control — it is a suggestion, and the interesting failure is a hurried
 * operator pasting a UI error that happens to carry a request context. Routing
 * every record through here makes the sanitised form the only form that exists.
 *
 * It also refuses a record whose fields contradict each other: a SUCCEEDED
 * outcome carrying an error message, or a FAILED one carrying none, is a record
 * whose author was not describing what happened.
 */
export function buildCapabilityProbeRecord(input: {
  readonly outcome: CapabilityOutcome
  readonly rawError?: string
  readonly timestamp: string
  readonly projectRef: string
}): CapabilityProbeRecord {
  const error = sanitizeProbeError(input.rawError ?? '')
  if (input.outcome === 'CAPABILITY_PROBE_CREATE_SUCCEEDED' && error !== '') {
    throw new Error(
      'CAPABILITY_RECORD_INCONSISTENT: a SUCCEEDED outcome carries an error message. One of the two is ' +
        'wrong, and a record that contradicts itself is worse than no record.',
    )
  }
  if (input.outcome === 'CAPABILITY_PROBE_CREATE_FAILED' && error === '') {
    throw new Error(
      'CAPABILITY_RECORD_INCONSISTENT: a FAILED outcome carries no error text. The message is the entire ' +
        'diagnostic value of a failure — "must be owner of table objects" and a network timeout mean ' +
        'opposite things about the channel.',
    )
  }
  if (KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(input.projectRef)) {
    throw new Error(
      `CAPABILITY_RECORD_REFUSED: the record names ${input.projectRef}, a KNOWN PRODUCTION project.`,
    )
  }
  return {
    outcome: input.outcome,
    error,
    timestamp: input.timestamp,
    projectRef: input.projectRef,
    policyName: CAPABILITY_PROBE_POLICY,
  }
}

/**
 * What a CREATE outcome licenses, and — the important half — what it does not.
 */
export function interpretCapabilityOutcome(record: CapabilityProbeRecord): {
  readonly managementPlanePath: 'REJECTED' | 'CAPABILITY_DEMONSTRATED_PENDING_CLEANUP'
  readonly canonicalPoliciesProven: false
  readonly detail: string
} {
  if (record.outcome === 'CAPABILITY_PROBE_CREATE_FAILED') {
    return {
      managementPlanePath: 'REJECTED',
      canonicalPoliciesProven: false,
      detail:
        `the deployed channel cannot create a policy on storage.objects that depends on nothing: ` +
        `${record.error || '(no message recorded)'}. Every alternative reading is closed — the predicate ` +
        `references no helper, no bucket and no function, so 42883 and a missing bucket are not available ` +
        `explanations. DO NOT retry through service_role, supabase_privileged_role, authenticator, ` +
        `ALTER OWNER, GRANT, SET ROLE or BYPASSRLS. Escalate to Supabase support with this record.`,
    }
  }
  return {
    managementPlanePath: 'CAPABILITY_DEMONSTRATED_PENDING_CLEANUP',
    // THE DISTINCTION THE WHOLE PROBE EXISTS TO PRESERVE.
    canonicalPoliciesProven: false,
    detail:
      'the deployed channel CAN create a policy on storage.objects. That is a fact about the channel and ' +
      'nothing else: the three Uellix policies call helpers PART A creates, filter on a bucket that does ' +
      'not exist yet, and have not been attempted. Capability is not correctness, and this record must ' +
      'never be cited as evidence that the storage surface is installed. Not complete until cleanup is ' +
      'verified.',
  }
}

/* -------------------------------------------------------------------------- */
/* Postcondition and cleanup                                                  */
/* -------------------------------------------------------------------------- */

export interface ObservedPolicyRow {
  readonly schemaname: string
  readonly tablename: string
  readonly policyname: string
  readonly permissive: string
  readonly roles: string
  readonly cmd: string
  readonly qual: string | null
  readonly withCheck: string | null
}

const normalize = (p: string | null): string =>
  (p ?? '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '')
    .trim()
    .toLowerCase()

/**
 * EQUALITY on every column the contract names.
 *
 * Not `EXISTS(policyname)`, and not containment. A probe verified by its name
 * alone would be satisfied by a policy called
 * `uellix_tmp_capability_probe_20260807` with `USING (true)` — which is the exact
 * failure this repository already found in B0-16 and has no excuse to repeat in
 * a file written afterwards.
 */
export function verifyCapabilityProbeSurface(observed: readonly ObservedPolicyRow[]): CapabilityVerdict {
  const problems: string[] = []
  const found = observed.find(
    (p) =>
      p.schemaname === CAPABILITY_PROBE_TARGET.schema &&
      p.tablename === CAPABILITY_PROBE_TARGET.table &&
      p.policyname === CAPABILITY_PROBE_POLICY,
  )
  if (!found) {
    return {
      ok: false,
      problems: [`${CAPABILITY_PROBE_POLICY} is absent from storage.objects, so the CREATE did not take effect.`],
    }
  }
  if (found.cmd.toUpperCase() !== 'SELECT') {
    problems.push(`cmd is ${found.cmd}, expected SELECT.`)
  }
  // PERMISSIVE, checked explicitly. A RESTRICTIVE policy with USING (false)
  // would DENY every read of storage.objects for this role — the probe would
  // have taken the project's Storage down while reporting success.
  if (found.permissive.toUpperCase() !== 'PERMISSIVE') {
    problems.push(
      `permissive is ${found.permissive}, expected PERMISSIVE. A RESTRICTIVE policy with USING (false) is ` +
        `ANDed into whatever the permissive policies admit, so it can only ever REMOVE access for ` +
        `${CAPABILITY_PROBE_ROLE} — and once the canonical policies exist it removes all of it. It is not ` +
        `the security-monotone probe that was designed.`,
    )
  }
  if (found.roles.replace(/\s/g, '') !== `{${CAPABILITY_PROBE_ROLE}}`) {
    problems.push(`roles are ${found.roles}, expected {${CAPABILITY_PROBE_ROLE}}.`)
  }
  if (normalize(found.qual) !== 'false') {
    problems.push(
      `qual is '${normalize(found.qual)}', expected 'false'. Anything else means the policy that was ` +
        `created is not the security-monotone one that was designed.`,
    )
  }
  if (normalize(found.withCheck) !== '') {
    problems.push(`with_check is '${normalize(found.withCheck)}', expected NULL. A SELECT policy has no WITH CHECK.`)
  }
  return { ok: problems.length === 0, problems }
}

export type CleanupOutcome =
  | 'CAPABILITY_PROBE_CLEANED'
  | 'BLOCKED_MANAGEMENT_CHANNEL_CLEANUP'

/**
 * Cleanup is verified by the catalogue, and by MORE than the probe's absence.
 *
 * A DROP that removed the probe AND something else leaves the probe absent, so
 * absence alone cannot distinguish a clean removal from a destructive one. The
 * pre-probe inventory is what makes the difference observable.
 */
export function verifyCapabilityCleanup(input: {
  readonly before: readonly ObservedPolicyRow[]
  readonly after: readonly ObservedPolicyRow[]
}): { readonly outcome: CleanupOutcome; readonly problems: readonly string[] } {
  const problems: string[] = []
  const beforeNames = input.before.map((p) => p.policyname)
  const afterByName = new Map(input.after.map((p) => [p.policyname, p]))

  if (afterByName.has(CAPABILITY_PROBE_POLICY)) {
    problems.push(
      `${CAPABILITY_PROBE_POLICY} is STILL PRESENT on storage.objects. A channel that can create a policy ` +
        `and cannot remove it leaves this project permanently carrying an artefact of a measurement.`,
    )
  }
  for (const was of input.before) {
    const now = afterByName.get(was.policyname)
    if (!now) {
      problems.push(
        `cleanup also removed the pre-existing policy ${was.policyname}. The probe was supposed to be the ` +
          `only thing that changed.`,
      )
      continue
    }
    // FULL ROWS, NOT NAMES.
    //
    // Adversarial review: comparing name SETS passes a cleanup that dropped and
    // recreated a pre-existing policy with a different predicate — the names are
    // identical, so the set is identical. The operator already captures whole
    // rows in steps 0 and 12; discarding everything but the name was throwing
    // away the evidence that answers the question.
    for (const field of ['permissive', 'roles', 'cmd', 'qual', 'withCheck'] as const) {
      if (normalize(String(now[field] ?? '')) !== normalize(String(was[field] ?? ''))) {
        problems.push(
          `the pre-existing policy ${was.policyname} survived by NAME but its ${field} changed ` +
            `(${String(was[field])} → ${String(now[field])}). Cleanup altered a policy it did not create.`,
        )
      }
    }
  }
  const added = input.after.filter(
    (p) => p.policyname !== CAPABILITY_PROBE_POLICY && !beforeNames.includes(p.policyname),
  )
  if (added.length > 0) {
    problems.push(
      `storage.objects gained ${added.length} unexpected polic(y|ies): ${added.map((p) => p.policyname).join(', ')}. ` +
        `A platform channel that renames or suffixes what it creates would show up here.`,
    )
  }

  return {
    outcome: problems.length === 0 ? 'CAPABILITY_PROBE_CLEANED' : 'BLOCKED_MANAGEMENT_CHANNEL_CLEANUP',
    problems,
  }
}

/**
 * The record and the catalogue must agree, and the record is the weaker witness.
 *
 * Adversarial review's scenario, which is entirely plausible: the platform UI
 * times out AFTER the server committed the CREATE. The operator records FAILED,
 * `interpretCapabilityOutcome` answers REJECTED and "escalate to Supabase
 * support" — while the postcondition of step 10 shows the policy sitting there.
 * Nothing took both inputs, so the contradiction depended on a human noticing it.
 */
export function reconcileCapabilityRecord(input: {
  readonly record: CapabilityProbeRecord
  readonly observed: readonly ObservedPolicyRow[]
}): CapabilityVerdict {
  const present = input.observed.some(
    (p) =>
      p.schemaname === CAPABILITY_PROBE_TARGET.schema &&
      p.tablename === CAPABILITY_PROBE_TARGET.table &&
      p.policyname === CAPABILITY_PROBE_POLICY,
  )
  if (input.record.outcome === 'CAPABILITY_PROBE_CREATE_FAILED' && present) {
    return {
      ok: false,
      problems: [
        `the record says the CREATE FAILED and ${CAPABILITY_PROBE_POLICY} EXISTS in pg_policies. The most ` +
          `likely cause is a channel that timed out after the server committed. Do NOT conclude REJECTED ` +
          `from this record — the catalogue says the channel worked, and the policy must still be cleaned up.`,
      ],
    }
  }
  if (input.record.outcome === 'CAPABILITY_PROBE_CREATE_SUCCEEDED' && !present) {
    return {
      ok: false,
      problems: [
        `the record says the CREATE SUCCEEDED and ${CAPABILITY_PROBE_POLICY} is absent from pg_policies. ` +
          `Either the channel reported a success it did not perform, or it created the policy under a ` +
          `different name — some Studio builds suffix generated policy names.`,
      ],
    }
  }
  return { ok: true, problems: [] }
}

/* -------------------------------------------------------------------------- */
/* The operator's script                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic steps. The operator reads values, they do not compose them.
 *
 * NOT AUTHORIZED BY THIS MODULE. This is the text of a boundary, not its
 * opening; `evaluateCapabilityPrecondition` decides whether it may be run, and a
 * human decides whether it is run at all.
 */
export const CAPABILITY_PROBE_OPERATOR_STEPS: readonly string[] = [
  '0. PRECONDITION — run CAPABILITY_PROBE_PRECONDITION_SQL inside `BEGIN READ ONLY; … ROLLBACK;`. It is ' +
    'TWO statements: record existing_policy_count from the first, and the WHOLE ROWS from the second ' +
    'into `precondition.existingPolicyRows` (names alone let cleanup verification degrade to a name ' +
    'comparison, which cannot see a drop-and-recreate with a changed predicate).',
  '1. Confirm the project selector shows the STAGING project. A capability probe is a write.',
  '2. Dashboard → Storage → Policies → the OBJECTS table → New policy → "For full customization".',
  `3. Policy name: ${CAPABILITY_PROBE_POLICY}`,
  '4. Allowed operation: SELECT only. Leave INSERT, UPDATE and DELETE unchecked.',
  `5. Target roles: ${CAPABILITY_PROBE_ROLE} only.`,
  '6. Policy definition (the USING expression): false',
  '7. Leave the WITH CHECK expression EMPTY. A SELECT policy has none.',
  '8. Confirm the form says PERMISSIVE, not RESTRICTIVE. RESTRICTIVE with false denies every read.',
  '9. Save. Record ONLY: succeeded/failed, the sanitized error text, the timestamp, the project ref ' +
    'and the policy name. Never a key, a token or a connection string.',
  '10. POSTCONDITION — run CAPABILITY_PROBE_POSTCONDITION_SQL read-only and keep the full row.',
  `11. CLEANUP — delete ${CAPABILITY_PROBE_POLICY} through the same Dashboard channel.`,
  '12. CLEANUP POSTCONDITION — run CAPABILITY_PROBE_POSTCONDITION_SQL again. The probe must be absent ' +
    'AND every policy recorded in step 0 must still be there.',
  '13. STOP. Do not create the canonical Uellix policies in the same session: they need unit 41 PART A, ' +
    'which has not been applied.',
]

/* -------------------------------------------------------------------------- */
/* The artefact, so the result cannot be a claim in a chat message             */
/* -------------------------------------------------------------------------- */

/** Where the operator records what happened. Absent until the probe is run. */
export const CAPABILITY_PROBE_ARTEFACT = 'artifacts/hosted-capability-probe.json'
/** Where the derived verdict is written, so a report can only quote it. */
export const CAPABILITY_PROBE_STATUS_ARTEFACT = 'artifacts/hosted-capability-probe-status.json'

export interface CapabilityProbeArtefact {
  readonly precondition?: Partial<CapabilityPrecondition> & {
    /**
     * The pre-probe policies as WHOLE ROWS, when the operator captured them.
     *
     * Names alone let cleanup verification degrade to a name comparison, which
     * cannot see a drop-and-recreate with a changed predicate. Optional because
     * the operator may only have recorded names — and when they did, the
     * evaluation says so instead of quietly claiming the stronger check ran.
     */
    readonly existingPolicyRows?: readonly ObservedPolicyRow[]
  }
  readonly record?: { readonly outcome?: string; readonly rawError?: string; readonly timestamp?: string; readonly projectRef?: string }
  /** pg_policies rows, from CAPABILITY_PROBE_POSTCONDITION_SQL, after CREATE. */
  readonly afterCreate?: readonly ObservedPolicyRow[]
  /** The same query again, after the cleanup step. */
  readonly afterCleanup?: readonly ObservedPolicyRow[]
}

export type CapabilityProbeState =
  | 'CAPABILITY_PROBE_NOT_RUN'
  | 'CAPABILITY_PROBE_PRECONDITION_REFUSED'
  | 'CAPABILITY_PROBE_CREATE_FAILED'
  | 'CAPABILITY_PROBE_SURFACE_MISMATCH'
  | 'CAPABILITY_PROBE_INCONSISTENT_RECORD'
  | 'BLOCKED_MANAGEMENT_CHANNEL_CLEANUP'
  | 'CAPABILITY_PROBE_COMPLETE'

/**
 * The whole chain, evaluated from a recorded artefact. Refuses at the first gap.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND NOT JUST THE SIX FUNCTIONS ABOVE
 * ---------------------------------------------------------------------------
 * Adversarial review: every function in this module was imported by its test and
 * by nothing else. So when the operator eventually ran the probe and pasted the
 * result somewhere, a HUMAN would have had to remember to call them — which is
 * the "a report and a gate diverge while two objects can answer the same
 * question" defect that the sibling module in this very commit exists to fix.
 * The probe result gets the same treatment as the apply verdict: an artefact, a
 * derived status, and a test that regenerates and compares.
 *
 * `null` — the artefact does not exist — is NOT_RUN, not a pass.
 */
export function evaluateCapabilityProbeArtefact(artefact: CapabilityProbeArtefact | null): {
  readonly state: CapabilityProbeState
  readonly problems: readonly string[]
  readonly canonicalPoliciesProven: false
} {
  const out = (state: CapabilityProbeState, problems: readonly string[] = []) => ({
    state,
    problems,
    canonicalPoliciesProven: false as const,
  })

  if (artefact === null) {
    return out('CAPABILITY_PROBE_NOT_RUN', [
      `${CAPABILITY_PROBE_ARTEFACT} does not exist. The probe has not been run, which is not the same as ` +
        `the channel having failed and not the same as it having worked.`,
    ])
  }

  const pre = evaluateCapabilityPrecondition({
    projectRef: artefact.precondition?.projectRef ?? '',
    declaredEnvironment: artefact.precondition?.declaredEnvironment ?? '',
    tableExists: artefact.precondition?.tableExists ?? null,
    rlsEnabled: artefact.precondition?.rlsEnabled ?? null,
    probeAlreadyPresent: artefact.precondition?.probeAlreadyPresent ?? null,
    existingPolicyCount: artefact.precondition?.existingPolicyCount ?? null,
    existingPolicyNames: artefact.precondition?.existingPolicyNames ?? null,
  })
  if (!pre.ok) return out('CAPABILITY_PROBE_PRECONDITION_REFUSED', pre.problems)

  const raw = artefact.record
  if (raw?.outcome !== 'CAPABILITY_PROBE_CREATE_SUCCEEDED' && raw?.outcome !== 'CAPABILITY_PROBE_CREATE_FAILED') {
    return out('CAPABILITY_PROBE_NOT_RUN', ['the artefact records no valid CREATE outcome.'])
  }
  let record: CapabilityProbeRecord
  try {
    record = buildCapabilityProbeRecord({
      outcome: raw.outcome,
      rawError: raw.rawError,
      timestamp: raw.timestamp ?? '',
      projectRef: raw.projectRef ?? '',
    })
  } catch (error) {
    return out('CAPABILITY_PROBE_INCONSISTENT_RECORD', [(error as Error).message])
  }

  const afterCreate = artefact.afterCreate ?? null
  if (afterCreate === null) {
    return out('CAPABILITY_PROBE_INCONSISTENT_RECORD', [
      'no pg_policies observation after the CREATE. The record alone is the weaker witness, and the ' +
        'postcondition is what makes it checkable.',
    ])
  }
  const agree = reconcileCapabilityRecord({ record, observed: afterCreate })
  if (!agree.ok) return out('CAPABILITY_PROBE_INCONSISTENT_RECORD', agree.problems)

  if (record.outcome === 'CAPABILITY_PROBE_CREATE_FAILED') {
    return out('CAPABILITY_PROBE_CREATE_FAILED', [interpretCapabilityOutcome(record).detail])
  }

  const surface = verifyCapabilityProbeSurface(afterCreate)
  if (!surface.ok) return out('CAPABILITY_PROBE_SURFACE_MISMATCH', surface.problems)

  const afterCleanup = artefact.afterCleanup ?? null
  if (afterCleanup === null) {
    return out('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP', [
      'the CREATE succeeded and no post-cleanup observation exists. The probe is not complete until the ' +
        'policy is demonstrably gone.',
    ])
  }
  // FULL ROWS WHEN THE OPERATOR CAPTURED THEM, NAMES WHEN THEY DID NOT — AND THE
  // DIFFERENCE IS STATED RATHER THAN HIDDEN.
  //
  // `verifyCapabilityCleanup` compares whole rows precisely so a cleanup that
  // dropped and recreated a pre-existing policy with a different predicate cannot
  // pass on an identical name SET. That protection is only real if the BEFORE
  // side holds real rows. The first version reconstructed `before` from names
  // with blank fields and then blanked the `after` side to match — silencing the
  // field comparison exactly when there WERE pre-existing policies to protect.
  //
  // So `existingPolicyRows` is preferred when present, and its absence is
  // reported as a reduction in what cleanup was able to verify.
  const beforeRows = artefact.precondition?.existingPolicyRows ?? null
  const beforeNames = artefact.precondition?.existingPolicyNames ?? []
  const degraded = beforeRows === null && beforeNames.length > 0
  const blank = (p: ObservedPolicyRow): ObservedPolicyRow => ({
    ...p,
    permissive: '',
    roles: '',
    cmd: '',
    qual: null,
    withCheck: null,
  })
  const before: readonly ObservedPolicyRow[] =
    beforeRows ??
    beforeNames.map((policyname) =>
      blank({
        schemaname: 'storage',
        tablename: 'objects',
        policyname,
        permissive: '',
        roles: '',
        cmd: '',
        qual: null,
        withCheck: null,
      }),
    )
  const cleaned = verifyCapabilityCleanup({
    before,
    after: degraded ? afterCleanup.map(blank) : afterCleanup,
  })
  if (cleaned.outcome !== 'CAPABILITY_PROBE_CLEANED') {
    return out('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP', cleaned.problems)
  }

  // The interpretation ends with "not complete until cleanup is verified", which
  // is true in general and misleading HERE — cleanup has just been verified. The
  // clause that must survive into this state is the other one: capability is not
  // correctness. Saying so explicitly beats letting a reader carry the wrong half.
  return out('CAPABILITY_PROBE_COMPLETE', [
    interpretCapabilityOutcome(record).detail,
    ...(degraded
      ? [
          `CLEANUP VERIFIED BY NAME ONLY: the precondition recorded ${beforeNames.length} pre-existing ` +
            `policy name(s) but not their rows, so a cleanup that dropped and recreated one with a ` +
            `different predicate would not have been caught. Record existingPolicyRows to close that.`,
        ]
      : []),
    `CLEANUP VERIFIED: ${CAPABILITY_PROBE_POLICY} is absent from pg_policies and every policy recorded ` +
      `before the probe is still present. The channel is demonstrated; the three canonical Uellix ` +
      `policies remain NOT installed, and MANAGED_BOUNDARY_VERIFIED stays false until pg_policies shows ` +
      `their surface.`,
  ])
}

/** What must NEVER be attempted if the probe fails. Enumerated so it is testable. */
export const CAPABILITY_PROBE_FORBIDDEN_FALLBACKS: readonly string[] = [
  'service_role',
  'supabase_privileged_role',
  'authenticator',
  'SET ROLE',
  'ALTER TABLE ... OWNER TO',
  'GRANT of a platform-managed role',
  'BYPASSRLS',
  'ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY',
]
