// db/hosted/checkpoint-b0.ts
//
// THE WIRE FOR CHECKPOINT B0, AND IT WAS THE FIFTH TIME.
//
// ---------------------------------------------------------------------------
// WHAT WAS MISSING
// ---------------------------------------------------------------------------
// `evaluateBaselinePostconditions` — the canonical B0 evaluator, with an
// executable negative control per check — had exactly two consumers: its own
// test, and `scripts/baseline-rehearsal-local.ts`, which is localhost-only BY
// DESIGN and must stay that way. Nothing could run B0 against the hosted
// project. The baseline could finish, every unit could verify, and the
// checkpoint that audits the WHOLE result had no route to the database it was
// written to audit.
//
// That is the same defect this programme has now found five times:
// `journalInsertSql` with no caller, the capability-probe functions imported
// only by their own test, `reconcileStorageBoundary` with zero production
// callers, `loadMeasuredEvidence` hardcoding `managedBoundaryVerified: false`,
// and now this. The fix is the pattern that already works: an artefact the
// operator fills from read-only queries, a pure evaluator over it, a status
// script, and a `:verify` that recomputes and compares.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS NOT
// ---------------------------------------------------------------------------
// It is NOT a second B0. The sixteen — now eighteen — checks stay exactly where
// they are, in `BASELINE_POSTCONDITIONS`, and this module calls them. Anything
// that judged the baseline here would be the parallel implementation the
// instruction forbids and the divergence this repository keeps paying for.

import {
  BASELINE_POSTCONDITIONS,
  evaluateBaselinePostconditions,
  type BaselineObservation,
  type ExpectedBaselineState,
  type ObservedStoragePolicy,
} from './baseline-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from './target-identity'

/** Where the operator records the read-only observation. Versioned, committed. */
export const B0_OBSERVATION_ARTEFACT = 'artifacts/hosted-b0-observation.json'
/** Where the derived verdict is written, so a report can only quote it. */
export const B0_STATUS_ARTEFACT = 'artifacts/hosted-b0-status.json'
/** The read-only SQL that produces the observation. Generated, byte-verified. */
export const B0_OBSERVATION_SQL = 'db/prepared/checkpoint-b0/observation.sql'

export type B0RefusalCode =
  | 'B0_OBSERVATION_ABSENT'
  | 'B0_OBSERVATION_MALFORMED'
  | 'B0_OBSERVATION_PROJECT_REF_MISSING'
  | 'B0_OBSERVATION_PRODUCTION_REF'
  | 'B0_OBSERVATION_PROJECT_REF_MISMATCH'
  | 'B0_OBSERVATION_INCOMPLETE'
  | 'B0_OBSERVATION_CARRIES_SECRET'

export interface B0Refusal {
  readonly ok: false
  readonly code: B0RefusalCode
  readonly detail: string
}

export interface B0Observation {
  readonly ok: true
  readonly projectRef: string
  readonly measuredOn: string | null
  readonly observation: BaselineObservation
}

/** Every field `BaselineObservation` requires. Absence is refused, never defaulted. */
const REQUIRED_FIELDS = [
  'schemas', 'tables', 'columns', 'constraints', 'functions', 'triggers',
  'rlsEnabledTables', 'policies', 'roles', 'grants', 'rowCounts', 'extensions',
  'storageBuckets', 'storagePolicies', 'functionGrants', 'journal',
] as const

/**
 * A value that looks like a credential rather than a name.
 *
 * B0-14 asks for secret NAMES. An operator pasting a VALUE would put a live
 * credential into a committed artefact, so the shapes are refused outright
 * rather than trusted to a review that happens after the commit.
 */
const SECRET_SHAPED = /(^eyJ[A-Za-z0-9_-]{10,})|(:\/\/[^\s/]*:[^\s@]*@)|(^sb[a-z]*_[A-Za-z0-9]{16,})|([A-Za-z0-9+/]{40,}={0,2}$)/

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Parses the recorded observation, or refuses.
 *
 * FAIL-CLOSED AT EVERY STEP. A missing file, unparseable JSON, an absent field,
 * an unbound project ref, a ref on the production denylist, or anything shaped
 * like a credential each produce a refusal with its own code. Nothing is
 * defaulted: a `null` that silently became `[]` would turn "we did not measure"
 * into "we measured nothing", which are opposite claims.
 */
