// db/hosted/authority/certification/remediation-probes.ts
// COMMIT 5.3 — the remediation witness and the source-state fingerprint, as
// TYPED documents the database builds itself.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL: THE CONSUMER, NOT THE WITNESS, WAS BROKEN
// ---------------------------------------------------------------------------
// Commit 5.2 shipped a correct witness — `classifyRemediation` reads catalog
// facts and has its own contract tests — and an ad-hoc certification READER that
// pulled those facts out of psql's tabular output with a field separator. That
// reader is where the integrated harness died, and the failure mode is worth
// naming because it is generic:
//
//   * `-F '\x1f'` moves the collision from `|` to `\x1f` and moves nothing else.
//     A value containing the separator still shears, and the shear is SILENT —
//     a row splits into the wrong number of fields and the columns after it are
//     read one position off. `proconfig` is already pipe-joined, an ACL is
//     comma-joined, and `prosrc` contains newlines, tabs and every byte a
//     separator could be.
//   * position-based column reading has no way to notice. `r[4]` is whatever
//     landed at index 4. A witness assembled that way reports facts about the
//     wrong fields and reports them confidently.
//
// So this file does not pick a safer separator. It removes the parsing step:
// the database builds ONE `jsonb` document, psql emits it as ONE cell,
// `JSON.parse` reads it, and a typed validator refuses anything that is not the
// shape it declares. There is no field order to get wrong because there are no
// fields in a row — there are named keys.
//
// The pattern is not new here. `prechainObservationSql` (Commit 5.1) already
// returns one `jsonb` cell for exactly this reason: the prechain gate has to
// reason across eight measurements at once and could not tolerate them arriving
// as eight round trips. This applies the same discipline to the remediation.
//
// ---------------------------------------------------------------------------
// FRESHNESS IS A BINDING, NOT A TIMESTAMP
// ---------------------------------------------------------------------------
// Every document below is built FOR ONE ATTEMPT, whose id is compiled into the
// SQL as a literal, so the SERVER echoes it inside the document it produces.
// The validator refuses a document whose echoed attempt is not the attempt the
// caller opened. Re-running yesterday's probe therefore cannot produce a fresh
// observation: it produces a document that names yesterday's attempt.
//
// This is `db/hosted/fresh-observation.ts`'s mechanism, deliberately reused
// rather than re-invented — see `db/hosted/remediation-attempt.ts` for the
// ledger half.

import { createHash } from 'node:crypto'

import {
  EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES,
  PRECHAIN_GRANTS,
  type PrechainGrant,
  type RemediationObservation,
} from '../../prechain-remediation'
import { ATTEMPT_ID_SHAPE } from '../../fresh-observation'
import { CAPABILITY_ROLES, HOSTED_INSTALLER, OWNER } from './prechain-authority-gate'

/** The witness envelope's version. A document that does not name it is not this format. */
export const REMEDIATION_WITNESS_SCHEMA = 'uellix.hosted.remediation.witness/1'

/** The source-state fingerprint's version. Same rule. */
export const REMEDIATION_SOURCE_STATE_SCHEMA = 'uellix.hosted.remediation.source-state/1'

/** Schemas whose ACL a remediation could disturb, and the one it borrows. */
export const FINGERPRINTED_SCHEMAS: readonly string[] = [
  'uellix_bootstrap',
  'public',
  'uellix_grounding',
  'uellix_stella',
  'uellix_stella_ops',
]

/**
 * The functions whose DEFINITION the remediation replaces or installs.
 *
 * Fingerprinted by the hash of `prosrc` rather than by presence: R7 dies AFTER
 * `CREATE OR REPLACE assert_hosted_capabilities`, and a rollback check that only
 * asked "does a function of that name exist" would pass while the project ran
 * the new body — the single most consequential thing this package changes.
 */
export const FINGERPRINTED_FUNCTIONS: readonly string[] = [
  'uellix_bootstrap.assert_hosted_capabilities(text)',
  'uellix_bootstrap.assert_capability_membership_topology(text,text)',
  'uellix_bootstrap.hosted_capability_report()',
]

export class RemediationTransportRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'RemediationTransportRefusal'
  }
}

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

function requireAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_PROBE_ATTEMPT_MALFORMED',
      `refusing to build a probe for attempt id ${JSON.stringify(attemptId)}: an attempt id is ` +
        `att_ followed by 32 hex characters. The id is compiled into SQL as a literal, and the ` +
        `shape is the reason no escaping is needed — there is no accepted input that could close ` +
        `the literal.`,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* The certified function body                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The text PostgreSQL will store in `prosrc`, extracted from the package that
 * writes it.
 *
 * `prosrc` is exactly the bytes between the dollar quotes — not the CREATE
 * statement, not the `AS $$` — so the extraction takes exactly that span. It is
 * read from the PINNED remediation SQL rather than transcribed, because a
 * transcription is a second spelling that drifts the first time the body moves.
 */
export function extractDollarQuotedBody(sql: string, functionHeader: string): string {
  const head = sql.indexOf(functionHeader)
  if (head === -1) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_BODY_HEADER_ABSENT',
      `${functionHeader} does not occur in the supplied SQL, so the body PostgreSQL will store ` +
        `cannot be derived. A hard-coded expectation here would be a second spelling of the body.`,
    )
  }
  const open = sql.indexOf('AS $$', head)
  if (open === -1) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_BODY_UNQUOTED',
      `${functionHeader} is not followed by an \`AS $$\` dollar-quoted body.`,
    )
  }
  const bodyStart = open + 'AS $$'.length
  const close = sql.indexOf('$$', bodyStart)
  if (close === -1) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_BODY_UNTERMINATED',
      `${functionHeader}'s dollar-quoted body is never closed.`,
    )
  }
  return sql.slice(bodyStart, close)
}

/**
 * The digest both sides compare, with carriage returns removed FIRST.
 *
 * A Windows checkout can hand psql CRLF, and PostgreSQL stores what it is given
 * — so the same body hashes differently depending on the machine that applied
 * it. Stripping CR on both sides makes the comparison a statement about the
 * body rather than about the checkout. (The harness also normalizes what it
 * sends; this is the half that survives a project someone else applied.)
 */
export function bodyDigest(body: string): string {
  return createHash('sha256').update(body.replace(/\r/g, ''), 'utf8').digest('hex')
}

/* -------------------------------------------------------------------------- */
/* The witness probe                                                           */
/* -------------------------------------------------------------------------- */

/** What `held` means for one grant, phrased the way PostgreSQL answers it. */
function grantPredicate(grant: PrechainGrant): string {
  const isFunction = grant.objectType === 'function'
  const resolvable = isFunction && !grant.object.endsWith('()') ? `${grant.object}()` : grant.object
  const resolve = isFunction
    ? `pg_catalog.to_regprocedure(${lit(resolvable)})`
    : `pg_catalog.to_regclass(${lit(resolvable)})`
  const fn = isFunction ? 'pg_catalog.has_function_privilege' : 'pg_catalog.has_table_privilege'
  // The grant option is asked for EXACTLY the privileges the package issues it
  // for. REFERENCES travels in the same statement and is never passed on, so
  // demanding the option for it would report a correct remediation as partial.
  const specs = grant.privileges.map((p) =>
    grant.withGrantOption && p !== 'REFERENCES' ? `${p} WITH GRANT OPTION` : p,
  )
  return specs
    .map((spec) => `(${resolve} IS NOT NULL AND ${fn}(${lit(grant.grantee)}, ${resolve}, ${lit(spec)}))`)
    .join(' AND ')
}

/**
 * Everything `classifyRemediation` consumes, as ONE row of ONE jsonb column.
 *
 * The grant inventory is COMPILED FROM `PRECHAIN_GRANTS`, so the probe cannot
 * measure a different set from the one the package issues and the offline test
 * asserts. Adding a grant to the package and forgetting the probe is not a
 * silent pass — the probe simply asks about it too.
 */
