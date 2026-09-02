// db/hosted/authority/certification/chain-postconditions.ts
// COMMIT 5.3 — what "the governed chain applied correctly" means, DERIVED from
// the authority plan, and the typed posture document it is checked against.
//
// ---------------------------------------------------------------------------
// WHY THE EXPECTATIONS ARE DERIVED AND NOT WRITTEN DOWN
// ---------------------------------------------------------------------------
// Commit 5.1 reported `OWNER_TRANSFERS_ENGINE = 27_OF_27_CORRECT`. The number
// was right, and it was produced by a human reading a JSON artefact. That is
// fine once and useless forever after: the next person to add a transfer to a
// package has no way to learn that 27 became 28, and a harness that keeps
// printing 27 keeps printing PASS.
//
// So every expectation below is computed from `simulateChainOwnership` and the
// authority plan — the same derivations the generator itself uses. Add a
// transfer and the expected set grows; drop a function in a later package and
// the expectation for it becomes ABSENT rather than an owner. Nothing here is a
// literal that could fall behind.
//
// ---------------------------------------------------------------------------
// WHY THE MEASUREMENT IS ONE JSON DOCUMENT
// ---------------------------------------------------------------------------
// Same reason as `remediation-probes.ts`, and it is the defect Commit 5.3 was
// opened to close. The chain's existing probes are read with `-F ''` and
// positional indexing, which works today because nothing measured contains that
// byte — a property of the current data, not of the format. `proconfig` is a
// text[] whose members can contain anything, an ACL is comma-joined, and a
// policy `qual` is arbitrary SQL. A posture document read positionally is one
// unusual value away from silently attributing a measurement to the wrong
// column.
//
// The posture below is built by `jsonb_build_object`, arrives as one cell, and
// is validated by shape. There are no columns to count.

import { buildAuthorityPlan } from '../classification-manifest'
import { resolveExecutionDispositions } from '../execution-disposition'
import { simulateChainOwnership, type SimulatedStatement } from '../ownership-simulation'
import { CAPABILITY_ROLES, HOSTED_INSTALLER, OWNER } from './prechain-authority-gate'

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

/* -------------------------------------------------------------------------- */
/* Derived expectations                                                        */
/* -------------------------------------------------------------------------- */

/** `schema.name(argtype,argtype)` — the spelling `to_regprocedure` resolves. */
export function functionSignature(object: {
  readonly schema?: string
  readonly name: string
  readonly argumentTypes?: readonly string[]
}): string {
  return `${object.schema ?? 'public'}.${object.name}(${(object.argumentTypes ?? []).join(',')})`
}

export interface ExpectedOwnerTransfer {
  readonly packageId: string
  readonly statementIndex: number
  /** Resolvable by `to_regprocedure` / `to_regclass`. */
  readonly object: string
  readonly objectClass: 'function' | 'table'
  /**
   * Who must own it once the whole chain has run — or `null` when a LATER
   * package drops it.
   *
   * T6 drops the four two-argument ticket functions T5 created and transferred.
   * An expectation that ignored drops would demand an owner for an object that
   * correctly no longer exists, and would report four failures on a perfect run.
   */
  readonly expectedFinalOwner: string | null
}

/**
 * Every `ALTER … OWNER TO` the canonical chain issues, with the owner it must
 * end up at.
 *
 * The count is the count of STATEMENTS, not of objects: several functions are
 * transferred by more than one package as their signature evolves, and the
 * pinned figure this certification is read against — 27 — is the statement
 * count. Each statement is judged by the FINAL state of the object it names, so
 * the repeats agree with one another by construction.
 */
export function deriveExpectedOwnerTransfers(root: string): readonly ExpectedOwnerTransfer[] {
  const sim = simulateChainOwnership(root)
  const key = (row: SimulatedStatement): string | null => {
    const o = row.identity.object
    if (o === null) return null
    return o.objectClass === 'function'
      ? functionSignature(o as never)
      : `${(o as { schema?: string }).schema ?? 'public'}.${(o as { name: string }).name}`
  }

  const finalOwner = new Map<string, string | null>()
  for (const row of sim.rows) {
    const k = key(row)
    if (k === null) continue
    if (row.identity.statementClass === 'owner-transfer') {
      finalOwner.set(k, row.ownerDestination)
    } else if (row.identity.statementClass === 'drop-object' && finalOwner.has(k)) {
      finalOwner.set(k, null)
    }
  }

  return sim.rows
    .filter((row) => row.identity.statementClass === 'owner-transfer')
    .map((row) => {
      const k = key(row) as string
      const objectClass = row.identity.object?.objectClass === 'function' ? 'function' : 'table'
      return {
        packageId: row.packageId,
        statementIndex: row.statement.index,
        object: k,
        objectClass: objectClass as 'function' | 'table',
        expectedFinalOwner: finalOwner.get(k) ?? null,
      }
    })
}

