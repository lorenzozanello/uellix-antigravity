// scripts/recovery/catalog-census.ts — ONE catalog census, run identically on
// both sides of a recovery (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-5).
//
// The invariants compare a SOURCE census (taken by the capture principal at
// capture time) with a RESTORED census (taken in the disposable substrate). Both
// come from the same SQL text, so a verifier can re-run the exact predicate: its
// sha256 (CENSUS_SQL_SHA256) is emitted with every result.
//
// PRIVACY BY CONSTRUCTION. The census reads catalogs plus per-relation COUNTS
// and nothing else from user tables. Expressions (policy USING/WITH CHECK,
// trigger definitions, function identity arguments, relation ACLs) are reduced
// to sha256 digests INSIDE PostgreSQL, so their text never leaves the server —
// only equality is needed, and a digest carries equality without content.
//
// NON-MUTATING BY CONSTRUCTION. The statement runs inside
//   BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
// with row_security = off: a role that RLS would filter gets an ERROR instead of
// a silently smaller count (the same posture pg_dump itself takes).

import { createHash } from 'node:crypto'

import { S, validateEvidence, type GrammarViolation, type Shape } from './evidence-privacy'
import type { ProcessResult } from './process'

export interface CensusScope {
  /** Schemas captured. Identifiers only (grammar-checked before use). */
  schemas: string[]
  /** `schema.relation` excluded from the capture. */
  excludedRelations: string[]
}

export interface Census {
  server_version_num: number
  schemas: Array<{ name: string; owner: string; acl: string[] }>
  relations: Array<{ schema: string; name: string; kind: string; owner: string; rls: boolean; force_rls: boolean; acl_sha256: string }>
  row_counts: Array<{ schema: string; name: string; rows: number }>
  policies: Array<{ schema: string; table: string; name: string; command: string; permissive: boolean; roles: string[]; qual_sha256: string | null; with_check_sha256: string | null }>
  triggers: Array<{ schema: string; table: string; name: string; enabled: string; definition_sha256: string }>
  sequences: Array<{ schema: string; name: string; last_value: number | null }>
  identity_columns: Array<{ schema: string; table: string; column: string; identity: string }>
  functions: Array<{ schema: string; name: string; identity_args_sha256: string; security_definer: boolean; owner: string; acl_sha256: string }>
  extensions: Array<{ name: string; version: string; schema: string }>
  extension_dependencies: string[]
  roles_referenced: string[]
  journal: { relation: string; row_count: number; max_id: number | null; content_sha256: string } | null
}

export const CENSUS_SHAPE: Shape = S.obj({
  server_version_num: S.int(),
  schemas: S.arr(S.obj({ name: S.str('identifier'), owner: S.str('identifier'), acl: S.arr(S.str('acl_item')) })),
  relations: S.arr(
    S.obj({
      schema: S.str('identifier'),
      name: S.str('identifier'),
      kind: S.enm('r', 'p', 'v', 'm', 'S', 'f'),
      owner: S.str('identifier'),
      rls: S.bool(),
      force_rls: S.bool(),
      acl_sha256: S.str('sha256'),
    }),
  ),
  row_counts: S.arr(S.obj({ schema: S.str('identifier'), name: S.str('identifier'), rows: S.int() })),
  policies: S.arr(
    S.obj({
      schema: S.str('identifier'),
      table: S.str('identifier'),
      name: S.str('identifier'),
      command: S.enm('r', 'a', 'w', 'd', '*'),
      permissive: S.bool(),
      roles: S.arr(S.str('identifier')),
      qual_sha256: S.opt(S.str('sha256')),
      with_check_sha256: S.opt(S.str('sha256')),
    }),
  ),
  triggers: S.arr(
    S.obj({
      schema: S.str('identifier'),
      table: S.str('identifier'),
      name: S.str('identifier'),
      enabled: S.enm('O', 'D', 'R', 'A'),
      definition_sha256: S.str('sha256'),
    }),
  ),
  sequences: S.arr(S.obj({ schema: S.str('identifier'), name: S.str('identifier'), last_value: S.opt(S.int()) })),
  identity_columns: S.arr(S.obj({ schema: S.str('identifier'), table: S.str('identifier'), column: S.str('identifier'), identity: S.enm('a', 'd') })),
  functions: S.arr(
    S.obj({
      schema: S.str('identifier'),
      name: S.str('identifier'),
      identity_args_sha256: S.str('sha256'),
      security_definer: S.bool(),
      owner: S.str('identifier'),
      acl_sha256: S.str('sha256'),
    }),
  ),
  extensions: S.arr(S.obj({ name: S.str('identifier'), version: S.str('version'), schema: S.str('identifier') })),
  extension_dependencies: S.arr(S.str('identifier')),
  roles_referenced: S.arr(S.str('identifier')),
  journal: S.opt(S.obj({ relation: S.str('qualified_identifier'), row_count: S.int(), max_id: S.opt(S.int()), content_sha256: S.str('sha256') })),
})