export function buildRemediationWitnessSql(
  attemptId: string,
  expectedBodyDigest: string,
  grants: readonly PrechainGrant[] = PRECHAIN_GRANTS,
  capabilityRoles: readonly string[] = CAPABILITY_ROLES,
): string {
  requireAttemptId(attemptId)

  const ownerGrants = grants.filter((g) => g.grantee === OWNER)
  const installerGrants = grants.filter((g) => g.grantee === HOSTED_INSTALLER)
  if (ownerGrants.length === 0 || installerGrants.length === 0) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_PROBE_GRANT_SET_EMPTY',
      `the grant inventory contains no entry for ${OWNER} or none for ${HOSTED_INSTALLER}. A ` +
        `witness whose positive facts are vacuously true would classify every database INSTALLED.`,
    )
  }

  const conj = (list: readonly PrechainGrant[]): string =>
    list.map((g) => `(${grantPredicate(g)})`).join('\n         AND ')

  return `SET search_path = '';
SELECT jsonb_build_object(
  'schema', ${lit(REMEDIATION_WITNESS_SCHEMA)},
  'attemptId', ${lit(attemptId)},
  'observation', jsonb_build_object(
    'installerHasCreateRole', COALESCE((
      SELECT r.rolcreaterole FROM pg_catalog.pg_roles r WHERE r.rolname = ${lit(HOSTED_INSTALLER)}), false),
    'installerCanSetOwner', COALESCE((
      SELECT pg_catalog.pg_has_role(${lit(HOSTED_INSTALLER)}, ${lit(OWNER)}, 'SET')
      FROM pg_catalog.pg_roles WHERE rolname = ${lit(HOSTED_INSTALLER)}), false),
    'installerCanCreateInDatabase', COALESCE((
      SELECT pg_catalog.has_database_privilege(${lit(HOSTED_INSTALLER)}, pg_catalog.current_database(), 'CREATE')
      FROM pg_catalog.pg_roles WHERE rolname = ${lit(HOSTED_INSTALLER)}), false),
    'ownerHoldsE01Grants', (${conj(ownerGrants)}),
    'installerHoldsVisibilityGrants', (${conj(installerGrants)}),
    'topologyAssertionPresent',
      (pg_catalog.to_regprocedure('uellix_bootstrap.assert_capability_membership_topology(text,text)') IS NOT NULL),
    'capabilitiesBodyIsCertified', COALESCE((
      SELECT pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(pg_catalog.replace(p.prosrc, pg_catalog.chr(13), ''), 'UTF8')),
               'hex') = ${lit(expectedBodyDigest)}
      FROM pg_catalog.pg_proc p
      WHERE p.oid = pg_catalog.to_regprocedure('uellix_bootstrap.assert_hosted_capabilities(text)')), false),
    'bootstrapSchemaAcl', COALESCE((
      SELECT jsonb_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                     ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
      FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'uellix_bootstrap'), '[]'::jsonb),
    'capabilityRolesPresent', COALESCE((
      SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${capabilityRoles.map(lit).join(', ')})), '[]'::jsonb)
  )
)::text;`
}

/* -------------------------------------------------------------------------- */
/* The witness validator                                                       */
/* -------------------------------------------------------------------------- */

export interface RemediationWitnessDocument {
  readonly schema: string
  readonly attemptId: string
  readonly observation: RemediationObservation
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_MALFORMED',
      `${field} is ${JSON.stringify(value)}; the probe emits a JSON array of strings.`,
    )
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new RemediationTransportRefusal(
        'REMEDIATION_WITNESS_MALFORMED',
        `${field} contains ${JSON.stringify(entry)}, which is not a string.`,
      )
    }
  }
  return [...(value as string[])].sort()
}

/**
 * Parse, bind to the attempt, and TYPE-CHECK every field.
 *
 * Refuses rather than coerces. A missing boolean is not `false`: `false` is a
 * measurement and a missing field is the absence of one, and the difference
 * decides whether a project is ABSENT (apply) or INSTALLED (never apply again).
 * `undefined` reaching `classifyRemediation` would be read as falsy and would
 * silently mean "not remediated".
 */
