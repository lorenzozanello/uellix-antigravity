// tests/helpers/train4-gates.ts
//
// The static contract for the Train 4 persistence packages — quota consumption
// (stella_0013, INT-CAP-001) and grounding runtime attestation (grounding_0004,
// INT-GR-004 / INT-CAP-002 / INT-CAP-003 / INT-CAP-004) — as a PURE FUNCTION
// over file contents.
//
// It is a pure function for the same reason tests/helpers/grounding-gates.ts
// is: tests/train4-persistence-mutation.test.ts has to run exactly this code
// over deliberately broken copies. A gate that lives inside an assertion which
// reads the disk itself cannot be shown to go red, and a gate that has never
// gone red is indistinguishable from a gate that cannot.
//
// SCOPE. These gates judge the FOUR Train 4 files and nothing else. They are
// deliberately NOT folded into evaluateGroundingGates(): that contract asserts
// exact facts about the four grounding files — "exactly 5 SECURITY DEFINER
// functions", "exactly 4 RLS policies", "every file creates a table in the
// expected form" — and widening it to a package that creates no table and adds
// a sixth function would have meant relaxing assertions that are exact today.
// The same argument grounding-gates.ts makes for not joining the capability
// contract, one campaign later.

import {
  analyzeSecurity,
  parsePolicies,
  unparsedSecurityStatements,
} from './sql-structure'
import { parseFunctions } from './grounding-gates'

export const FORWARD = {
  QUOTA: 'stella_0013_grounded_query_quota.sql',
  ATTEST: 'grounding_0004_runtime_attestation.sql',
} as const

export const ROLLBACK = {
  QUOTA: 'stella_0013_rollback.sql',
  ATTEST: 'grounding_0004_rollback.sql',
  /**
   * INT-CAP-004 (1) — a TRAIN 3 file, guarded here.
   *
   * `grounding_0003_rollback.sql` is not a Train 4 package, and this constant
   * deliberately does not pretend otherwise. It is listed because the defect
   * INT-CAP-004 (1) reports lives in it and was repaired in the Train 4
   * integration: its four `DROP FUNCTION`s were nested inside "if the table
   * exists", so a database whose evidence_chunks had gone by another route got
   * a rollback that exited 0 and left three callable SECURITY DEFINER
   * functions — which then made grounding_0002's `DROP ROLE
   * uellix_cap_grounding` permanently impossible.
   *
   * A repair nobody can re-break by accident is a repair with a gate on it, so
   * the property moved here rather than staying a claim in a commit message.
   * Only the three rollback-shape gates read it (§Rollbacks); the gates that
   * check a Train 4 forward package's own vocabulary are not pointed at a file
   * that never had it.
   */
  CHUNKS_T3: 'grounding_0003_rollback.sql',
} as const

export const TRAIN4_SQL_FILES = [
  FORWARD.QUOTA,
  ROLLBACK.QUOTA,
  FORWARD.ATTEST,
  ROLLBACK.ATTEST,
  ROLLBACK.CHUNKS_T3,
] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** The quota definer. Zero members, by design — see stella_0013 §1. */
const QUOTA_ROLE = 'uellix_cap_stella_quota'
/** The grounding definer, created by grounding_0002 and reused by 0004. */
const GROUNDING_ROLE = 'uellix_cap_grounding'

/** The runtime identity. The only principal either package hands EXECUTE to. */
const RUNTIME_ROLE = 'uellix_app'

/**
 * The governed capability vocabulary INT-CAP-001 asks the CHECK to admit.
 * `grounded_query` is the contract's literal ask; the other six are the set
 * db/schema.ts already declares, and narrowing them would be a second,
 * unrequested change.
 */
export const GOVERNED_STELLA_ROLES = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
  'grounded_query',
] as const

/** The four columns INT-GR-004 needs a chunk row to carry. */
export const SCOPE_ATTESTATION_COLUMNS = [
  'organization_id',
  'project_id',
  'evidence_id',
  'document_version_id',
] as const

/** Strip `--` line comments so prose cannot satisfy — or trip — a gate. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/**
 * Every `DROP FUNCTION` whose execution is CONDITIONAL on a table existing.
 *
 * This is INT-CAP-004 (1) expressed as a readable property rather than as a
 * string match. grounding_0003_rollback nested its three DROP FUNCTIONs inside
 * `IF to_regclass(...) IS NULL ... ELSE`, so a database whose table had gone by
 * another route got a rollback that reported success and left three callable
 * SECURITY DEFINER functions behind — which then blocked grounding_0002's
 * rollback permanently.
 *
 * The reader walks IF/END IF depth over comment-stripped text, keeping each
 * open block's CONDITION, and reports any DROP FUNCTION with a table-existence
 * test above it. `\bIF\b` cannot match inside `ELSIF` (the preceding `S` is a
 * word character), and `END IF` is consumed by an earlier alternative so it
 * never opens a block.
 */