/**
 * The census statement. psql variables :'scope_schemas' and :'excluded' are
 * comma-joined identifier lists validated by `assertScopeGrammar` first, and
 * psql quotes them as literals — they are never spliced as SQL.
 */
export const CENSUS_SQL = String.raw`
WITH scope AS (
  SELECT unnest(string_to_array(:'scope_schemas', ','))::name AS nspname
), ns AS (
  SELECT n.oid, n.nspname, n.nspowner, n.nspacl FROM pg_namespace n JOIN scope s ON s.nspname = n.nspname
), excluded AS (
  SELECT unnest(string_to_array(NULLIF(:'excluded', ''), ',')) AS qn
), ext_member AS (
  SELECT d.classid, d.objid FROM pg_depend d WHERE d.deptype = 'e'
), rel AS (
  SELECT c.oid, ns.nspname, c.relname, c.relkind, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
    AND NOT EXISTS (SELECT 1 FROM ext_member m WHERE m.classid = 'pg_class'::regclass AND m.objid = c.oid)
    AND (ns.nspname || '.' || c.relname) NOT IN (SELECT qn FROM excluded WHERE qn IS NOT NULL)
), fn AS (
  SELECT p.oid, ns.nspname, p.proname, p.prosecdef, p.proowner, p.proacl
  FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
  WHERE NOT EXISTS (SELECT 1 FROM ext_member m WHERE m.classid = 'pg_proc'::regclass AND m.objid = p.oid)
), pol AS (
  SELECT r.nspname, r.relname, p.polname, p.polcmd, p.polpermissive, p.polroles, p.polqual, p.polwithcheck, p.polrelid
  FROM pg_policy p JOIN rel r ON r.oid = p.polrelid
), acl_roles AS (
  SELECT a.grantee FROM ns, aclexplode(ns.nspacl) a
  UNION SELECT a.grantor FROM ns, aclexplode(ns.nspacl) a
  UNION SELECT a.grantee FROM rel, aclexplode(rel.relacl) a
  UNION SELECT a.grantor FROM rel, aclexplode(rel.relacl) a
  UNION SELECT a.grantee FROM fn, aclexplode(fn.proacl) a
  UNION SELECT a.grantor FROM fn, aclexplode(fn.proacl) a
  UNION SELECT nspowner FROM ns
  UNION SELECT relowner FROM rel
  UNION SELECT proowner FROM fn
  UNION SELECT unnest(polroles) FROM pol
)
SELECT json_build_object(
  'server_version_num', current_setting('server_version_num')::int,
  'schemas', (
    SELECT coalesce(json_agg(json_build_object(
      'name', ns.nspname,
      'owner', pg_get_userbyid(ns.nspowner),
      'acl', coalesce((
        SELECT json_agg(x ORDER BY x) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                 || ':' || a.privilege_type || ':' || pg_get_userbyid(a.grantor) AS x
          FROM aclexplode(ns.nspacl) a) q), '[]'::json)
    ) ORDER BY ns.nspname), '[]'::json) FROM ns),
  'relations', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', nspname, 'name', relname, 'kind', relkind::text, 'owner', pg_get_userbyid(relowner),
      'rls', relrowsecurity, 'force_rls', relforcerowsecurity,
      'acl_sha256', encode(sha256(convert_to(coalesce(relacl::text, ''), 'UTF8')), 'hex')
    ) ORDER BY nspname, relname), '[]'::json) FROM rel),
  'row_counts', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', nspname, 'name', relname,
      'rows', (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', nspname, relname), false, true, '')))[1]::text::bigint
    ) ORDER BY nspname, relname), '[]'::json) FROM rel WHERE relkind IN ('r','p')),
  'policies', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', nspname, 'table', relname, 'name', polname, 'command', polcmd::text, 'permissive', polpermissive,
      'roles', (SELECT coalesce(json_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY 1), '[]'::json) FROM unnest(polroles) r),
      'qual_sha256', CASE WHEN polqual IS NULL THEN NULL ELSE encode(sha256(convert_to(pg_get_expr(polqual, polrelid), 'UTF8')), 'hex') END,
      'with_check_sha256', CASE WHEN polwithcheck IS NULL THEN NULL ELSE encode(sha256(convert_to(pg_get_expr(polwithcheck, polrelid), 'UTF8')), 'hex') END
    ) ORDER BY nspname, relname, polname), '[]'::json) FROM pol),
  'triggers', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', r.nspname, 'table', r.relname, 'name', t.tgname, 'enabled', t.tgenabled::text,
      'definition_sha256', encode(sha256(convert_to(pg_get_triggerdef(t.oid), 'UTF8')), 'hex')
    ) ORDER BY r.nspname, r.relname, t.tgname), '[]'::json)
    FROM pg_trigger t JOIN rel r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal),
  'sequences', (
    SELECT coalesce(json_agg(json_build_object('schema', s.schemaname, 'name', s.sequencename, 'last_value', s.last_value)
      ORDER BY s.schemaname, s.sequencename), '[]'::json)
    FROM pg_sequences s JOIN rel r ON r.nspname = s.schemaname AND r.relname = s.sequencename),
  'identity_columns', (
    SELECT coalesce(json_agg(json_build_object('schema', r.nspname, 'table', r.relname, 'column', a.attname, 'identity', a.attidentity::text)
      ORDER BY r.nspname, r.relname, a.attname), '[]'::json)
    FROM pg_attribute a JOIN rel r ON r.oid = a.attrelid
    WHERE a.attidentity <> '' AND a.attnum > 0 AND NOT a.attisdropped),
  'functions', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', nspname, 'name', proname,
      'identity_args_sha256', encode(sha256(convert_to(pg_get_function_identity_arguments(oid), 'UTF8')), 'hex'),
      'security_definer', prosecdef, 'owner', pg_get_userbyid(proowner),
      'acl_sha256', encode(sha256(convert_to(coalesce(proacl::text, ''), 'UTF8')), 'hex')
    ) ORDER BY nspname, proname, pg_get_function_identity_arguments(oid)), '[]'::json) FROM fn),
  'extensions', (
    SELECT coalesce(json_agg(json_build_object('name', e.extname, 'version', e.extversion, 'schema', e.extnamespace::regnamespace::text)
      ORDER BY e.extname), '[]'::json) FROM pg_extension e),
  'extension_dependencies', (
    SELECT coalesce(json_agg(DISTINCT e.extname), '[]'::json)
    FROM pg_depend d
    JOIN pg_depend m ON m.classid = d.refclassid AND m.objid = d.refobjid AND m.deptype = 'e'
    JOIN pg_extension e ON e.oid = m.refobjid
    -- pg_catalog extensions (plpgsql) exist in every database by construction.
    WHERE e.extnamespace <> 'pg_catalog'::regnamespace
      AND ((d.classid = 'pg_class'::regclass AND d.objid IN (
             SELECT c.oid FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
             WHERE NOT EXISTS (SELECT 1 FROM ext_member x WHERE x.classid = 'pg_class'::regclass AND x.objid = c.oid)))
        OR (d.classid = 'pg_proc'::regclass AND d.objid IN (SELECT oid FROM fn)))),
  'roles_referenced', (
    SELECT coalesce(json_agg(DISTINCT pg_get_userbyid(grantee)), '[]'::json) FROM acl_roles WHERE grantee <> 0),
  'journal', (
    SELECT CASE WHEN to_regclass('uellix_provisioning.applied_units') IS NULL
                  OR NOT EXISTS (SELECT 1 FROM rel WHERE nspname = 'uellix_provisioning' AND relname = 'applied_units')
           THEN NULL ELSE json_build_object(
      'relation', 'uellix_provisioning.applied_units',
      'row_count', (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM uellix_provisioning.applied_units', false, true, '')))[1]::text::bigint,
      'max_id', (xpath('/row/c/text()', query_to_xml('SELECT max(id) AS c FROM uellix_provisioning.applied_units', false, true, '')))[1]::text::bigint,
      'content_sha256', encode(sha256(convert_to(coalesce((xpath('/row/c/text()', query_to_xml(
          $j$SELECT string_agg(id::text || ':' || package_id || ':' || source_sha256 || ':' || status, ';' ORDER BY id) AS c FROM uellix_provisioning.applied_units$j$,
          false, true, '')))[1]::text, ''), 'UTF8')), 'hex')
    ) END)
);
`