export interface ExpectedCanonicalOwnerContext {
  readonly packageId: string
  readonly object: string
  readonly expectedOwner: string
}

/**
 * The statements that exist inside a canonical `SET ROLE uellix_owner` span and
 * are NOT covered by a classification window.
 *
 * There are three, all `CREATE TABLE`, and they are the reason the owner window
 * exists at all: PostgreSQL checks CREATE on the containing namespace against
 * the role EXECUTING the statement (S1-DEFECT-001), so a table created
 * unelevated would belong to the installer and every policy written for
 * uellix_owner would be written against an object it does not own.
 */
export function deriveExpectedCanonicalOwnerContexts(
  root: string,
): readonly ExpectedCanonicalOwnerContext[] {
  const plan = buildAuthorityPlan()
  const sim = simulateChainOwnership(root)
  const contexts = resolveExecutionDispositions(plan).filter(
    (d) => d.kind === 'CANONICAL_ROLE_CONTEXT',
  ) as readonly { packageId: string; statementIndex: number; requiredExecutor: string }[]

  return contexts.map((c) => {
    const row = sim.rows.find(
      (r) => r.packageId === c.packageId && r.statement.index === c.statementIndex,
    )
    const o = row?.identity.object
    if (o === undefined || o === null) {
      throw new Error(
        `[postconditions] ${c.packageId} statement ${c.statementIndex} is a canonical owner ` +
          `context and names no object. The derivation cannot say what must end up owned by ` +
          `${c.requiredExecutor}, and inventing an object here would make the check vacuous.`,
      )
    }
    return {
      packageId: c.packageId,
      object: `${(o as { schema?: string }).schema ?? 'public'}.${(o as { name: string }).name}`,
      expectedOwner: c.requiredExecutor,
    }
  })
}

/** The number of OWNER_TRANSFER execution segments the plan resolves to. */
export function deriveTransferSegmentCount(): number {
  return buildAuthorityPlan().segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER').length
}

/**
 * The membership rows the CHAIN adds, and the only ones it may add.
 *
 * A DELTA against the prechain topology rather than an absolute list, and the
 * difference matters. The absolute set after T9 contains eleven rows, six of
 * which PostgreSQL created during the BOOTSTRAP when `postgres` created the
 * five separated roles (RR-02, grantor = the bootstrap superuser) and one of
 * which is §2b's `uellix_owner<-postgres SET` — the grant that lets the
 * remediation open its owner phase at all. None of those is the chain's doing,
 * and an absolute expectation would either have to enumerate them — pinning
 * `supabase_admin`, which is the LAB's bootstrap superuser and not necessarily
 * a managed project's — or quietly exclude them, which is how a residual probe
 * stops noticing residuals.
 *
 * So the claim is exactly: after nine packages, the topology is what it was
 * before T1 plus THESE THREE ROWS. Options are pinned because they are the
 * property — `admin` without `inherit` or `set` confers administration and no
 * ability to become the role. Grantor is not, for the reason above.
 */
export const EXPECTED_CHAIN_MEMBERSHIP_DELTA: readonly string[] = CAPABILITY_ROLES.map(
  (c) => `${c}<-${HOSTED_INSTALLER} (admin=true inherit=false set=false)`,
)

/** The persistent rows the chain must NOT disturb, named for the report. */
export const OWNER_WINDOW_MEMBERSHIP = `${OWNER}<-${HOSTED_INSTALLER} (admin=false inherit=false set=true)`

/* -------------------------------------------------------------------------- */
/* The posture probe                                                           */
/* -------------------------------------------------------------------------- */

export const CHAIN_POSTURE_SCHEMA = 'uellix.hosted.chain.posture/1'

/** Schemas the chain owns or writes into. */
export const GOVERNED_SCHEMAS: readonly string[] = [
  'public',
  'uellix_grounding',
  'uellix_stella',
  'uellix_stella_ops',
  'uellix_bootstrap',
]