export function parseRemediationWitness(
  raw: string | null,
  expectedAttemptId: string,
): RemediationWitnessDocument {
  requireAttemptId(expectedAttemptId)
  if (raw === null || raw.trim() === '') {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_REQUIRED',
      'no witness document was supplied. The absence of a measurement is not a measurement of ' +
        'absence, and an authorization decision may be taken from neither.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_MALFORMED',
      `the witness document is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `It is emitted as a single jsonb cell precisely so that this is the only parse that happens.`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_MALFORMED',
      'the witness document is not a JSON object.',
    )
  }
  const doc = parsed as Record<string, unknown>

  if (doc.schema !== REMEDIATION_WITNESS_SCHEMA) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_MALFORMED',
      `schema is ${JSON.stringify(doc.schema)}; this reader consumes ${REMEDIATION_WITNESS_SCHEMA}.`,
    )
  }
  if (doc.attemptId !== expectedAttemptId) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_ATTEMPT_MISMATCH',
      `the document echoes attempt ${JSON.stringify(doc.attemptId)} and the open attempt is ` +
        `${expectedAttemptId}. The id is compiled into the probe, so a disagreement means this ` +
        `measurement was taken for a different attempt — which is what a stale observation IS.`,
    )
  }
  if (doc.observation === null || typeof doc.observation !== 'object' || Array.isArray(doc.observation)) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_WITNESS_MALFORMED',
      'observation is absent or is not an object.',
    )
  }
  const o = doc.observation as Record<string, unknown>

  const booleans = [
    'installerHasCreateRole',
    'installerCanSetOwner',
    'installerCanCreateInDatabase',
    'ownerHoldsE01Grants',
    'installerHoldsVisibilityGrants',
    'topologyAssertionPresent',
    'capabilitiesBodyIsCertified',
  ] as const
  for (const field of booleans) {
    if (!isBool(o[field])) {
      throw new RemediationTransportRefusal(
        'REMEDIATION_WITNESS_MALFORMED',
        `observation.${field} is ${JSON.stringify(o[field])}, not a boolean. A field that is ` +
          `absent is not false — absent means the probe did not measure it, and an unmeasured ` +
          `fact may not decide an apply.`,
      )
    }
  }

  return {
    schema: REMEDIATION_WITNESS_SCHEMA,
    attemptId: expectedAttemptId,
    observation: {
      installerHasCreateRole: o.installerHasCreateRole as boolean,
      installerCanSetOwner: o.installerCanSetOwner as boolean,
      installerCanCreateInDatabase: o.installerCanCreateInDatabase as boolean,
      ownerHoldsE01Grants: o.ownerHoldsE01Grants as boolean,
      installerHoldsVisibilityGrants: o.installerHoldsVisibilityGrants as boolean,
      topologyAssertionPresent: o.topologyAssertionPresent as boolean,
      capabilitiesBodyIsCertified: o.capabilitiesBodyIsCertified as boolean,
      bootstrapSchemaAcl: stringArray(o.bootstrapSchemaAcl, 'observation.bootstrapSchemaAcl'),
      capabilityRolesPresent: stringArray(
        o.capabilityRolesPresent,
        'observation.capabilityRolesPresent',
      ),
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The source-state fingerprint                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything a rolled-back remediation must have left exactly as it found it.
 *
 * Deliberately WIDER than the witness. The witness answers "has this package
 * been applied"; this answers "did anything at all move", and the difference is
 * the whole of the R1..R9 certification: a transaction that rolled back its
 * identifying facts but left the borrowed schema grant, or a role attribute, or
 * the database ACL, has not rolled back.
 *
 * Every entry is a SORTED, fully-named string. No positional tuples: two
 * fingerprints are compared with a deep equality, and a comparison that
 * depended on row order would report drift whenever PostgreSQL returned the
 * same facts in a different sequence.
 */
export function buildRemediationSourceStateSql(
  attemptId: string,
  schemas: readonly string[] = FINGERPRINTED_SCHEMAS,
  functions: readonly string[] = FINGERPRINTED_FUNCTIONS,
  objects: readonly PrechainGrant[] = PRECHAIN_GRANTS,
): string {
  requireAttemptId(attemptId)

  const objectArms = [...new Set(objects.map((g) => `${g.objectType} ${g.object}`))]
    .sort()
    .map((key) => {
      const [objectType, object] = key.split(' ')
      const isFunction = objectType === 'function'
      const resolvable = isFunction && !object.endsWith('()') ? `${object}()` : object
      const resolve = isFunction
        ? `pg_catalog.to_regprocedure(${lit(resolvable)})`
        : `pg_catalog.to_regclass(${lit(resolvable)})`
      const aclSource = isFunction
        ? `(SELECT COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)) FROM pg_catalog.pg_proc p WHERE p.oid = ${resolve})`
        : `(SELECT COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner)) FROM pg_catalog.pg_class c WHERE c.oid = ${resolve})`
      const ownerExpr = isFunction
        ? `(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = ${resolve})`
        : `(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = ${resolve})`
      return `${lit(object)}, jsonb_build_object(
        'present', (${resolve} IS NOT NULL),
        'owner', ${ownerExpr},
        'acl', COALESCE((
          SELECT jsonb_agg(DISTINCT
                   (CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
                   || ':' || a.privilege_type
                   || CASE WHEN a.is_grantable THEN ':WGO' ELSE '' END)
          FROM pg_catalog.aclexplode(${aclSource}) a), '[]'::jsonb))`
    })

  const schemaArms = schemas.map(
    (s) => `${lit(s)}, jsonb_build_object(
        'present', (pg_catalog.to_regnamespace(${lit(s)}) IS NOT NULL),
        'owner', (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ${lit(s)}),
        'acl', COALESCE((
          SELECT jsonb_agg(DISTINCT
                   (CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
                   || ':' || a.privilege_type
                   || CASE WHEN a.is_grantable THEN ':WGO' ELSE '' END)
          FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
          WHERE n.nspname = ${lit(s)}), '[]'::jsonb))`,
  )

  const functionArms = functions.map(
    (f) => `${lit(f)}, COALESCE((
        SELECT pg_catalog.encode(
                 pg_catalog.sha256(
                   pg_catalog.convert_to(pg_catalog.replace(p.prosrc, pg_catalog.chr(13), ''), 'UTF8')),
                 'hex')
        FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${lit(f)})), 'ABSENT')`,
  )

  return `SET search_path = '';
SELECT jsonb_build_object(
  'schema', ${lit(REMEDIATION_SOURCE_STATE_SCHEMA)},
  'attemptId', ${lit(attemptId)},
  'roleAttributes', COALESCE((
    SELECT jsonb_object_agg(r.rolname, jsonb_build_object(
             'super', r.rolsuper, 'inherit', r.rolinherit, 'createRole', r.rolcreaterole,
             'createDb', r.rolcreatedb, 'canLogin', r.rolcanlogin,
             'bypassRls', r.rolbypassrls, 'replication', r.rolreplication))
    FROM pg_catalog.pg_roles r
    WHERE r.rolname LIKE 'uellix\\_%' OR r.rolname = 'postgres'), '{}'::jsonb),
  'databaseAcl', COALESCE((
    SELECT jsonb_agg(DISTINCT
             (CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
             || ':' || a.privilege_type
             || CASE WHEN a.is_grantable THEN ':WGO' ELSE '' END)
    FROM pg_catalog.pg_database d
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
    WHERE d.datname = pg_catalog.current_database()), '[]'::jsonb),
  'schemas', jsonb_build_object(${schemaArms.join(',\n    ')}),
  'objects', jsonb_build_object(${objectArms.join(',\n    ')}),
  'functionBodies', jsonb_build_object(${functionArms.join(',\n    ')}),
  'memberships', COALESCE((
    SELECT jsonb_agg(DISTINCT r.rolname || '<-' || m.rolname || ' by ' || g.rolname
             || ' (admin=' || am.admin_option || ' inherit=' || am.inherit_option
             || ' set=' || am.set_option || ')')
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
    JOIN pg_catalog.pg_roles g ON g.oid = am.grantor
    WHERE r.rolname LIKE 'uellix\\_%' OR m.rolname LIKE 'uellix\\_%'), '[]'::jsonb),
  'capabilityRolesPresent', COALESCE((
    SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
    FROM pg_catalog.pg_roles r
    WHERE r.rolname IN (${CAPABILITY_ROLES.map(lit).join(', ')})), '[]'::jsonb)
)::text;`
}

export interface RemediationSourceState {
  readonly schema: string
  readonly attemptId: string
  readonly roleAttributes: Readonly<Record<string, Readonly<Record<string, boolean>>>>
  readonly databaseAcl: readonly string[]
  readonly schemas: Readonly<Record<string, unknown>>
  readonly objects: Readonly<Record<string, unknown>>
  readonly functionBodies: Readonly<Record<string, string>>
  readonly memberships: readonly string[]
  readonly capabilityRolesPresent: readonly string[]
}

export function parseRemediationSourceState(
  raw: string | null,
  expectedAttemptId: string,
): RemediationSourceState {
  requireAttemptId(expectedAttemptId)
  if (raw === null || raw.trim() === '') {
    throw new RemediationTransportRefusal(
      'REMEDIATION_SOURCE_STATE_REQUIRED',
      'no source-state fingerprint was supplied. A rollback claim compares two measurements; ' +
        'with one of them missing there is no claim to make.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_SOURCE_STATE_MALFORMED',
      `the fingerprint is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_SOURCE_STATE_MALFORMED',
      'the fingerprint is not a JSON object.',
    )
  }
  const doc = parsed as Record<string, unknown>
  if (doc.schema !== REMEDIATION_SOURCE_STATE_SCHEMA) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_SOURCE_STATE_MALFORMED',
      `schema is ${JSON.stringify(doc.schema)}; this reader consumes ${REMEDIATION_SOURCE_STATE_SCHEMA}.`,
    )
  }
  if (doc.attemptId !== expectedAttemptId) {
    throw new RemediationTransportRefusal(
      'REMEDIATION_SOURCE_STATE_ATTEMPT_MISMATCH',
      `the fingerprint echoes attempt ${JSON.stringify(doc.attemptId)} and the open attempt is ` +
        `${expectedAttemptId}.`,
    )
  }
  for (const field of ['roleAttributes', 'schemas', 'objects', 'functionBodies'] as const) {
    if (doc[field] === null || typeof doc[field] !== 'object' || Array.isArray(doc[field])) {
      throw new RemediationTransportRefusal(
        'REMEDIATION_SOURCE_STATE_MALFORMED',
        `${field} is absent or is not an object.`,
      )
    }
  }
  return {
    schema: REMEDIATION_SOURCE_STATE_SCHEMA,
    attemptId: expectedAttemptId,
    roleAttributes: doc.roleAttributes as RemediationSourceState['roleAttributes'],
    databaseAcl: stringArray(doc.databaseAcl, 'databaseAcl'),
    schemas: doc.schemas as Readonly<Record<string, unknown>>,
    objects: doc.objects as Readonly<Record<string, unknown>>,
    functionBodies: doc.functionBodies as Readonly<Record<string, string>>,
    memberships: stringArray(doc.memberships, 'memberships'),
    capabilityRolesPresent: stringArray(doc.capabilityRolesPresent, 'capabilityRolesPresent'),
  }
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                  */
/* -------------------------------------------------------------------------- */