export const CENSUS_SQL_SHA256 = createHash('sha256').update(CENSUS_SQL).digest('hex')

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/

/** Throws on any scope token that is not a plain identifier — they reach SQL as psql variables. */
export function assertScopeGrammar(scope: CensusScope): void {
  if (scope.schemas.length === 0) throw new Error('RECOVERY_SCOPE_EMPTY: a capture scope names at least one schema')
  for (const s of scope.schemas) if (!IDENT.test(s)) throw new Error(`RECOVERY_SCOPE_GRAMMAR: schema token rejected`)
  for (const r of scope.excludedRelations) if (!QUALIFIED.test(r)) throw new Error(`RECOVERY_SCOPE_GRAMMAR: excluded-relation token rejected`)
}

/** The psql argv tail + stdin that run the census in a READ ONLY transaction. */
export function censusInvocation(scope: CensusScope): { psqlArgs: string[]; stdin: string } {
  assertScopeGrammar(scope)
  return {
    psqlArgs: ['-X', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-tAq', '-v', `scope_schemas=${scope.schemas.join(',')}`, '-v', `excluded=${scope.excludedRelations.join(',')}`],
    stdin: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL row_security = off;\n${CENSUS_SQL}\nCOMMIT;\n`,
  }
}

export type CensusParse = { ok: true; census: Census } | { ok: false; code: 'CENSUS_EXEC_FAILED' | 'CENSUS_OUTPUT_UNPARSEABLE' | 'CENSUS_GRAMMAR_VIOLATION'; violations?: GrammarViolation[]; sqlstate?: string | null }

/** Parse a census run. The JSON is validated against CENSUS_SHAPE before anything trusts it. */
export function parseCensusResult(res: ProcessResult): CensusParse {
  if (res.status !== 0) {
    const m = res.stderr.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b/)
    return { ok: false, code: 'CENSUS_EXEC_FAILED', sqlstate: m ? m[1] : null }
  }
  const line = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'))
  if (!line) return { ok: false, code: 'CENSUS_OUTPUT_UNPARSEABLE' }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, code: 'CENSUS_OUTPUT_UNPARSEABLE' }
  }
  const violations = validateEvidence(parsed, CENSUS_SHAPE, '$.census')
  if (violations.length > 0) return { ok: false, code: 'CENSUS_GRAMMAR_VIOLATION', violations }
  const census = parsed as Census
  census.extension_dependencies.sort()
  census.roles_referenced.sort()
  return { ok: true, census }
}

/** Canonical JSON (sorted keys) so equal censuses have equal digests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function censusSha256(census: Census): string {
  return createHash('sha256').update(canonicalJson(census)).digest('hex')
}