export function parseB0Observation(
  raw: string | null,
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  production = KNOWN_PRODUCTION_IDENTIFIERS,
): B0Observation | B0Refusal {
  if (raw === null) {
    return {
      ok: false,
      code: 'B0_OBSERVATION_ABSENT',
      detail: `${B0_OBSERVATION_ARTEFACT} does not exist. CHECKPOINT B0 has not been observed, which is not the same as it having failed — and not the same as it having passed.`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'B0_OBSERVATION_MALFORMED', detail: `${B0_OBSERVATION_ARTEFACT} is not valid JSON.` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'B0_OBSERVATION_MALFORMED', detail: `${B0_OBSERVATION_ARTEFACT} is not a JSON object.` }
  }
  const o = parsed as Record<string, unknown>

  // TARGET BINDING FIRST, and the production veto before the match. An
  // observation of another database is not weaker evidence about this one — it
  // is evidence about something else.
  const ref = typeof o.projectRef === 'string' ? o.projectRef.trim() : ''
  if (ref === '') {
    return {
      ok: false,
      code: 'B0_OBSERVATION_PROJECT_REF_MISSING',
      detail: `${B0_OBSERVATION_ARTEFACT} declares no projectRef. An unattributed observation could describe any database.`,
    }
  }
  if (production.projectRefs.includes(ref)) {
    return {
      ok: false,
      code: 'B0_OBSERVATION_PRODUCTION_REF',
      detail: `${B0_OBSERVATION_ARTEFACT} was recorded against ${ref}, a KNOWN PRODUCTION project. No other passing field outvotes this.`,
    }
  }
  if (ref !== targetProjectRef) {
    return {
      ok: false,
      code: 'B0_OBSERVATION_PROJECT_REF_MISMATCH',
      detail: `${B0_OBSERVATION_ARTEFACT} was recorded against ${ref}; the target is ${targetProjectRef}.`,
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in o))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'B0_OBSERVATION_INCOMPLETE',
      detail: `${B0_OBSERVATION_ARTEFACT} is missing ${missing.length} field(s): ${missing.join(', ')}. A partial observation is refused, not filled in.`,
    }
  }
  // `environmentSecretNames` is the one field allowed to be null: B0-14 is not a
  // database question, and null means NOT INVENTORIED — which B0-14 then fails.
  const secretNames = o.environmentSecretNames
  if (secretNames !== null && secretNames !== undefined && !isStringArray(secretNames)) {
    return {
      ok: false,
      code: 'B0_OBSERVATION_MALFORMED',
      detail: 'environmentSecretNames must be an array of NAMES or null.',
    }
  }
  for (const name of (secretNames as string[] | null | undefined) ?? []) {
    if (SECRET_SHAPED.test(name)) {
      return {
        ok: false,
        code: 'B0_OBSERVATION_CARRIES_SECRET',
        detail: 'environmentSecretNames holds a value shaped like a credential, not a name. B0-14 records NAMES only.',
      }
    }
  }

  return {
    ok: true,
    projectRef: ref,
    measuredOn: typeof o.measuredOn === 'string' ? o.measuredOn : null,
    observation: {
      schemas: o.schemas as string[],
      tables: o.tables as string[],
      columns: o.columns as Record<string, string[]>,
      constraints: o.constraints as string[],
      functions: o.functions as string[],
      triggers: o.triggers as string[],
      rlsEnabledTables: o.rlsEnabledTables as string[],
      policies: o.policies as string[],
      roles: o.roles as string[],
      grants: o.grants as string[],
      rowCounts: o.rowCounts as Record<string, number>,
      extensions: o.extensions as string[],
      storageBuckets: o.storageBuckets as string[],
      storagePolicies: o.storagePolicies as ObservedStoragePolicy[],
      environmentSecretNames: (secretNames as string[] | null | undefined) ?? null,
      functionGrants: o.functionGrants as string[],
      journal: o.journal as BaselineObservation['journal'],
    },
  }
}

/**
 * The read-only SQL that produces the observation.
 *
 * GENERATED FROM THE CORPUS, not hand-written, because `rowCounts` needs one
 * arm per table the fifty units create — and a hand-maintained list would drift
 * from the manifest the first time a unit is added. `b0:observation:verify`
 * regenerates and compares bytes, exactly like the journal wrappers.
 *
 * EVERY SECTION GETS ITS OWN TRANSACTION. With one, the first error aborts the
 * block and psql discards everything after it with "current transaction is
 * aborted" — an incomplete measurement that reads like nothing to measure. Here
 * a failure costs its own statement and nothing else.
 *
 * `SET LOCAL search_path = ''` for the same reason the storage probe uses it:
 * `pg_get_expr` omits a function's schema when that schema is visible, and an
 * observation whose representation depends on the observer is not a measurement.
 */
export function buildB0ObservationSql(expectedTables: readonly string[]): string {
  const ident = (q: string): string => q.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.')
  const rowCountArms = expectedTables
    .map((t) => `    SELECT '${t}' AS t, count(*) AS n FROM ${ident(t)}`)
    .join('\n    UNION ALL\n')

  return `-- ============================================================================
-- GENERATED — DO NOT EDIT. CHECKPOINT B0 observation.
-- Regenerate with \`pnpm b0:observation:generate\`; \`pnpm b0:observation:verify\`
-- compares bytes. The rowCounts arms come from the corpus, so this file cannot
-- drift from the manifest.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Every statement runs in
-- its own READ ONLY transaction that rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -f ${B0_OBSERVATION_SQL}
--
-- The output is the BaselineObservation the eighteen canonical postconditions
-- consume. \`projectRef\` is supplied by the operator through -v, the same way
-- the journal wrappers take it: nothing server-side reports a Supabase project
-- ref, so it cannot be derived in band.
--
-- environmentSecretNames is emitted as null ON PURPOSE. B0-14 is not a question
-- PostgreSQL can answer, and null means NOT INVENTORIED — which B0-14 fails.
-- ============================================================================
\\if :{?uellix_project_ref}
\\else
\\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\\echo 'An unattributed observation could describe any database.'
\\quit
\\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(

  'projectRef', :'uellix_project_ref',

  'schemas', (SELECT coalesce(jsonb_agg(nspname ORDER BY nspname), '[]'::jsonb)
              FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%'),

  'tables', (SELECT coalesce(jsonb_agg(schemaname || '.' || tablename ORDER BY schemaname, tablename), '[]'::jsonb)
             FROM pg_catalog.pg_tables WHERE schemaname = 'public'),

  'columns', (SELECT coalesce(jsonb_object_agg(tbl, cols), '{}'::jsonb) FROM (
                SELECT table_schema || '.' || table_name AS tbl,
                       jsonb_agg(column_name ORDER BY column_name) AS cols
                FROM information_schema.columns WHERE table_schema = 'public'
                GROUP BY 1) c),

  'constraints', (SELECT coalesce(jsonb_agg(conname ORDER BY conname), '[]'::jsonb)
                  FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
                  WHERE n.nspname = 'public'),

  'functions', (SELECT coalesce(jsonb_agg(DISTINCT n.nspname || '.' || p.proname), '[]'::jsonb)
                FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'),

  'triggers', (SELECT coalesce(jsonb_agg(DISTINCT tgname), '[]'::jsonb)
               FROM pg_catalog.pg_trigger WHERE NOT tgisinternal),

  'rlsEnabledTables', (SELECT coalesce(jsonb_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname), '[]'::jsonb)
                       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.relkind IN ('r','p') AND c.relrowsecurity AND n.nspname = 'public'),

  'policies', (SELECT coalesce(jsonb_agg(schemaname || '.' || tablename || '.' || policyname
                        ORDER BY schemaname, tablename, policyname), '[]'::jsonb)
               FROM pg_catalog.pg_policies WHERE schemaname IN ('public','storage')),

  'roles', (SELECT coalesce(jsonb_agg(rolname ORDER BY rolname), '[]'::jsonb) FROM pg_catalog.pg_roles),

  -- B0-10: exactly what that check asks — anon and PUBLIC table privileges in
  -- public. Effective ACL, so a relation never REVOKEd reports what it grants.
  'grants', (SELECT coalesce(jsonb_agg(g ORDER BY g), '[]'::jsonb) FROM (
               SELECT COALESCE(pg_catalog.pg_get_userbyid(a.grantee), 'PUBLIC') || ':' || a.privilege_type
                      || ':' || n.nspname || '.' || c.relname AS g
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
               WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
                 AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) = 'anon')) x),

  -- B0-17: the effect unit 042 has and the per-unit runner could not check.
  -- coalesce(proacl, acldefault(...)) so a NULL proacl reads as the implicit
  -- PUBLIC EXECUTE it really is, instead of as "no privilege".
  'functionGrants', (SELECT coalesce(jsonb_agg(g ORDER BY g), '[]'::jsonb) FROM (
                       SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                   ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                              || ':' || a.privilege_type || ':' || n.nspname || '.' || p.proname AS g
                       FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                       CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                       WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE') y),

  'rowCounts', (SELECT coalesce(jsonb_object_agg(t, n), '{}'::jsonb) FROM (
${rowCountArms}
  ) r),

  'extensions', (SELECT coalesce(jsonb_agg(extname ORDER BY extname), '[]'::jsonb) FROM pg_catalog.pg_extension),

  'storageBuckets', (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM storage.buckets),

  'storagePolicies', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'schemaname', schemaname, 'tablename', tablename, 'policyname', policyname,
                          'roles', roles::text, 'cmd', cmd, 'qual', qual, 'withCheck', with_check)
                          ORDER BY policyname), '[]'::jsonb)
                      FROM pg_catalog.pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'),

  -- B0-18: the SET, which no single-unit check ever looks at.
  'journal', (SELECT jsonb_build_object(
                'packages',     coalesce((SELECT jsonb_agg(package_id ORDER BY id) FROM uellix_provisioning.applied_units), '[]'::jsonb),
                'environments', coalesce((SELECT jsonb_agg(DISTINCT environment) FROM uellix_provisioning.applied_units), '[]'::jsonb),
                'projectRefs',  coalesce((SELECT jsonb_agg(DISTINCT project_ref) FROM uellix_provisioning.applied_units), '[]'::jsonb),
                'statuses',     coalesce((SELECT jsonb_agg(DISTINCT status) FROM uellix_provisioning.applied_units), '[]'::jsonb))),

  'environmentSecretNames', NULL
));

ROLLBACK;
`
}

export interface B0Verdict {
  readonly projectRef: string | null
  readonly observationPresent: boolean
  readonly checkCount: number
  readonly passedCount: number
  readonly failing: readonly { readonly id: string; readonly detail: string }[]
  readonly checkpointPassed: boolean
  readonly refusal: B0Refusal | null
}

/**
 * Runs the CANONICAL evaluator over a recorded observation.
 *
 * `expected` is derived from the corpus by the caller, with the same reader the
 * runner uses — so the expectation and the units that produced the database are
 * the same set by construction, and disagreement remains possible.
 */
export function evaluateB0(
  raw: string | null,
  expected: ExpectedBaselineState,
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
): B0Verdict {
  const parsed = parseB0Observation(raw, targetProjectRef)
  if (!parsed.ok) {
    return {
      projectRef: null,
      observationPresent: raw !== null,
      checkCount: BASELINE_POSTCONDITIONS.length,
      passedCount: 0,
      failing: [{ id: parsed.code, detail: parsed.detail }],
      checkpointPassed: false,
      refusal: parsed,
    }
  }
  const results = evaluateBaselinePostconditions(parsed.observation, expected)
  const failing = results.filter((r) => !r.passed).map((r) => ({ id: r.id, detail: r.detail }))
  return {
    projectRef: parsed.projectRef,
    observationPresent: true,
    checkCount: results.length,
    passedCount: results.length - failing.length,
    failing,
    checkpointPassed: failing.length === 0,
    refusal: null,
  }
}