/**
 * The same, plus `storage`, for relations and policies.
 *
 * The scope `certify:pg176` already uses for its policy probe, matched here so
 * the two certifications count the same thing. `storage.objects` is a declared
 * SHIM on this image — see LAB_SHIMS — so a policy on it is evidence that the
 * statement RAN, not evidence about how it would behave on a managed project.
 * Relations carry storage too, because a policy whose relation is unmeasured
 * would be reported as sitting on an unprotected table.
 */
export const POLICY_SCHEMAS: readonly string[] = [...GOVERNED_SCHEMAS, 'storage']

/**
 * Everything the postconditions read, as ONE jsonb document.
 *
 * The objects whose owner is asserted are compiled IN from the derivation, so
 * the probe asks about exactly the set the expectations cover. A probe with its
 * own list would be a third source of truth.
 */
export function buildChainPostureSql(
  transfers: readonly ExpectedOwnerTransfer[],
  contexts: readonly ExpectedCanonicalOwnerContext[],
): string {
  const ownerArms = [
    ...new Map(
      transfers.map((t) => [t.object, t] as const),
    ).values(),
  ].map((t) => {
    const resolve =
      t.objectClass === 'function'
        ? `pg_catalog.to_regprocedure(${lit(t.object)})`
        : `pg_catalog.to_regclass(${lit(t.object)})`
    const owner =
      t.objectClass === 'function'
        ? `(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = ${resolve})`
        : `(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = ${resolve})`
    return `${lit(t.object)}, ${owner}`
  })

  const contextArms = contexts.map(
    (c) =>
      `${lit(c.object)}, (SELECT pg_catalog.pg_get_userbyid(cl.relowner) FROM pg_catalog.pg_class cl WHERE cl.oid = pg_catalog.to_regclass(${lit(c.object)}))`,
  )

  const schemaList = GOVERNED_SCHEMAS.map(lit).join(', ')
  const policyList = POLICY_SCHEMAS.map(lit).join(', ')
  const capabilityArms = CAPABILITY_ROLES.map(
    (cap) => `${lit(cap)}, COALESCE((
        SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
        FROM pg_catalog.pg_roles r
        WHERE r.rolname <> ${lit(cap)}
          AND NOT r.rolsuper
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles c WHERE c.rolname = ${lit(cap)})
          AND pg_catalog.pg_has_role(r.rolname, ${lit(cap)}, 'SET')), '[]'::jsonb)`,
  ).join(', ')

  return `SET search_path = '';
SELECT jsonb_build_object(
  'schema', ${lit(CHAIN_POSTURE_SCHEMA)},
  'transferredOwners', jsonb_build_object(${ownerArms.join(',\n    ')}),
  'canonicalContextOwners', jsonb_build_object(${contextArms.join(',\n    ')}),
  'functions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'signature', p.oid::regprocedure::text,
             'schema', n.nspname,
             'owner', pg_catalog.pg_get_userbyid(p.proowner),
             'securityDefiner', p.prosecdef,
             'proconfig', COALESCE(pg_catalog.to_jsonb(p.proconfig), '[]'::jsonb),
             'executeGrantees', COALESCE((
                SELECT jsonb_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                               ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
                FROM pg_catalog.aclexplode(
                  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                WHERE a.privilege_type = 'EXECUTE'), '[]'::jsonb)))
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN (${schemaList})), '[]'::jsonb),
  'relations', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'relation', n.nspname || '.' || c.relname,
             'kind', c.relkind::text,
             'owner', pg_catalog.pg_get_userbyid(c.relowner),
             'rlsEnabled', c.relrowsecurity,
             'rlsForced', c.relforcerowsecurity))
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m') AND n.nspname IN (${policyList})), '[]'::jsonb),
  'policies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'relation', p.schemaname || '.' || p.tablename,
             'name', p.policyname,
             'command', p.cmd,
             'roles', pg_catalog.to_jsonb(p.roles)))
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname IN (${policyList})), '[]'::jsonb),
  'triggers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'relation', n.nspname || '.' || c.relname,
             'name', t.tgname,
             'functionOwner', pg_catalog.pg_get_userbyid(pr.proowner)))
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc pr ON pr.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND n.nspname IN (${schemaList})), '[]'::jsonb),
  'memberships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'role', r.rolname, 'member', m.rolname, 'grantor', g.rolname,
             'adminOption', am.admin_option, 'inheritOption', am.inherit_option,
             'setOption', am.set_option))
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
    JOIN pg_catalog.pg_roles g ON g.oid = am.grantor
    WHERE r.rolname LIKE 'uellix\\_%' OR m.rolname LIKE 'uellix\\_%'), '[]'::jsonb),
  'schemaCreateGrants', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'schema', n.nspname,
             'owner', pg_catalog.pg_get_userbyid(n.nspowner),
             'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                             ELSE pg_catalog.pg_get_userbyid(a.grantee) END))
    FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    WHERE a.privilege_type = 'CREATE' AND n.nspname IN (${schemaList})), '[]'::jsonb),
  'roleAttributes', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'name', r.rolname, 'canLogin', r.rolcanlogin, 'createRole', r.rolcreaterole,
             'super', r.rolsuper, 'inherit', r.rolinherit, 'bypassRls', r.rolbypassrls))
    FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'uellix\\_%'), '[]'::jsonb),
  'capabilityReachableBy', jsonb_build_object(${capabilityArms})
)::text;`
}

export interface PostureFunction {
  readonly signature: string
  readonly schema: string
  readonly owner: string
  readonly securityDefiner: boolean
  readonly proconfig: readonly string[]
  readonly executeGrantees: readonly string[]
}

export interface PostureMembership {
  readonly role: string
  readonly member: string
  readonly grantor: string
  readonly adminOption: boolean
  readonly inheritOption: boolean
  readonly setOption: boolean
}

export interface ChainPosture {
  readonly schema: string
  readonly transferredOwners: Readonly<Record<string, string | null>>
  readonly canonicalContextOwners: Readonly<Record<string, string | null>>
  readonly functions: readonly PostureFunction[]
  readonly relations: readonly { relation: string; kind: string; owner: string; rlsEnabled: boolean; rlsForced: boolean }[]
  readonly policies: readonly { relation: string; name: string; command: string; roles: readonly string[] }[]
  readonly triggers: readonly { relation: string; name: string; functionOwner: string }[]
  readonly memberships: readonly PostureMembership[]
  readonly schemaCreateGrants: readonly { schema: string; owner: string; grantee: string }[]
  readonly roleAttributes: readonly { name: string; canLogin: boolean; createRole: boolean; super: boolean; inherit: boolean; bypassRls: boolean }[]
  /** Non-superusers that can `SET ROLE` into each capability role. Must be empty. */
  readonly capabilityReachableBy: Readonly<Record<string, readonly string[]>>
}

export class PostureTransportRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'PostureTransportRefusal'
  }
}

export function parseChainPosture(raw: string | null): ChainPosture {
  if (raw === null || raw.trim() === '') {
    throw new PostureTransportRefusal('POSTURE_REQUIRED', 'no posture document was supplied.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PostureTransportRefusal(
      'POSTURE_MALFORMED',
      `not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PostureTransportRefusal('POSTURE_MALFORMED', 'not a JSON object.')
  }
  const doc = parsed as Record<string, unknown>
  if (doc.schema !== CHAIN_POSTURE_SCHEMA) {
    throw new PostureTransportRefusal(
      'POSTURE_MALFORMED',
      `schema is ${JSON.stringify(doc.schema)}; this reader consumes ${CHAIN_POSTURE_SCHEMA}.`,
    )
  }
  for (const field of ['functions', 'relations', 'policies', 'triggers', 'memberships', 'schemaCreateGrants', 'roleAttributes'] as const) {
    if (!Array.isArray(doc[field])) {
      throw new PostureTransportRefusal('POSTURE_MALFORMED', `${field} is not an array.`)
    }
  }
  for (const field of ['transferredOwners', 'canonicalContextOwners'] as const) {
    if (doc[field] === null || typeof doc[field] !== 'object' || Array.isArray(doc[field])) {
      throw new PostureTransportRefusal('POSTURE_MALFORMED', `${field} is not an object.`)
    }
  }
  return doc as unknown as ChainPosture
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

export interface CountedVerdict {
  readonly total: number
  readonly correct: number
  readonly wrong: readonly string[]
  readonly pass: boolean
}

export function evaluateOwnerTransfers(
  expected: readonly ExpectedOwnerTransfer[],
  posture: ChainPosture,
): CountedVerdict {
  const wrong: string[] = []
  for (const t of expected) {
    const actual = posture.transferredOwners[t.object] ?? null
    if (actual !== t.expectedFinalOwner) {
      wrong.push(
        `${t.packageId}[${t.statementIndex}] ${t.object}: expected ` +
          `${t.expectedFinalOwner ?? 'ABSENT (dropped by a later package)'}, measured ` +
          `${actual ?? 'ABSENT'}`,
      )
    }
  }
  return {
    total: expected.length,
    correct: expected.length - wrong.length,
    wrong,
    pass: wrong.length === 0 && expected.length > 0,
  }
}

export function evaluateCanonicalOwnerContexts(
  expected: readonly ExpectedCanonicalOwnerContext[],
  posture: ChainPosture,
): CountedVerdict {
  const wrong: string[] = []
  for (const c of expected) {
    const actual = posture.canonicalContextOwners[c.object] ?? null
    if (actual !== c.expectedOwner) {
      wrong.push(`${c.packageId} ${c.object}: expected ${c.expectedOwner}, measured ${actual ?? 'ABSENT'}`)
    }
  }
  return {
    total: expected.length,
    correct: expected.length - wrong.length,
    wrong,
    pass: wrong.length === 0 && expected.length > 0,
  }
}

/**
 * Whether the memberships left after T9 are EXACTLY the persistent set.
 *
 * Both directions. A missing row means the chain removed something it depends
 * on; an extra row means a temporary elevation survived, which is the failure
 * the whole Case G lifecycle exists to prevent.
 */
export function evaluatePersistentRoleTopology(
  posture: ChainPosture,
  prechain: ChainPosture,
): {
  readonly pass: boolean
  readonly measured: readonly string[]
  readonly prechain: readonly string[]
  readonly added: readonly string[]
  readonly unexpected: readonly string[]
  readonly missing: readonly string[]
  readonly removed: readonly string[]
  readonly capabilityReachableBy: readonly string[]
  readonly grantors: Readonly<Record<string, string>>
} {
  const key = (m: PostureMembership): string =>
    `${m.role}<-${m.member} (admin=${m.adminOption} inherit=${m.inheritOption} set=${m.setOption})`
  const measured = posture.memberships.map(key).sort()
  const before = prechain.memberships.map(key).sort()
  const added = measured.filter((m) => !before.includes(m)).sort()
  const removed = before.filter((b) => !measured.includes(b)).sort()
  const expected = [...EXPECTED_CHAIN_MEMBERSHIP_DELTA].sort()

  // The ABSOLUTE property, which no delta can express: after the chain has
  // created three capability roles, nobody may become one. `pg_has_role(...,
  // 'SET')` is transitive, so this also closes the intermediate-role path a row
  // inspection cannot see.
  const reachable = Object.entries(posture.capabilityReachableBy ?? {})
    .flatMap(([capability, roles]) => roles.map((r) => `${r} -> ${capability}`))
    .sort()

  return {
    pass:
      removed.length === 0 &&
      reachable.length === 0 &&
      added.length === expected.length &&
      added.every((a, i) => a === expected[i]),
    measured,
    prechain: before,
    added,
    unexpected: added.filter((a) => !expected.includes(a)),
    missing: expected.filter((e) => !added.includes(e)),
    removed,
    capabilityReachableBy: reachable,
    grantors: Object.fromEntries(posture.memberships.map((m) => [key(m), m.grantor])),
  }
}

/**
 * The schemas whose SECURITY DEFINER functions the CHAIN is answerable for.
 *
 * `public` is not among them and the omission is a scope statement, not an
 * exemption — see `evaluateSecurityDefinerGate`.
 */
export const CHAIN_OWNED_SCHEMAS: readonly string[] = [
  'uellix_grounding',
  'uellix_stella',
  'uellix_stella_ops',
]

/**
 * How PostgreSQL spells an empty search_path in `proconfig`.
 *
 * MEASURED: `SET search_path = ''` is stored as `search_path=""` — the empty
 * string arrives QUOTED. A check written against `search_path=` (which is what
 * the SQL looks like) matches nothing and reports every correct function as a
 * violation, which is how this gate first failed twenty-seven functions that
 * were all fine. Both spellings are accepted so the check states the property
 * rather than one server's rendering of it.
 */
const EMPTY_SEARCH_PATH = ['search_path=""', 'search_path=']

/**
 * SD gate v2, in two tiers, both reported.
 *
 * REFUSING:
 *   * every SECURITY DEFINER function IN A CHAIN SCHEMA pins an EMPTY
 *     search_path. A definer resolving names through `public` runs whatever a
 *     principal who can create there decides it runs.
 *   * NO definer function anywhere grants EXECUTE to PUBLIC. Scope does not
 *     narrow this one: a PUBLIC-executable definer is a privilege escalation
 *     whoever created it.
 *
 * RECORDED, NOT REFUSING:
 *   * definer functions outside the chain's schemas, with their proconfig.
 *     MEASURED on this engine: `public.current_user_org_ids`,
 *     `current_user_is_super_admin` and `current_user_role_in_org` are BASELINE
 *     objects carrying `search_path=public`. They are prechain facts, identical
 *     in a run that never applies the chain, and the chain neither creates nor
 *     owns them — E-01 exists precisely because uellix_owner has to be GRANTED
 *     privileges on them rather than given ownership. Refusing here would fail
 *     the certification for a property of db/migrations, and silently dropping
 *     them from the count would be worse. They are listed.
 */
export function evaluateSecurityDefinerGate(
  posture: ChainPosture,
  chainSchemas: readonly string[] = CHAIN_OWNED_SCHEMAS,
): {
  readonly pass: boolean
  readonly securityDefiner: number
  readonly inChainScope: number
  readonly withoutEmptySearchPath: readonly string[]
  readonly withPublicExecute: readonly string[]
  readonly outsideChainScope: readonly string[]
} {
  const definers = posture.functions.filter((f) => f.securityDefiner)
  const inScope = definers.filter((f) => chainSchemas.includes(f.schema))
  const pinsEmpty = (f: PostureFunction): boolean =>
    f.proconfig.some((c) => EMPTY_SEARCH_PATH.includes(c))

  const withoutEmptySearchPath = inScope
    .filter((f) => !pinsEmpty(f))
    .map((f) => `${f.signature} proconfig=${JSON.stringify(f.proconfig)}`)
  const withPublicExecute = definers
    .filter((f) => f.executeGrantees.includes('PUBLIC'))
    .map((f) => f.signature)

  return {
    pass:
      inScope.length > 0 &&
      withoutEmptySearchPath.length === 0 &&
      withPublicExecute.length === 0,
    securityDefiner: definers.length,
    inChainScope: inScope.length,
    withoutEmptySearchPath,
    withPublicExecute,
    outsideChainScope: definers
      .filter((f) => !chainSchemas.includes(f.schema))
      .map((f) => `${f.signature} proconfig=${JSON.stringify(f.proconfig)}${pinsEmpty(f) ? '' : '  <- NOT an empty search_path (baseline object)'}`)
      .sort(),
  }
}

/**
 * RLS engine: policies exist, none is duplicated, and every relation carrying
 * one has row security ENABLED.
 *
 * The third is the one that matters and the one a count would miss: a policy on
 * a table with RLS disabled is inert, and `pg_policies` lists it exactly the
 * same way as a policy that is enforcing.
 */
export function evaluateRlsPolicyEngine(posture: ChainPosture): {
  readonly pass: boolean
  readonly policies: number
  readonly triggers: number
  readonly duplicates: readonly string[]
  readonly policiesOnUnprotectedRelations: readonly string[]
} {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const p of posture.policies) {
    const k = `${p.relation}.${p.name}`
    if (seen.has(k)) duplicates.push(k)
    seen.add(k)
  }
  const rlsOf = new Map(posture.relations.map((r) => [r.relation, r.rlsEnabled]))
  const unprotected = [
    ...new Set(posture.policies.filter((p) => rlsOf.get(p.relation) !== true).map((p) => p.relation)),
  ]
  return {
    pass: posture.policies.length > 0 && duplicates.length === 0 && unprotected.length === 0,
    policies: posture.policies.length,
    triggers: posture.triggers.length,
    duplicates,
    policiesOnUnprotectedRelations: unprotected,
  }
}

/**
 * Temporary `GRANT CREATE ON SCHEMA` that outlived the package that opened it.
 *
 * A schema's OWNER holds CREATE inherently — `acldefault('n', owner)` contains
 * it and no statement granted it — so counting that would report every schema
 * the chain creates as a residual and train a reviewer to ignore the number.
 */
export function evaluateSchemaCreateResidual(
  posture: ChainPosture,
  baseline: ChainPosture,
): {
  readonly pass: boolean
  readonly residual: readonly string[]
} {
  const held = (p: ChainPosture): Set<string> =>
    new Set(
      p.schemaCreateGrants
        .filter((g) => g.grantee !== g.owner)
        .map((g) => `${g.schema} -> ${g.grantee}`),
    )
  // A DELTA against the state before the chain ran. Some CREATE grants are
  // persistent and correct — the baseline is what says which — and an absolute
  // count would report them as leaks on every run.
  const before = held(baseline)
  const residual = [...held(posture)].filter((g) => !before.has(g)).sort()
  return { pass: residual.length === 0, residual }
}