function conditionalFunctionDrops(sql: string): string[] {
  const text = code(sql)
  const token = /\bEND\s+IF\b|\bIF\b|\bTHEN\b|\bDROP\s+FUNCTION\b/g
  const open: string[] = []
  const problems: string[] = []
  let pendingFrom: number | null = null
  let m: RegExpExecArray | null

  while ((m = token.exec(text)) !== null) {
    const word = m[0].replace(/\s+/g, ' ').toUpperCase()
    if (word === 'END IF') {
      open.pop()
    } else if (word === 'IF') {
      pendingFrom = m.index
    } else if (word === 'THEN') {
      // A THEN with no pending IF belongs to a CASE or to an ELSIF whose IF
      // this reader deliberately did not open — either way there is no new
      // block to push.
      if (pendingFrom !== null) {
        open.push(text.slice(pendingFrom, m.index))
        pendingFrom = null
      }
    } else {
      const guard = open.find((c) => /to_regclass|_oid\b/i.test(c))
      if (guard !== undefined) {
        problems.push(
          `a DROP FUNCTION is nested inside "IF ${guard.replace(/\s+/g, ' ').trim().slice(0, 70)}…"`,
        )
      }
    }
  }
  return problems
}

/**
 * Top-level statements: the file with every `$$ ... $$` body collapsed, split
 * on `;`. Collapsing first is what stops a `DROP` written inside a DO block
 * from being read as top-level.
 */
function topLevelStatements(sql: string): string[] {
  return code(sql)
    .replace(/\$\$[\s\S]*?\$\$/g, '$$body$$')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function evaluateTrain4Gates(sources: Sources): Violation[] {
  const v: Violation[] = []
  const add = (gate: string, detail: string) => {
    v.push({ gate, detail })
  }
  /** The ONE forwarder. Its argument is a literal one frame up. */
  const require_ = (gate: string, ok: boolean, detail: string) => {
    if (!ok) add(gate, detail)
  }

  // ---------------------------------------------------------------------
  // Harness self-check: is the reader reading what it thinks it is?
  // ---------------------------------------------------------------------
  for (const file of TRAIN4_SQL_FILES) {
    if (typeof sources[file] !== 'string' || sources[file].length === 0) {
      add('source-missing', `${file} is absent or empty`)
    }
  }
  if (v.length > 0) return v

  const forwardFiles = [FORWARD.QUOTA, FORWARD.ATTEST] as const
  // grounding_0003's rollback is included: INT-CAP-004 (1) is a property of
  // rollback SHAPE, and shape is exactly what these three gates read. Excluding
  // it would leave the repaired file guarded by nothing.
  const rollbackFiles = [ROLLBACK.QUOTA, ROLLBACK.ATTEST, ROLLBACK.CHUNKS_T3] as const

  // ---------------------------------------------------------------------
  // Fail-closed: nothing in these packages may be unreadable.
  // ---------------------------------------------------------------------
  // A reader that silently drops what it cannot understand reports the same
  // "zero violations" as one that understood everything. This is the assertion
  // that makes every gate below mean something.
  for (const file of TRAIN4_SQL_FILES) {
    for (const u of unparsedSecurityStatements(sources[file])) {
      add('unparsed', `${file}: ${u.reason} @${u.line} (${u.origin}): ${u.lead}`)
    }
  }

  const quota = code(sources[FORWARD.QUOTA])
  const attest = code(sources[FORWARD.ATTEST])

  // =====================================================================
  // INT-CAP-001 — the vocabulary
  // =====================================================================
  // The CHECK must admit all seven, and the FUNCTION's own governed array must
  // name the same seven. Two lists that can disagree are one list plus a latent
  // bug: a capability the CHECK admits but the function rejects is a capability
  // that can be recorded and never charged — which is the exact failure
  // INT-CAP-001 reports, reintroduced one layer down.
  const checkClause =
    /ADD CONSTRAINT stella_interactions_stella_role_check\s+CHECK \(stella_role IN \(([\s\S]*?)\)\)/.exec(quota)
  require_('quota-role-vocabulary', checkClause !== null,
    `${FORWARD.QUOTA}: the stella_role CHECK is not added in the expected form, so nothing states which capabilities are chargeable`)
  const governedArray = /v_governed\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/.exec(quota)
  require_('quota-role-vocabulary', governedArray !== null,
    `${FORWARD.QUOTA}: consume_stella_quota declares no governed vocabulary array, so any string reaching it would be chargeable`)

  for (const role of GOVERNED_STELLA_ROLES) {
    require_('quota-role-vocabulary',
      checkClause !== null && checkClause[1].includes(`'${role}'`),
      `${FORWARD.QUOTA}: the stella_role CHECK does not admit '${role}'`)
    require_('quota-role-vocabulary',
      governedArray !== null && governedArray[1].includes(`'${role}'`),
      `${FORWARD.QUOTA}: consume_stella_quota's governed array does not name '${role}', so the CHECK and the function disagree about what may be charged`)
  }

  // =====================================================================
  // INT-CAP-001 — the function that makes the vocabulary chargeable
  // =====================================================================
  const quotaFn = parseFunctions(sources[FORWARD.QUOTA])
    .find((f) => f.name === 'uellix_stella.consume_stella_quota')
  require_('quota-transactional-path', quotaFn !== undefined,
    `${FORWARD.QUOTA}: uellix_stella.consume_stella_quota is missing — the quota can still be read and not consumed, which is the whole of INT-CAP-001`)

  if (quotaFn !== undefined) {
    const body = code(quotaFn.body)

    // The read and the write are ONE call. A signature that returned a
    // decision for the caller to act on would reinstate the two-statement
    // race INT-CAP-001 reports, with a governed-looking name on it.
    require_('quota-transactional-path',
      /INSERT INTO public\.stella_interactions\b/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota never writes to the ledger, so it decides without charging`)
    require_('quota-transactional-path',
      /count\(\*\)[\s\S]*?FROM public\.stella_interactions/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota never counts the ledger, so it charges without deciding`)

    // The lock, and — the half that actually matters — the lock BEFORE the
    // count. A lock taken after the usage is read protects nothing: both
    // transactions have already read the same number.
    const lock = body.search(/pg_advisory_xact_lock/)
    const count = body.search(/count\(\*\)/)
    require_('quota-advisory-lock', lock !== -1,
      `${FORWARD.QUOTA}: consume_stella_quota takes no advisory lock, so two concurrent callers both observe used = quota - 1 and both charge`)
    require_('quota-advisory-lock', lock !== -1 && count !== -1 && lock < count,
      `${FORWARD.QUOTA}: consume_stella_quota counts the ledger BEFORE it takes the lock, which serialises nothing — both transactions read the same usage and only then queue`)
    // Namespaced, so it cannot alias grounding_0002's evidence-item lock, which
    // hashes a bare uuid text with the same primitive and the same seed.
    require_('quota-advisory-lock',
      /hashtextextended\(\s*'stella\/quota\/'/.test(body),
      `${FORWARD.QUOTA}: the advisory lock key is not namespaced, so it can collide with another package's lock on an unrelated id`)

    // The limit is compared, and the exhausted case is REPORTED rather than
    // raised — raising would abort the caller's transaction and lose whatever
    // it had already recorded.
    require_('quota-limit-check', /v_used\s*>=\s*v_quota/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota never compares usage against the limit, so the quota is charged and never enforced`)
    require_('quota-limit-check', /'quota_exceeded'/.test(body) && /'no_quota'/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota does not distinguish an exhausted quota from an unassigned one, and the product renders them differently`)

    // SECURITY DEFINER bypasses RLS, so this check IS the boundary.
    require_('quota-caller-boundary',
      /current_user_org_ids/.test(body) && /current_user_is_super_admin/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota never consults the caller's organizations, and SECURITY DEFINER bypasses RLS — any caller holding an organization id could charge that tenant`)
    require_('quota-caller-boundary',
      /FROM public\.projects[\s\S]*?organization_id\s*=\s*p_organization_id/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota does not verify the project belongs to the organization it charges, so a unit can be filed across the boundary`)

    // The actor is derived, never accepted. An argument for it would let a
    // caller charge a unit in someone else's name.
    require_('quota-actor-derived', /auth\.uid\(\)/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota does not derive the actor from the session`)
    require_('quota-actor-derived',
      !/p_(created_by|actor|user_id)\b/.test(quotaFn.header) && !/p_(created_by|actor|user_id)\b/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota accepts the actor as an argument, so a caller can charge a unit in another user's name`)

    // Idempotency: the conflict target, and the fact that a conflict is a
    // no-op rather than a second row.
    require_('quota-idempotency',
      /ON CONFLICT \(organization_id, idempotency_key\)[\s\S]{0,80}?DO NOTHING/.test(body),
      `${FORWARD.QUOTA}: the charge has no ON CONFLICT ... DO NOTHING on (organization_id, idempotency_key), so a retry charges twice`)
    require_('quota-idempotency', /'replayed'/.test(body),
      `${FORWARD.QUOTA}: consume_stella_quota cannot report a replay, so a retried operation is indistinguishable from a fresh charge`)

    // The ledger records that a unit was spent. It does not record what was
    // asked or answered — the same rule the grounded-query audit trail states.
    require_('quota-no-payload-in-ledger',
      !/p_(query|prompt|content|response|answer|text)\b/.test(quotaFn.header),
      `${FORWARD.QUOTA}: consume_stella_quota accepts free text, and the ledger row would then carry a prompt or a passage`)
    require_('quota-no-payload-in-ledger',
      /'\{"kind":"quota_consumption","version":1\}'::jsonb/.test(body),
      `${FORWARD.QUOTA}: response_json is not the fixed literal, so the charge row can carry model output`)
  }

  // The idempotency key: the column, both CHECKs, and the unique index that
  // makes the guarantee a property of the DATA rather than of who called what.
  require_('quota-idempotency',
    /ADD COLUMN IF NOT EXISTS idempotency_key char\(64\)/.test(quota),
    `${FORWARD.QUOTA}: the idempotency_key column is not added, so no row can identify the operation it charged`)
  require_('quota-idempotency',
    /stella_interactions_grounded_query_idempotency_check[\s\S]*?CHECK \(stella_role <> 'grounded_query' OR idempotency_key IS NOT NULL\)/.test(quota),
    `${FORWARD.QUOTA}: nothing makes the key MANDATORY for grounded_query, so the direct write path (uellix_writer's INSERT grant) can charge an unidentified unit`)
  {
    const idx = /CREATE UNIQUE INDEX IF NOT EXISTS uq_stella_interactions_idempotency\s+ON public\.stella_interactions \(([^)]*)\)\s*\n\s*WHERE ([^;]*);/.exec(quota)
    require_('quota-idempotency', idx !== null,
      `${FORWARD.QUOTA}: the idempotency index is missing, not UNIQUE, or has no WHERE predicate`)
    if (idx !== null) {
      require_('quota-idempotency',
        idx[1].replace(/\s+/g, ' ').trim() === 'organization_id, idempotency_key',
        `${FORWARD.QUOTA}: the idempotency index covers (${idx[1].trim()}), not (organization_id, idempotency_key) — a key unique across tenants collides on a boundary neither tenant can see`)
      require_('quota-idempotency',
        idx[2].trim() === 'idempotency_key IS NOT NULL',
        `${FORWARD.QUOTA}: the idempotency index predicate is "${idx[2].trim()}", so the five pre-existing Stella roles (which carry no key) would collide on the second row`)
    }
  }

  // The write policy that binds the definer. The definer holds no BYPASSRLS,
  // so with no policy it could not charge at all — and with a widened one it
  // could charge anything.
  {
    const insertPolicies = parsePolicies(sources[FORWARD.QUOTA])
      .filter((p) => p.command === 'INSERT')
    require_('quota-definer-insert-policy', insertPolicies.length === 1,
      `${FORWARD.QUOTA}: expected exactly 1 INSERT policy, found ${insertPolicies.length}`)
    for (const p of insertPolicies) {
      require_('quota-definer-insert-policy',
        p.roles.length === 1 && p.roles.includes(QUOTA_ROLE),
        `${FORWARD.QUOTA}: policy ${p.name} names [${p.roles.join(', ')}] rather than only ${QUOTA_ROLE}`)
      const check = p.withCheck ?? ''
      for (const [fragment, why] of [
        ['created_by = auth.uid()', 'the actor is not tied to the session'],
        ['idempotency_key IS NOT NULL', 'an unidentified charge is representable'],
        ['current_user_org_ids', 'the ledger charged is not tied to the caller'],
        ['organization_id = stella_interactions.organization_id', 'the project charged is not tied to the organization charged'],
      ] as const) {
        require_('quota-definer-insert-policy', check.includes(fragment),
          `${FORWARD.QUOTA}: policy ${p.name} does not state "${fragment}" — ${why}, so the invariant lives only in the function body`)
      }
    }
  }

  // =====================================================================
  // INT-GR-004 — the attested read path
  // =====================================================================
  const attestFn = parseFunctions(sources[FORWARD.ATTEST])
    .find((f) => f.name === 'uellix_grounding.chunks_in_scope_attested')
  require_('scope-attestation-columns', attestFn !== undefined,
    `${FORWARD.ATTEST}: uellix_grounding.chunks_in_scope_attested is missing, so the repository adapter still has no row to compare its request against`)

  if (attestFn !== undefined) {
    const returns = /RETURNS TABLE \(([\s\S]*?)\n\)/.exec(attestFn.header)
    const body = code(attestFn.body)
    require_('scope-attestation-columns', returns !== null,
      `${FORWARD.ATTEST}: chunks_in_scope_attested declares no RETURNS TABLE shape`)

    for (const column of SCOPE_ATTESTATION_COLUMNS) {
      require_('scope-attestation-columns',
        returns !== null && new RegExp(`^\\s*${column} uuid`, 'm').test(returns[1]),
        `${FORWARD.ATTEST}: chunks_in_scope_attested does not declare ${column} in its result, so a caller cannot read that column off the row`)
      // Declared AND selected from the ROW. A column that is declared and then
      // filled from the argument is the tautology INT-GR-004 reports, moved one
      // layer down where it is harder to see — so it is checked separately.
      require_('scope-attestation-not-echoed',
        new RegExp(`\\bch\\.${column}\\b`).test(body),
        `${FORWARD.ATTEST}: chunks_in_scope_attested does not select ch.${column} from the row`)
    }
    require_('scope-attestation-not-echoed',
      !/SELECT[\s\S]*?\bp_(organization_id|project_id|document_version_id)\b[\s\S]*?FROM public\.evidence_chunks/.test(body),
      `${FORWARD.ATTEST}: chunks_in_scope_attested echoes an ARGUMENT into its result instead of reading the row — the returned scope would agree with the requested scope by construction, which is exactly the tautology INT-GR-004 asks to remove`)

    // The boundary the definer must re-impose, and the four predicates that
    // make the read exact.
    require_('scope-boundary-check',
      /current_user_org_ids/.test(body) || /current_user_is_super_admin/.test(body),
      `${FORWARD.ATTEST}: chunks_in_scope_attested never consults the caller's organizations, and SECURITY DEFINER bypasses RLS`)
    for (const predicate of [
      'ch.document_version_id = p_document_version_id',
      'ch.organization_id = p_organization_id',
      'ch.project_id = p_project_id',
      'ch.canonical_chunk_id IS NULL',
    ]) {
      require_('scope-boundary-check', body.includes(predicate),
        `${FORWARD.ATTEST}: chunks_in_scope_attested does not filter "${predicate}"${predicate.includes('canonical') ? ' — a suppressed duplicate would be citable as if it were the passage' : ''}`)
    }
  }

  // =====================================================================
  // INT-CAP-002 — the read surface
  // =====================================================================
  {
    const analysis = analyzeSecurity(sources[FORWARD.ATTEST])
    const revoked = analysis.revokes.some(
      (r) => r.objectType === 'TABLE' && r.object === 'public.evidence_chunks' &&
        r.grantees.includes('authenticated'),
    )
    require_('chunk-read-surface', revoked,
      `${FORWARD.ATTEST}: SELECT on public.evidence_chunks is not revoked from authenticated, so PostgREST still reaches chunk rows around the governed reader and around its canonical_chunk_id filter`)
    for (const g of analysis.grants) {
      if (g.objectType !== 'TABLE') continue
      require_('chunk-read-surface', !g.grantees.includes('authenticated'),
        `${FORWARD.ATTEST}: GRANT ... ON ${g.object} TO authenticated re-opens the surface this package exists to close`)
    }
    for (const p of parsePolicies(sources[FORWARD.ATTEST])) {
      // Scoped to the CHUNK table. INT-CAP-002 is about the chunk index, and
      // this package also re-creates the VERSION table's read policy (§2a) —
      // which legitimately keeps `authenticated`, because removing PostgREST's
      // read of the version history is a separate change nobody asked for.
      require_('chunk-read-surface',
        p.table !== 'public.evidence_chunks' || !p.roles.includes('authenticated'),
        `${FORWARD.ATTEST}: policy ${p.name} still names authenticated`)
      require_('chunk-read-surface', p.roles.length > 0,
        `${FORWARD.ATTEST}: policy ${p.name} has no TO clause, so it applies to PUBLIC`)
    }
  }

  // =====================================================================
  // TRAIN 4 FINDING — the capability role must be able to READ
  // =====================================================================
  // Found by invoking the governed reader against seeded rows, not by reading
  // the SQL: `uellix_cap_grounding` holds SELECT on both grounding tables and
  // was named by NEITHER permissive SELECT policy, so — holding no BYPASSRLS
  // and owning neither table — every SECURITY DEFINER read returned the empty
  // set. Silently. chunks_in_scope answered nothing, finalize_document_ingestion
  // always reported an incomplete ingestion, and register_document_version
  // never saw a previous version, which pinned every document at ordinal 1.
  //
  // Both policies are re-created under their OWN names rather than added to:
  // grounding_0002 §9 asserts exactly 3 policies on the version table and
  // grounding_0003 §9 exactly 4 on the chunk table, so a fifth would make
  // re-applying either package fail its own postcondition.
  {
    const selectPolicies = parsePolicies(sources[FORWARD.ATTEST])
      .filter((p) => p.command === 'SELECT' && p.permissive === 'PERMISSIVE')
    for (const table of ['public.evidence_chunks', 'public.evidence_document_versions']) {
      const p = selectPolicies.find((x) => x.table === table)
      require_('definer-read-policy', p !== undefined,
        `${FORWARD.ATTEST}: no PERMISSIVE SELECT policy is re-created for ${table}, so ${GROUNDING_ROLE} keeps reading the empty set through every governed function`)
      require_('definer-read-policy',
        p === undefined || p.roles.includes(GROUNDING_ROLE),
        `${FORWARD.ATTEST}: the SELECT policy on ${table} does not name ${GROUNDING_ROLE}. It holds SELECT and no BYPASSRLS, so RLS returns nothing to the definer and the failure is invisible — a missing GRANT raises, a missing POLICY does not`)
      // The predicate must be the one it replaces. A policy that named the
      // role and dropped the organization bound would turn a read repair into
      // a tenancy hole.
      require_('definer-read-policy',
        p === undefined || (p.using ?? '').includes('current_user_org_ids'),
        `${FORWARD.ATTEST}: the SELECT policy on ${table} no longer bounds rows by the caller's organizations`)
    }
  }

  // =====================================================================
  // INT-CAP-003 / INT-CAP-004 — integrity the table owner cannot step around
  // =====================================================================
  // CHECK constraints, not triggers: a CHECK binds the owner (the adversary
  // INT-CAP-004 names) and cannot be silenced by session_replication_role.
  require_('content-hash-derivation',
    /ADD CONSTRAINT evidence_chunks_content_hash_derivation_check\s+CHECK \(content IS NULL\s+OR content_hash = encode\(sha256\(convert_to\(content, 'UTF8'\)\), 'hex'\)\)/.test(attest),
    `${FORWARD.ATTEST}: nothing verifies content_hash against sha256(content), so the server-derived chunk_id certifies a digest the caller chose (INT-CAP-003)`)
  require_('span-length-bound',
    /ADD CONSTRAINT evidence_chunks_span_length_check[\s\S]{0,400}?length\(content\)/.test(attest),
    `${FORWARD.ATTEST}: the declared span is never contrasted with the stored text, so char_start/char_end can describe a passage that is not there (INT-CAP-003)`)
  require_('span-length-bound',
    /\(char_end - char_start\) >= length\(content\)[\s\S]{0,120}?\(char_end - char_start\) <= 2 \* length\(content\)/.test(attest),
    `${FORWARD.ATTEST}: the span check is not the two-sided UTF-16/code-point bound. A bare equality rejects any passage containing a character outside the BMP, and a one-sided bound admits an arbitrarily long declared span`)
  require_('chunk-id-derivation-check',
    /ADD CONSTRAINT evidence_chunks_chunk_id_derivation_check\s+CHECK \(chunk_id = encode\(sha256\(convert_to\(/.test(attest),
    `${FORWARD.ATTEST}: chunk_id's derivation is not stated as a constraint, so it remains a property of insert_evidence_chunks' body — which uellix_owner does not go through (INT-CAP-004)`)
  require_('chunk-id-derivation-check',
    /'grounding\/chunk\/v1' \|\| chr\(10\) \|\| version_id \|\| chr\(10\)\s*\|\| chunk_index::text \|\| chr\(10\) \|\| content_hash/.test(attest),
    `${FORWARD.ATTEST}: the constraint's preimage is not deriveChunkId's, so a row the contract calls valid would be refused, or one it calls invalid accepted`)

  // =====================================================================
  // SECURITY DEFINER contract — both packages
  // =====================================================================
  const definerOwner: Record<string, string> = {
    [FORWARD.QUOTA]: QUOTA_ROLE,
    [FORWARD.ATTEST]: GROUNDING_ROLE,
  }
  const allFunctions = forwardFiles
    .flatMap((f) => parseFunctions(sources[f]).map((fn) => ({ file: f, ...fn })))
    .filter((fn) => fn.name.startsWith('uellix_stella.') || fn.name.startsWith('uellix_grounding.'))
  require_('definer-inventory', allFunctions.length === 2,
    `expected 2 SECURITY DEFINER functions across the two Train 4 packages, found ${allFunctions.length}`)

  for (const fn of allFunctions) {
    // Comments are stripped before every body assertion. Without it a comment
    // that NAMES a forbidden construct fires the gate that exists to forbid it,
    // and the fix would be to delete the explanation.
    const body = code(fn.body)
    const owner = definerOwner[fn.file]
    // Nested-paren-tolerant: char(64) and varchar(50) carry their own
    // parentheses, and a `[^)]*` signature stops at the first one.
    const signature = `${fn.name.replace(/\./g, '\\.')}\\((?:[^()]|\\([^()]*\\))*\\)`

    require_('definer-security', /\bSECURITY DEFINER\b/.test(fn.header),
      `${fn.file}: ${fn.name} is not SECURITY DEFINER`)
    require_('definer-search-path', /SET search_path = ''/.test(fn.header),
      `${fn.file}: ${fn.name} does not pin search_path to the empty string — with pg_temp reachable a caller shadows an unqualified name and the definer runs it`)
    require_('definer-owner',
      new RegExp(`ALTER FUNCTION ${signature}\\s*\\n?\\s*OWNER TO ${owner}`).test(sources[fn.file]),
      `${fn.file}: ${fn.name} is not owned by ${owner}`)
    require_('definer-acl',
      new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`).test(sources[fn.file]),
      `${fn.file}: EXECUTE on ${fn.name} is not revoked from PUBLIC, which is the default grantee`)
    require_('definer-acl',
      new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO ${RUNTIME_ROLE}`).test(sources[fn.file]),
      `${fn.file}: ${fn.name} has no EXECUTE grant to ${RUNTIME_ROLE}, so the runtime cannot reach the governed path at all`)
    require_('definer-no-star', !/\bSELECT \*(?!\s*INTO)/.test(body),
      `${fn.file}: ${fn.name} uses SELECT * outside a %ROWTYPE fetch, so a column added later silently changes its result shape`)
    require_('definer-no-dynamic-sql', !/\bEXECUTE\b/.test(body),
      `${fn.file}: ${fn.name} contains EXECUTE. A definer must not compose SQL`)
    // An error message is a channel. A definer that interpolates an id or a
    // digest into a RAISE hands an untrusted caller an oracle.
    for (const raise of body.match(/RAISE EXCEPTION[\s\S]*?;/g) ?? []) {
      require_('definer-error-detail', !/\bp_[a-z_]+\b/.test(raise),
        `${fn.file}: ${fn.name} interpolates an argument into an error message, which turns a refusal into an oracle`)
    }
  }

  // =====================================================================
  // Privilege — nothing writes but the capability roles
  // =====================================================================
  for (const file of forwardFiles) {
    const analysis = analyzeSecurity(sources[file])
    for (const g of analysis.grants) {
      if (g.objectType !== 'TABLE') continue
      for (const grantee of g.grantees) {
        for (const priv of g.privileges) {
          const isWrite = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALL']
            .includes(priv.privilege.toUpperCase())
          require_('train4-write-grant',
            !isWrite || grantee === QUOTA_ROLE || grantee === GROUNDING_ROLE,
            `${file}: GRANT ${priv.privilege} ON ${g.object} TO ${grantee} — only a capability role may write`)
          require_('train4-write-grant',
            !['UPDATE', 'DELETE', 'TRUNCATE', 'ALL'].includes(priv.privilege.toUpperCase()),
            `${file}: GRANT ${priv.privilege} ON ${g.object} TO ${grantee} — both ledgers are append-only, so no principal may erase`)
        }
        require_('train4-write-grant', !g.grantOption,
          `${file}: GRANT ... ON ${g.object} TO ${grantee} carries WITH GRANT OPTION, so the grantee can re-grant it`)
        require_('train4-write-grant',
          !['public', 'anon', 'service_role'].includes(grantee),
          `${file}: GRANT ... ON ${g.object} TO ${grantee} — that principal is reachable without a Uellix session`)
      }
    }
  }

  // The append-only ledger's writer must be told, explicitly, that it cannot
  // erase. Stated as a REVOKE rather than left to "we never granted it": a
  // future ALTER DEFAULT PRIVILEGES is exactly the surplus that left four audit
  // tables TRUNCATE-able and forced stella_0002b.
  {
    const revokes = analyzeSecurity(sources[FORWARD.QUOTA]).revokes
    require_('quota-ledger-append-only',
      revokes.some((r) =>
        r.objectType === 'TABLE' && r.object === 'public.stella_interactions' &&
        r.grantees.includes(QUOTA_ROLE) &&
        ['UPDATE', 'DELETE', 'TRUNCATE'].every((p) =>
          r.privileges.some((x) => x.privilege.toUpperCase() === p))),
      `${FORWARD.QUOTA}: UPDATE, DELETE and TRUNCATE are not revoked from ${QUOTA_ROLE} on the ledger — an append-only trail whose writer can erase is not one`)
  }

  // =====================================================================
  // The capability role
  // =====================================================================
  {
    const analysis = analyzeSecurity(sources[FORWARD.QUOTA])
    const alters = analysis.roleStatements.filter((r) => r.role === QUOTA_ROLE && r.verb === 'ALTER')
    require_('role-attributes', alters.length > 0,
      `${FORWARD.QUOTA}: no ALTER ROLE for ${QUOTA_ROLE}`)
    for (const attr of ['NOLOGIN', 'NOSUPERUSER', 'NOCREATEROLE', 'NOBYPASSRLS', 'NOINHERIT']) {
      require_('role-attributes', alters.some((r) => r.attributes.includes(attr)),
        `${FORWARD.QUOTA}: ${QUOTA_ROLE} is not declared ${attr}`)
    }
  }

  // Zero members, in either direction. A member would make the write path
  // reachable by SET ROLE from a real connection string — `uellix_migrator` is
  // a LOGIN role that already reaches `uellix_owner`.
  for (const file of TRAIN4_SQL_FILES) {
    for (const g of analyzeSecurity(sources[file]).grants) {
      if (g.objectType !== 'ROLE') continue
      for (const role of [QUOTA_ROLE, GROUNDING_ROLE]) {
        require_('role-zero-members',
          !g.grantees.includes(role) && g.object !== role,
          `${file}: role membership ${g.raw.trim()} gives ${role} a member or a membership`)
      }
    }
  }

  // =====================================================================
  // Rollbacks
  // =====================================================================
  // INT-CAP-004 (1), as a property rather than a string match.
  for (const file of rollbackFiles) {
    for (const problem of conditionalFunctionDrops(sources[file])) {
      add('rollback-function-drop-unconditional',
        `${file}: ${problem} — a database whose table went by another route would get a rollback that reports success and leaves a callable SECURITY DEFINER function behind`)
    }
  }

  // The destructive statement must live INSIDE the DO block. A guard in a DO
  // block followed by a top-level DROP is two statements, and without
  // ON_ERROR_STOP psql reports the first and sends the second.
  for (const file of rollbackFiles) {
    for (const stmt of topLevelStatements(sources[file])) {
      require_('rollback-single-block', !/^\s*(?:DROP|ALTER|REVOKE)\b/i.test(stmt),
        `${file}: "${stmt.trim().slice(0, 60)}" is a TOP-LEVEL destructive statement. Only psql flags would separate it from the guard above it`)
    }
  }

  for (const file of rollbackFiles) {
    require_('rollback-no-cascade', !/DROP [\s\S]{0,80}?CASCADE/.test(code(sources[file])),
      `${file}: a DROP ... CASCADE would silently take objects this rollback never named`)
  }

  // Convergence: each rollback must restate the end state it returns to, not
  // merely delete what it added. A rollback that drops without restoring
  // leaves a database that matches neither the before nor the after.
  {
    const rb = code(sources[ROLLBACK.QUOTA])
    require_('rollback-convergence',
      /ADD CONSTRAINT stella_interactions_stella_role_check[\s\S]*?audit_assistant/.test(rb) &&
        !/ADD CONSTRAINT stella_interactions_stella_role_check[\s\S]*?grounded_query/.test(rb),
      `${ROLLBACK.QUOTA}: the six-value stella_role CHECK is not restored, so the ledger keeps a vocabulary the package is supposed to have removed`)
    require_('rollback-convergence', /DROP COLUMN IF EXISTS idempotency_key/.test(rb),
      `${ROLLBACK.QUOTA}: the idempotency_key column survives the rollback`)
    require_('rollback-convergence', /DROP ROLE uellix_cap_stella_quota/.test(rb),
      `${ROLLBACK.QUOTA}: the capability role survives the rollback`)
    // DROP ROLE is blocked by PRIVILEGES HELD as well as by ownership. Every
    // grant §1 makes on an object the package does not drop must be revoked by
    // NAME, or the role cannot be dropped at all — the defect the grounding
    // train only found by RUNNING its rollback.
    for (const target of [
      'public.current_user_org_ids()',
      'public.current_user_is_super_admin()',
      'auth.uid()',
      'public.organizations',
      'public.projects',
      'public.stella_interactions',
    ]) {
      require_('rollback-convergence',
        new RegExp(`REVOKE [^']*${target.replace(/[.()]/g, '\\$&')} FROM ${QUOTA_ROLE}`).test(rb),
        `${ROLLBACK.QUOTA}: the grant on ${target} is never revoked, so DROP ROLE ${QUOTA_ROLE} fails with "some objects depend on it" and the rollback aborts half-done`)
    }
  }
  {
    const rb = code(sources[ROLLBACK.ATTEST])
    require_('rollback-convergence',
      /CREATE POLICY "evidence_chunks_select"[\s\S]*?authenticated/.test(rb) &&
        /GRANT SELECT ON public\.evidence_chunks TO authenticated/.test(rb),
      `${ROLLBACK.ATTEST}: grounding_0003's read surface is not restored, so the database matches neither the state before this package nor the state after it`)
    require_('rollback-convergence',
      /RAISE WARNING[\s\S]{0,400}?INT-CAP-002/.test(rb),
      `${ROLLBACK.ATTEST}: re-widening the read surface is not announced, so an operator learns nothing about what the rollback just re-opened`)
    require_('rollback-convergence',
      /to_regprocedure\('uellix_grounding\.chunks_in_scope\(uuid, uuid, uuid\)'\) IS NULL/.test(rb),
      `${ROLLBACK.ATTEST}: nothing asserts grounding_0003's reader survived, so a DROP naming the wrong signature would take it unnoticed`)
    // The version table's read policy is grounding_0002's, and this package
    // replaced it too. A rollback that restores one policy and not the other
    // leaves the definer readable on one table and blind on the next.
    require_('rollback-convergence',
      /CREATE POLICY "evidence_document_versions_select"/.test(rb),
      `${ROLLBACK.ATTEST}: the version table's SELECT policy is not restored, so the database keeps a policy grounding_0002 did not write and its own postcondition never mentions`)
  }

  // The refusal INT-CAP-001's append-only ledger forces. Narrowing the CHECK
  // over charged rows is impossible, and saying so beats letting the operator
  // read a raw constraint violation and guess.
  require_('rollback-refuses-charged-ledger',
    /stella_role = 'grounded_query'/.test(code(sources[ROLLBACK.QUOTA])) &&
      /RAISE EXCEPTION[\s\S]{0,400}?rollback refused/.test(code(sources[ROLLBACK.QUOTA])),
    `${ROLLBACK.QUOTA}: nothing counts the charged rows before narrowing the vocabulary, so the rollback fails with a raw constraint violation instead of an explanation`)

  // =====================================================================
  // Self-verification inside the same transaction
  // =====================================================================
  for (const file of forwardFiles) {
    const sql = sources[file]
    require_('self-verification', /FAILED verification/.test(sql),
      `${file}: the script asserts nothing about the state it leaves behind`)
    require_('self-verification', /aclexplode/.test(sql),
      `${file}: privileges are not verified through aclexplode, so an inherited or superuser privilege would read as absent`)
    require_('self-verification', /pg_auth_members/.test(sql),
      `${file}: nothing verifies that the capability role still has zero members`)
  }

  // An EXCEPTION handler inside a guard swallows its RAISE and lets everything
  // after it run with the whole suite green.
  for (const file of TRAIN4_SQL_FILES) {
    require_('no-exception-handler', !/\bEXCEPTION\s+WHEN\b/.test(code(sources[file])),
      `${file}: an EXCEPTION WHEN handler can swallow a guard's RAISE and let the statements after it run`)
  }

  return v
}
