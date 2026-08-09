// db/hosted/class-c-observation.ts
//
// The read-only SQL that produces a Class-C evidence artefact.
//
// ---------------------------------------------------------------------------
// WHY THIS IS GENERATED FROM `CLASS_C_PROBES`
// ---------------------------------------------------------------------------
// `hosted-capability-preflight-ready` does not merely read the booleans — it
// requires the attestation to QUOTE each §2.7 query VERBATIM (whitespace
// normalized, case-insensitive), because a probe measured by a different query
// answers a different question. `SELECT has_table_privilege(current_user,
// 'public.users', 'SELECT')` contains every marker substring and is about the
// wrong table and the wrong privilege.
//
// So the recorded `sql` must be the canonical string. Hand-typing it into an
// artefact is exactly where a character goes missing, and the failure would be
// a refusal nobody could explain. Generating the probe FROM `CLASS_C_PROBES`
// makes drift impossible: the query the operator runs, the query recorded in
// the artefact, and the query the criterion demands are one string.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT MEASURE
// ---------------------------------------------------------------------------
// The apply-identity probes — current_user/session_user, MEMBER, USAGE, SET —
// live in their own artefact and are NOT re-measured here. Nothing about the
// applying identity changed, and re-recording facts from a second source would
// create two answers to one question, which is the divergence this programme
// keeps paying for.

import { CLASS_C_PROBES } from './hosted-provisioning-runner'

/** The generated probe. Versioned, byte-verified, never a temporary file. */
export const CLASS_C_OBSERVATION_SQL = 'db/prepared/class-c/observation.sql'

/** The three probes this artefact carries, in the order the criterion reads them. */
export const CLASS_C_EDITOR_PROBE_NAMES = [
  'canCreateTriggerOnAuthUsers',
  'ownsStorageObjects',
  'evidenceBucketExists',
] as const

const sqlFor = (name: string): string => {
  const found = CLASS_C_PROBES.find(([k]) => k === name)
  if (found === undefined) throw new Error(`CLASS_C_PROBES has no probe named ${name}`)
  return found[2]
}

const unitFor = (name: string): string => {
  const found = CLASS_C_PROBES.find(([k]) => k === name)
  if (found === undefined) throw new Error(`CLASS_C_PROBES has no probe named ${name}`)
  return found[1]
}

/** Escapes a value for embedding as a SQL string literal. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

export function buildClassCObservationSql(): string {
  const probeObjects = CLASS_C_EDITOR_PROBE_NAMES.map(
    (name) => `    jsonb_build_object(
      'name', ${lit(name)},
      'sql', ${lit(sqlFor(name))},
      'unit', ${lit(unitFor(name))},
      'observed', (${sqlFor(name)}))`,
  ).join(',\n')

  return `-- ============================================================================
-- GENERATED — DO NOT EDIT. Class-C evidence observation.
-- Regenerate with \`pnpm classc:observation:generate\`; \`pnpm classc:observation:verify\`
-- compares bytes.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Runs inside a READ ONLY
-- transaction and rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f ${CLASS_C_OBSERVATION_SQL}
--
-- EACH PROBE'S \`sql\` IS THE CANONICAL §2.7 STRING, emitted from CLASS_C_PROBES
-- rather than typed. \`hosted-capability-preflight-ready\` requires the
-- attestation to quote them VERBATIM, so the query the operator runs and the
-- query the criterion demands are one string by construction.
--
-- The apply-identity probes (current_user, MEMBER, USAGE, SET) are NOT
-- re-measured here: they have their own artefact, nothing about that identity
-- changed, and two artefacts answering one question is the divergence this
-- programme keeps paying for.
--
-- \`bucketDetail\` is recorded for AUDIT ONLY. The criterion consumes
-- \`evidenceBucketExists.observed\` and nothing else; the extra columns are here
-- so a reader can see what the bucket actually is, not so a gate can rest on
-- them silently.
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
  'targetProjectRef', :'uellix_project_ref',
  'targetRole', 'staging',
  'measuredBy', 'operator, psql session pooler, inside a READ ONLY transaction, from ${CLASS_C_OBSERVATION_SQL}',
  'note', 'Project refs are not secret. No credential, connection string or user data is recorded here. Every value below was measured by the query recorded beside it.',
  'probes', jsonb_build_array(
${probeObjects}
  ),
  'bucketDetail', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'public', public,
        'file_size_limit', file_size_limit, 'allowed_mime_types', allowed_mime_types)), '[]'::jsonb)
      FROM storage.buckets WHERE id = 'uellix-evidence'),
  'bucketsTotal', (SELECT count(*) FROM storage.buckets)
));

ROLLBACK;
`
}