/** Order-independent, key-sorted serialization. Two states, one string each. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${[...value].map(canonical).sort().join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export interface SourceStateDifference {
  readonly path: string
  readonly before: string
  readonly after: string
}

/**
 * Every place two fingerprints disagree, named.
 *
 * `attemptId` is excluded: the two measurements are taken for different
 * attempts BY CONSTRUCTION — before is measured when the attempt opens, after
 * once it has closed — and reporting that as drift would make every comparison
 * fail for the one reason that is not a defect.
 */
export function diffSourceState(
  before: RemediationSourceState,
  after: RemediationSourceState,
): SourceStateDifference[] {
  const out: SourceStateDifference[] = []
  const walk = (path: string, a: unknown, b: unknown): void => {
    if (canonical(a) === canonical(b)) return
    const bothObjects =
      a !== null && b !== null && typeof a === 'object' && typeof b === 'object' &&
      !Array.isArray(a) && !Array.isArray(b)
    if (bothObjects) {
      const keys = new Set([
        ...Object.keys(a as Record<string, unknown>),
        ...Object.keys(b as Record<string, unknown>),
      ])
      for (const key of [...keys].sort()) {
        walk(`${path}.${key}`, (a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
      }
      return
    }
    out.push({ path, before: canonical(a), after: canonical(b) })
  }
  for (const key of ['roleAttributes', 'databaseAcl', 'schemas', 'objects', 'functionBodies', 'memberships', 'capabilityRolesPresent'] as const) {
    walk(key, before[key], after[key])
  }
  return out
}

/** Re-exported so a caller can state the ACL a clean bootstrap schema carries. */
export { EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES }
