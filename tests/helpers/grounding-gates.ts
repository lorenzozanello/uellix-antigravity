// tests/helpers/grounding-gates.ts
//
// The static contract for the grounding persistence packages (GR-001/GR-002),
// as a PURE FUNCTION over file contents.
//
// It is a pure function for the same reason tests/helpers/capability-gates.ts
// is: tests/grounding-persistence-mutation.test.ts has to run exactly this code
// over deliberately broken copies. A gate that lives inside an assertion which
// reads the disk itself cannot be shown to go red, and a gate that has never
// gone red is indistinguishable from a gate that cannot.
//
// It reuses tests/helpers/sql-structure.ts — the PostgreSQL lexer the
// capability campaign already relies on — rather than matching regexes over
// masked text. That matters here for one concrete reason: every DCL statement
// in these packages is written plainly, but the reader descends into `DO`
// bodies, function bodies and `EXECUTE` literals, so a REVOKE moved inside a
// block still counts, and a composed statement is REFUSED (`unparsed`) instead
// of silently skipped.
//
// SCOPE. These gates judge the four grounding files and nothing else. They are
// deliberately NOT folded into evaluateCapabilityGates(): that contract encodes
// per-file policy and grant tables for the five public-capability packages, and
// widening it to a sixth family would have meant relaxing assertions that are
// exact today ("five forward scripts", "covers all five capabilities").

import {
  analyzeSecurity,
  parsePolicies,
  unparsedSecurityStatements,
  type ParsedPolicy,
} from './sql-structure'

export const FORWARD = {
  VERSIONS: 'grounding_0002_document_versions.sql',
  CHUNKS: 'grounding_0003_evidence_chunks.sql',
} as const

export const ROLLBACK = {
  VERSIONS: 'grounding_0002_rollback.sql',
  CHUNKS: 'grounding_0003_rollback.sql',
} as const

export const GROUNDING_SQL_FILES = [
  FORWARD.VERSIONS,
  ROLLBACK.VERSIONS,
  FORWARD.CHUNKS,
  ROLLBACK.CHUNKS,
] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** The definer role. Zero members, by design — see grounding_0002 §1. */
const DEFINER_ROLE = 'uellix_cap_grounding'

/** Principals that must never hold a write privilege on either table. */
const NON_WRITERS = [
  'public',
  'anon',
  'authenticated',
  'service_role',
  'uellix_app',
  'uellix_writer',
  'uellix_auditor',
] as const

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALL'] as const

/** The six columns GR-001 §5 makes acceptance conditional on. */
export const GR001_PROVENANCE_COLUMNS = [
  'chunk_id',
  'version_id',
  'raw_content_hash',
  'normalized_content_hash',
  'normalization_version',
  'chunker_version',
] as const

/** The columns GR-002 §2 asks the version table to carry. */
export const GR002_HISTORY_COLUMNS = [
  'organization_id',
  'evidence_id',
  'version_id',
  'raw_content_hash',
  'normalized_content_hash',
  'normalization_version',
  'ordinal',
  'supersedes_version_id',
  'created_at',
] as const

interface ParsedFunction {
  readonly name: string
  /** Everything between the argument list and the opening dollar quote. */
  readonly header: string
  readonly body: string
}

/**
 * The CREATE TABLE body for one table, or null.
 *
 * Deliberately anchored on `CREATE TABLE IF NOT EXISTS public.<name> (` and the
 * closing `\n);`: every table in this repo's prepared SQL is written that way,
 * and a table that is not cannot be judged by the column gates — so returning
 * null makes the gate fire rather than pass vacuously.
 */
function createTableBody(sql: string, table: string): string | null {
  const open = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`)
  if (open === -1) return null
  const close = sql.indexOf('\n);', open)
  if (close === -1) return null
  return sql.slice(open, close)
}

/** Every `CREATE OR REPLACE FUNCTION ... AS $$ ... $$;` in the file. */
export function parseFunctions(sql: string): ParsedFunction[] {
  const out: ParsedFunction[] = []
  const re = /CREATE OR REPLACE FUNCTION\s+([\w.]+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const bodyOpen = sql.indexOf('AS $$', m.index)
    if (bodyOpen === -1) continue
    const bodyClose = sql.indexOf('$$;', bodyOpen + 5)
    if (bodyClose === -1) continue
    out.push({
      name: m[1],
      header: sql.slice(m.index, bodyOpen),
      body: sql.slice(bodyOpen + 5, bodyClose),
    })
  }
  return out
}

/** Strip `--` line comments so prose cannot satisfy — or trip — a gate. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

export function evaluateGroundingGates(sources: Sources): Violation[] {
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
  for (const file of GROUNDING_SQL_FILES) {
    if (typeof sources[file] !== 'string' || sources[file].length === 0) {
      add('source-missing', `${file} is absent or empty`)
    }
  }
  if (v.length > 0) return v

  const forwardFiles = [FORWARD.VERSIONS, FORWARD.CHUNKS] as const
  const rollbackFiles = [ROLLBACK.VERSIONS, ROLLBACK.CHUNKS] as const

  // ---------------------------------------------------------------------
  // Fail-closed: nothing in these packages may be unreadable.
  // ---------------------------------------------------------------------
  // A reader that silently drops what it cannot understand reports the same
  // "zero violations" as one that understood everything. This is the assertion
  // that makes every gate below mean something.
  for (const file of GROUNDING_SQL_FILES) {
    for (const u of unparsedSecurityStatements(sources[file])) {
      add('unparsed', `${file}: ${u.reason} @${u.line} (${u.origin}): ${u.lead}`)
    }
  }

  // =====================================================================
  // Isolation — organization AND project
  // =====================================================================
  const versionsTable = createTableBody(sources[FORWARD.VERSIONS], 'evidence_document_versions')
  const chunksTable = createTableBody(sources[FORWARD.CHUNKS], 'evidence_chunks')

  require_('scope-table-shape', versionsTable !== null,
    `${FORWARD.VERSIONS}: public.evidence_document_versions is not created in the expected form`)
  require_('scope-table-shape', chunksTable !== null,
    `${FORWARD.CHUNKS}: public.evidence_chunks is not created in the expected form`)

  for (const [file, body, table] of [
    [FORWARD.VERSIONS, versionsTable, 'evidence_document_versions'],
    [FORWARD.CHUNKS, chunksTable, 'evidence_chunks'],
  ] as const) {
    if (body === null) continue
    // NOT NULL on both, and it is the NOT NULL that carries the guarantee: a
    // nullable project_id makes every project-scoped predicate need an
    // `OR IS NULL` branch, and such a branch can only ever widen the boundary.
    for (const column of ['organization_id', 'project_id']) {
      require_('scope-columns',
        new RegExp(`^\\s*${column} uuid NOT NULL REFERENCES public\\.`, 'm').test(body),
        `${file}: ${table}.${column} is not a NOT NULL uuid with a foreign key`)
    }
  }

  // The RESTRICTIVE policy states the isolation invariant a second time, for
  // every command and every role. It can only narrow, so it is the one policy
  // a future permissive addition cannot widen past.
  for (const file of forwardFiles) {
    const restrictive = parsePolicies(sources[file]).filter((p) => p.permissive === 'RESTRICTIVE')
    require_('scope-restrictive', restrictive.length === 1,
      `${file}: expected exactly 1 RESTRICTIVE policy, found ${restrictive.length}`)
    for (const p of restrictive) {
      require_('scope-restrictive', p.command === 'ALL',
        `${file}: RESTRICTIVE policy ${p.name} is FOR ${p.command}, not FOR ALL`)
      require_('scope-restrictive', p.using !== null && p.using !== 'true',
        `${file}: RESTRICTIVE policy ${p.name} carries no bounding predicate`)
      require_('scope-restrictive',
        p.using !== null && p.using.includes('organization_id') && p.using.includes('project_id'),
        `${file}: RESTRICTIVE policy ${p.name} does not tie the row to both organization_id and project_id`)
      require_('scope-restrictive', p.roles.includes(DEFINER_ROLE),
        `${file}: RESTRICTIVE policy ${p.name} does not cover ${DEFINER_ROLE}, the one role that writes`)
    }
  }

  // Every policy names its roles. A policy with no TO clause applies to PUBLIC
  // — the exact defect stella_0005c had to repair, where three unscoped INSERT
  // policies re-activated pre-cutover grants through PostgREST.
  for (const file of forwardFiles) {
    for (const p of parsePolicies(sources[file])) {
      require_('policy-to-clause', p.roles.length > 0,
        `${file}: policy ${p.name} has no TO clause, so it applies to PUBLIC`)
      for (const role of p.roles) {
        require_('policy-to-clause',
          !['public', 'anon', 'service_role'].includes(role),
          `${file}: policy ${p.name} names ${role}`)
      }
      // A policy with no clause bounds nothing — and so does one whose every
      // clause is the literal `true`. Comparing the FILTERED list to ['true']
      // would let a FOR ALL policy with USING (true) WITH CHECK (true) — the
      // fully unbounded shape, and the exact one worth forbidding — pass as
      // ['true','true'].
      const clauses = [p.using, p.withCheck].filter((c): c is string => c !== null)
      require_('policy-predicate',
        clauses.length > 0 && !clauses.every((c) => c === 'true'),
        `${file}: policy ${p.name} bounds nothing — it carries no USING/WITH CHECK, or every clause it has is the constant true`)
    }
  }

  // =====================================================================
  // Privilege — only the definer writes
  // =====================================================================
  for (const file of forwardFiles) {
    const analysis = analyzeSecurity(sources[file])

    for (const g of analysis.grants) {
      if (g.objectType !== 'TABLE') continue
      for (const grantee of g.grantees) {
        for (const priv of g.privileges) {
          const isWrite = (WRITE_PRIVILEGES as readonly string[]).includes(priv.privilege.toUpperCase())
          require_('table-write-grant',
            !isWrite || grantee === DEFINER_ROLE,
            `${file}: GRANT ${priv.privilege} ON ${g.object} TO ${grantee} — only ${DEFINER_ROLE} may write`)
        }
        require_('table-write-grant',
          !g.grantOption,
          `${file}: GRANT ... ON ${g.object} TO ${grantee} carries WITH GRANT OPTION, so the grantee can re-grant it`)
      }
    }

    // REVOKE ALL before granting anything back. Enumerating privileges to
    // remove silently misses whatever a future PostgreSQL or Supabase bootstrap
    // adds — that surplus (`Dxtm` to authenticated) is what left four audit
    // tables TRUNCATE-able and forced stella_0002b.
    const table = file === FORWARD.VERSIONS
      ? 'public.evidence_document_versions'
      : 'public.evidence_chunks'
    for (const principal of NON_WRITERS) {
      const revoked = analysis.revokes.some(
        (r) => r.objectType === 'TABLE' && r.object === table &&
          r.grantees.includes(principal) &&
          r.privileges.some((p) => p.privilege.toUpperCase() === 'ALL'),
      )
      require_('revoke-all-first', revoked,
        `${file}: no REVOKE ALL ON ${table} FROM ${principal}`)
    }
  }

  // The version history is the one table with no DELETE grant anywhere. Chunks
  // are a derived index and a reindex legitimately deletes them; a chain of
  // custody has no such story.
  {
    const analysis = analyzeSecurity(sources[FORWARD.VERSIONS])
    for (const g of analysis.grants) {
      if (g.objectType !== 'TABLE') continue
      for (const p of g.privileges) {
        require_('history-no-delete',
          !['DELETE', 'UPDATE', 'TRUNCATE'].includes(p.privilege.toUpperCase()),
          `${FORWARD.VERSIONS}: GRANT ${p.privilege} ON ${g.object} TO ${g.grantees.join(', ')} — the version history is append-only for every role`)
      }
    }
  }

  // =====================================================================
  // Append-only / immutability
  // =====================================================================
  {
    const policies = parsePolicies(sources[FORWARD.VERSIONS])
    for (const p of policies) {
      require_('history-append-only',
        p.command !== 'UPDATE' && p.command !== 'DELETE',
        `${FORWARD.VERSIONS}: policy ${p.name} is FOR ${p.command}. The version history is append-only, so those are denied by absence`)
    }
    for (const problem of triggerProblems(sources[FORWARD.VERSIONS], 'public.evidence_document_versions', [
      { events: ['UPDATE', 'DELETE'], level: 'ROW' },
      { events: ['TRUNCATE'], level: 'STATEMENT' },
      // TRAIN 3, risk #5 — the owner-proof scope-consistency trigger. Not an
      // immutability guard, so it executes a different function.
      { events: ['INSERT'], level: 'ROW', execute: 'public.uellix_check_document_version_scope' },
    ])) {
      add('history-append-only-triggers', problem)
    }
    // TRAIN 3, risk #4 — every trigger on this table must resist
    // session_replication_role=replica.
    for (const problem of enableAlwaysProblems(sources[FORWARD.VERSIONS], 'public.evidence_document_versions', [
      'trg_evidence_document_versions_append_only',
      'trg_evidence_document_versions_no_truncate',
      'trg_evidence_document_versions_scope_check',
    ])) {
      add('history-append-only-triggers', problem)
    }
  }

  {
    const policies = parsePolicies(sources[FORWARD.CHUNKS])
    for (const p of policies) {
      require_('chunk-no-update',
        p.command !== 'UPDATE',
        `${FORWARD.CHUNKS}: policy ${p.name} is FOR UPDATE. A chunk is never rewritten in place — reindexing is DELETE + INSERT`)
    }
    // An UPDATE trigger, not an UPDATE-or-DELETE one: DELETE is legitimate here
    // and the trigger must not forbid it, or a reindex becomes impossible.
    for (const problem of triggerProblems(sources[FORWARD.CHUNKS], 'public.evidence_chunks', [
      { events: ['UPDATE'], level: 'ROW' },
      { events: ['TRUNCATE'], level: 'STATEMENT' },
      // TRAIN 3, risk #2 — canonical-chunk acyclicity. AFTER, not BEFORE: it
      // must see the final state of the row it looks up (see the SQL comment
      // in grounding_0003 §7b for why that is safe under the two-pass insert).
      { events: ['INSERT'], level: 'ROW', execute: 'public.uellix_check_canonical_chunk', timing: 'AFTER' },
    ])) {
      add('chunk-immutability-triggers', problem)
    }
    // TRAIN 3, risk #4 — every trigger on this table must resist
    // session_replication_role=replica.
    for (const problem of enableAlwaysProblems(sources[FORWARD.CHUNKS], 'public.evidence_chunks', [
      'trg_evidence_chunks_no_update',
      'trg_evidence_chunks_no_truncate',
      'trg_evidence_chunks_canonical_integrity',
    ])) {
      add('chunk-immutability-triggers', problem)
    }
  }

  // =====================================================================
  // The contracts themselves
  // =====================================================================
  if (chunksTable !== null) {
    for (const column of GR001_PROVENANCE_COLUMNS) {
      require_('gr001-columns',
        new RegExp(`^\\s*${column} (char\\(64\\)|varchar\\(32\\)) NOT NULL`, 'm').test(chunksTable),
        `${FORWARD.CHUNKS}: GR-001 §2 column ${column} is missing or nullable`)
    }
    // ...and the shape guard must EXIST for them, or a pre-existing table
    // without them would be adopted silently. GR-001 §5 makes acceptance
    // conditional on exactly this.
    for (const column of GR001_PROVENANCE_COLUMNS) {
      require_('gr001-shape-guard',
        new RegExp(`\\('${column}',`).test(sources[FORWARD.CHUNKS]),
        `${FORWARD.CHUNKS}: the shape guard does not require ${column}`)
    }
  }

  if (versionsTable !== null) {
    for (const column of GR002_HISTORY_COLUMNS) {
      require_('gr002-columns',
        new RegExp(`^\\s*${column} `, 'm').test(versionsTable),
        `${FORWARD.VERSIONS}: GR-002 §2 column ${column} is missing`)
    }
  }

  // The three constraints that make "exactly one active version" a theorem
  // rather than a convention, plus the root check that makes the chain rooted.
  //
  // Asserted against the CREATE TABLE BODY, not the whole file. A file-wide
  // `includes` passed while the constraint had been deleted from the table and
  // survived only in the reconciliation block and the postcondition — where it
  // constrains nothing, because a constraint that was never declared is never
  // reconciled onto a table that does not have it.
  for (const fragment of [
    'UNIQUE (evidence_id, version_id)',
    'UNIQUE (evidence_id, ordinal)',
    'UNIQUE (evidence_id, supersedes_version_id)',
  ]) {
    require_('history-linearity',
      versionsTable !== null && code(versionsTable).includes(fragment),
      `${FORWARD.VERSIONS}: ${fragment} is absent from the table definition. Without it the version history can fork and "the active version" stops being well defined`)
  }
  require_('history-linearity',
    versionsTable !== null && code(versionsTable).includes('(ordinal = 1) = (supersedes_version_id IS NULL)'),
    `${FORWARD.VERSIONS}: the root check is absent from the table definition, so a history can have zero or many roots`)

  // Uniqueness scoped to the VERSION. The superseded grounding_0001 scoped it
  // to the evidence item, which makes a second document version unstorable.
  require_('version-scoped-unique',
    chunksTable !== null && code(chunksTable).includes('UNIQUE (document_version_id, chunk_index)'),
    `${FORWARD.CHUNKS}: UNIQUE (document_version_id, chunk_index) is absent from the table definition`)
  require_('version-scoped-unique',
    !/CONSTRAINT evidence_chunks_evidence_chunk_unique UNIQUE/.test(code(sources[FORWARD.CHUNKS])),
    `${FORWARD.CHUNKS}: the superseded UNIQUE (evidence_id, chunk_index) is back. Version 2 of a document would be unstorable`)

  // Deduplication: unique, on the columns GR-001 §3 names, and PREDICATED on
  // the canonical set — a suppressed occurrence shares its content_hash with
  // the chunk that survived, so a total constraint makes the dedup relation
  // unstorable.
  {
    const chunks = code(sources[FORWARD.CHUNKS])
    const idx = /CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_chunks_version_content\s+ON public\.evidence_chunks \(([^)]*)\)\s*\n\s*WHERE ([^;]*);/.exec(chunks)
    require_('dedup-index', idx !== null,
      `${FORWARD.CHUNKS}: the deduplication index is missing, not UNIQUE, or has no WHERE predicate`)
    if (idx !== null) {
      require_('dedup-index',
        idx[1].replace(/\s+/g, ' ').trim() === 'evidence_id, version_id, content_hash',
        `${FORWARD.CHUNKS}: the deduplication index covers (${idx[1].trim()}), not (evidence_id, version_id, content_hash) as GR-001 §3 states`)
      require_('dedup-index',
        idx[2].trim() === 'canonical_chunk_id IS NULL',
        `${FORWARD.CHUNKS}: the deduplication index predicate is "${idx[2].trim()}", not "canonical_chunk_id IS NULL"`)
    }
  }

  // A suppressed occurrence stores no text: it is a location, not a passage,
  // and its text is byte-identical to the canonical chunk's by definition.
  require_('no-duplicate-text',
    chunksTable !== null && code(chunksTable).includes('(canonical_chunk_id IS NULL) = (content IS NOT NULL)'),
    `${FORWARD.CHUNKS}: the content/duplicate biconditional is absent from the table definition, so a suppressed occurrence could store a second copy of the passage`)

  // =====================================================================
  // TRAIN 3 HARDENING — canonical_chunk_id integrity (risks #1, #2, #5)
  // =====================================================================
  {
    const chunks = chunksTable !== null ? code(chunksTable) : ''

    // Risk #1 — the FK target and the FK itself. Existence, scope
    // (organization/project/evidence/version) AND content_hash agreement, in
    // ONE constraint.
    require_('canonical-fk',
      chunksTable !== null && chunks.includes(
        'CONSTRAINT evidence_chunks_identity_scope_unique\n    UNIQUE (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)',
      ),
      `${FORWARD.CHUNKS}: evidence_chunks_identity_scope_unique is absent from the table definition — canonical_chunk_id's FK has no target to bind to`)
    require_('canonical-fk',
      chunksTable !== null &&
        /CONSTRAINT evidence_chunks_canonical_fk\s+FOREIGN KEY \(canonical_chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash\)\s+REFERENCES public\.evidence_chunks \(chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash\)\s+ON DELETE CASCADE/.test(chunks),
      `${FORWARD.CHUNKS}: evidence_chunks_canonical_fk is missing, or does not cover organization_id/project_id/evidence_id/document_version_id/content_hash — canonical_chunk_id could then name a chunk out of scope, out of version, or with different content`)

    // Risk #1/#5 — the version-scope FK: existence AND every scope/provenance
    // column agreeing with the version row, replacing what the RESTRICTIVE
    // policy alone could not enforce against the table owner.
    require_('version-scope-fk',
      chunksTable !== null &&
        /CONSTRAINT evidence_chunks_version_scope_fk\s+FOREIGN KEY \(document_version_id, organization_id, project_id, evidence_id, version_id,\s+raw_content_hash, normalized_content_hash, normalization_version, chunker_version\)\s+REFERENCES public\.evidence_document_versions \(id, organization_id, project_id, evidence_id, version_id,\s+raw_content_hash, normalized_content_hash, normalization_version, chunker_version\)\s+ON DELETE CASCADE/.test(chunks),
      `${FORWARD.CHUNKS}: evidence_chunks_version_scope_fk is missing, or does not cover every scope/provenance column — a chunk could disagree with its own document version's organization, project, evidence item or pipeline versions, and only RLS (which the table owner bypasses) would have said so`)

    // Risk #2 (half): self-reference. The other half (no chain, no cycle of
    // any length) is a TRIGGER, not a constraint — asserted below via
    // triggerProblems, because a FOREIGN KEY cannot compare a referenced row's
    // OWN nullability against anything.
    require_('canonical-self-reference-check',
      chunksTable !== null && chunks.includes('canonical_chunk_id <> chunk_id'),
      `${FORWARD.CHUNKS}: the CHECK forbidding canonical_chunk_id = chunk_id is absent from the table definition`)
  }

  require_('identity-unique',
    versionsTable !== null && code(versionsTable).includes(
      'CONSTRAINT evidence_document_versions_identity_unique\n    UNIQUE (id, organization_id, project_id, evidence_id, version_id,\n            raw_content_hash, normalized_content_hash, normalization_version, chunker_version)',
    ),
    `${FORWARD.VERSIONS}: evidence_document_versions_identity_unique is absent from the table definition — evidence_chunks' scope-consistency FK has no target to bind to`)

  // Risk #3 — chunk_id is server-derived, not trusted from the payload for
  // storage. Both halves matter: the derivation formula must be present, AND
  // the INSERT actually stores the DERIVED value rather than the caller's
  // c.chunk_id.
  {
    const insertFn = parseFunctions(sources[FORWARD.CHUNKS]).find((f) => f.name === 'uellix_grounding.insert_evidence_chunks')
    const body = insertFn !== undefined ? code(insertFn.body) : ''
    require_('chunk-id-server-derivation', insertFn !== undefined,
      `${FORWARD.CHUNKS}: uellix_grounding.insert_evidence_chunks is missing`)
    require_('chunk-id-server-derivation',
      /pg_catalog\.sha256\(pg_catalog\.convert_to\(\s*'grounding\/chunk\/v1' \|\| chr\(10\) \|\| v_version\.version_id \|\| chr\(10\) \|\| c\.chunk_index::text \|\| chr\(10\) \|\| c\.content_hash,/.test(body),
      `${FORWARD.CHUNKS}: insert_evidence_chunks does not derive chunk_id from (version_id, chunk_index, content_hash) via SHA-256 — a client-chosen identity would be trusted for storage`)
    require_('chunk-id-server-derivation',
      /WHERE c\.chunk_id IS DISTINCT FROM pg_catalog\.encode/.test(body),
      `${FORWARD.CHUNKS}: insert_evidence_chunks does not verify the caller's chunk_id against the derived one`)
    // The stored value must be the DERIVED expression, not a bare c.chunk_id
    // reference — a mismatch check with no consequence on the write path
    // would be exactly that: checked, and then ignored.
    require_('chunk-id-server-derivation',
      !/INSERT INTO public\.evidence_chunks \([\s\S]*?\)\s*\n\s*SELECT\s+c\.chunk_id,/.test(body),
      `${FORWARD.CHUNKS}: insert_evidence_chunks stores the caller's c.chunk_id directly instead of the server-derived value`)
  }

  // =====================================================================
  // SECURITY DEFINER contract
  // =====================================================================
  // Scoped to uellix_grounding.* — the capability role's own schema and the
  // API surface this contract governs. TRAIN 3 adds two plain (non-SECURITY-
  // DEFINER) trigger-executor functions in `public`
  // (uellix_check_document_version_scope, uellix_check_canonical_chunk),
  // exactly like the pre-existing public.uellix_forbid_mutation(): neither
  // needs the definer contract below, and parseFunctions' naive `$$;` search
  // would in any case misparse a body that (like theirs) closes with
  // `$$ LANGUAGE plpgsql;` rather than a bare `$$;` — harmless here only
  // because the malformed entry is filtered out before any gate inspects it.
  const allFunctions = forwardFiles
    .flatMap((f) => parseFunctions(sources[f]).map((fn) => ({ file: f, ...fn })))
    .filter((fn) => fn.name.startsWith('uellix_grounding.'))
  require_('definer-inventory', allFunctions.length === 5,
    `expected 5 SECURITY DEFINER functions across the two packages, found ${allFunctions.length}`)

  for (const fn of allFunctions) {
    // Comments are stripped before every body assertion below. Without it a
    // comment that NAMES the forbidden construct — "never SELECT *", which is
    // exactly what these bodies say — fires the gate that exists to forbid it,
    // and the fix would be to delete the explanation.
    const body = code(fn.body)

    require_('definer-security', /\bSECURITY DEFINER\b/.test(fn.header),
      `${fn.file}: ${fn.name} is not SECURITY DEFINER`)
    // '' and not 'public, pg_temp': with pg_temp on the path a caller can
    // create a temporary object that shadows an unqualified name, and the
    // definer would run it with the definer's privileges.
    require_('definer-search-path', /SET search_path = ''/.test(fn.header),
      `${fn.file}: ${fn.name} does not pin search_path to the empty string`)
    // The argument list is matched with a NESTED-paren-tolerant pattern:
    // `char(64)` and `varchar(32)` carry their own parentheses, and a `[^)]*`
    // signature stops at the first one — which made this gate report every
    // correctly-owned function as unowned the first time it ran.
    const signature = `${fn.name.replace(/\./g, '\\.')}\\((?:[^()]|\\([^()]*\\))*\\)`
    require_('definer-owner',
      new RegExp(`ALTER FUNCTION ${signature}\\s*\\n?\\s*OWNER TO ${DEFINER_ROLE}`).test(sources[fn.file]),
      `${fn.file}: ${fn.name} is not owned by ${DEFINER_ROLE}`)
    require_('definer-acl',
      new RegExp(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`).test(sources[fn.file]),
      `${fn.file}: EXECUTE on ${fn.name} is not revoked from PUBLIC, which is the default grantee`)
    require_('definer-acl',
      new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO uellix_app`).test(sources[fn.file]),
      `${fn.file}: ${fn.name} has no EXECUTE grant to uellix_app, so the runtime cannot reach the governed path at all`)
    // `SELECT * INTO <rowtype var>` is allowed and is not the hazard: the
    // target is a %ROWTYPE that widens with the table. A bare `SELECT *` in a
    // RETURN QUERY is, because the function's declared result shape does not.
    require_('definer-no-star', !/\bSELECT \*(?!\s*INTO)/.test(body),
      `${fn.file}: ${fn.name} uses SELECT * outside a %ROWTYPE fetch, so a column added later silently changes its result shape`)
    require_('definer-no-dynamic-sql', !/\bEXECUTE\b/.test(body),
      `${fn.file}: ${fn.name} contains EXECUTE. A definer must not compose SQL`)
    // An error message is a channel. A definer that interpolates a digest or a
    // passage into a RAISE hands an untrusted caller an oracle.
    for (const raise of body.match(/RAISE EXCEPTION[\s\S]*?;/g) ?? []) {
      require_('definer-error-detail',
        !/\bp_(version_id|raw_content_hash|normalized_content_hash|chunks|content)\b/.test(raise),
        `${fn.file}: ${fn.name} interpolates an argument carrying a digest or document text into an error message`)
    }
  }

  // Every function that reads must re-impose the caller's boundary: the definer
  // bypasses RLS, so RLS is not doing it.
  for (const fn of allFunctions) {
    if (fn.name.endsWith('register_document_version')) continue // scope is derived, not checked
    require_('definer-scope-check',
      code(fn.body).includes('current_user_org_ids') || code(fn.body).includes('current_user_is_super_admin'),
      `${fn.file}: ${fn.name} never consults the caller's organizations, and SECURITY DEFINER bypasses RLS`)
  }

  // =====================================================================
  // The capability role
  // =====================================================================
  {
    const analysis = analyzeSecurity(sources[FORWARD.VERSIONS])
    const alters = analysis.roleStatements.filter((r) => r.role === DEFINER_ROLE && r.verb === 'ALTER')
    require_('role-attributes', alters.length > 0,
      `${FORWARD.VERSIONS}: no ALTER ROLE for ${DEFINER_ROLE}`)
    for (const attr of ['NOLOGIN', 'NOSUPERUSER', 'NOCREATEROLE', 'NOBYPASSRLS', 'NOINHERIT']) {
      require_('role-attributes',
        alters.some((r) => r.attributes.includes(attr)),
        `${FORWARD.VERSIONS}: ${DEFINER_ROLE} is not declared ${attr}`)
    }
  }

  // Zero members, in either direction. A member would make the write path
  // reachable by SET ROLE from a real connection string — `uellix_migrator` is
  // a LOGIN role that already reaches `uellix_owner`.
  for (const file of GROUNDING_SQL_FILES) {
    for (const g of analyzeSecurity(sources[file]).grants) {
      if (g.objectType !== 'ROLE') continue
      require_('role-zero-members',
        !g.grantees.includes(DEFINER_ROLE) && g.object !== DEFINER_ROLE,
        `${file}: role membership ${g.raw.trim()} gives ${DEFINER_ROLE} a member or a membership`)
    }
  }

  // =====================================================================
  // Rollbacks
  // =====================================================================
  // The version history is NOT regenerable from Storage, so its rollback asks.
  {
    // Comment-stripped. The rollback EXPLAINS each of these guards in prose
    // that names the same identifiers, so a file-wide match was satisfied by
    // the explanation of a guard that had been deleted.
    const rb = code(sources[ROLLBACK.VERSIONS])
    require_('rollback-authorization',
      rb.includes("current_setting('grounding.rollback_confirm', true)"),
      `${ROLLBACK.VERSIONS}: no session authorization is read before dropping chain-of-custody history`)
    require_('rollback-authorization',
      /authorized IS DISTINCT FROM 'true'/.test(rb),
      `${ROLLBACK.VERSIONS}: the authorization comparison is not an exact match against 'true', so 'yes'/'1'/'on' could approve a destructive act`)
    require_('rollback-authorization',
      rb.includes('pg_db_role_setting'),
      `${ROLLBACK.VERSIONS}: a persisted ALTER DATABASE/ROLE setting would pre-authorize every future session and nothing checks for it`)
    require_('rollback-authorization',
      rb.includes('relforcerowsecurity'),
      `${ROLLBACK.VERSIONS}: the row count is not guarded against FORCE ROW LEVEL SECURITY, under which an owner counts 0 over a populated table`)
  }

  // No rollback may take an object it does not own, and none may CASCADE.
  for (const file of rollbackFiles) {
    const rb = code(sources[file])
    require_('rollback-no-cascade', !/DROP [\s\S]{0,80}?CASCADE/.test(rb),
      `${file}: a DROP ... CASCADE would silently take objects this rollback never named`)
  }
  {
    const rb = code(sources[ROLLBACK.CHUNKS])
    require_('rollback-targets',
      !/DROP TABLE[^;']*evidence_document_versions/.test(rb),
      `${ROLLBACK.CHUNKS}: it drops the version history, which grounding_0002 owns`)
    require_('rollback-targets',
      !/DROP SCHEMA/.test(rb) && !/DROP ROLE/.test(rb),
      `${ROLLBACK.CHUNKS}: it drops the schema or the role, which grounding_0002 owns and still needs`)
    require_('rollback-targets',
      rb.includes("to_regclass('public.evidence_document_versions') IS NULL"),
      `${ROLLBACK.CHUNKS}: nothing asserts the chain of custody survived, so a CASCADE added to the DROP would take it unnoticed`)
  }
  {
    const rb = code(sources[ROLLBACK.VERSIONS])
    require_('rollback-targets',
      rb.includes('Roll back grounding_0003') || rb.includes('grounding_0003_rollback.sql'),
      `${ROLLBACK.VERSIONS}: nothing refuses to run while evidence_chunks still references the table`)
  }

  // The destructive statement must live INSIDE the DO block. A guard in a DO
  // block followed by a top-level DROP is two statements, and without
  // ON_ERROR_STOP psql reports the first and sends the second — the exact
  // defect stella_0003_rollback was hardened against.
  for (const file of rollbackFiles) {
    for (const stmt of topLevelStatements(sources[file])) {
      require_('rollback-single-block',
        !/^\s*DROP\b/i.test(stmt),
        `${file}: "${stmt.trim().slice(0, 60)}" is a TOP-LEVEL DROP. Only psql flags would separate it from the guard above it`)
    }
  }

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
      `${file}: nothing verifies that ${DEFINER_ROLE} still has zero members`)
  }

  // An EXCEPTION handler inside a guard swallows its RAISE and lets everything
  // after it run with the whole suite green.
  for (const file of GROUNDING_SQL_FILES) {
    require_('no-exception-handler',
      !/\bEXCEPTION\s+WHEN\b/.test(code(sources[file])),
      `${file}: an EXCEPTION WHEN handler can swallow a guard's RAISE and let the statements after it run`)
  }

  return v
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

/**
 * Everything wrong with a table's immutability triggers, as messages.
 *
 * It returns problems instead of emitting violations so that the GATE NAME
 * stays a literal at the call site. A helper that took the gate name as a
 * parameter made two real gates invisible to the coverage check in
 * tests/grounding-persistence-mutation.test.ts — they fired correctly while
 * being absent from both the derived inventory and the unexercised list, which
 * is the one place a missing gate was supposed to become visible.
 */
function triggerProblems(
  sql: string,
  table: string,
  expected: readonly {
    events: readonly string[]
    level: 'ROW' | 'STATEMENT'
    /** Defaults to public.uellix_forbid_mutation — the immutability guard. */
    execute?: string
    /** Defaults to BEFORE. TRAIN 3's canonical-acyclicity trigger is AFTER: it
     *  must observe the row's FINAL state and, together with the two-pass
     *  insert in insert_evidence_chunks, the final state of rows a prior
     *  statement in the same transaction already committed. */
    timing?: 'BEFORE' | 'AFTER'
  }[],
): string[] {
  const problems: string[] = []
  const triggers = analyzeSecurity(sql).triggers.filter((t) => t.table === table)

  // Every trigger on the table must be accounted for by one of `expected`: an
  // exact count, not a subset check, so an UNDOCUMENTED trigger — one this
  // caller did not list — is exactly as visible as a missing one.
  if (triggers.length !== expected.length) {
    problems.push(`${table}: expected ${expected.length} trigger(s), found ${triggers.length}`)
  }

  for (const want of expected) {
    const wantTiming = want.timing ?? 'BEFORE'
    const wantExecute = want.execute ?? 'public.uellix_forbid_mutation'
    const found = triggers.find(
      (t) =>
        t.level === want.level &&
        t.events.length === want.events.length &&
        want.events.every((e) => t.events.includes(e)),
    )
    if (found === undefined) {
      problems.push(`${table}: no ${wantTiming} ${want.events.join(' OR ')} FOR EACH ${want.level} trigger`)
      continue
    }
    if (found.timing !== wantTiming) {
      problems.push(`${table}: trigger ${found.name} is ${found.timing}, not ${wantTiming}${wantTiming === 'BEFORE' ? ' — an AFTER trigger cannot prevent the row change' : ''}`)
    }
    if (found.execute !== wantExecute) {
      problems.push(`${table}: trigger ${found.name} executes ${found.execute}, not ${wantExecute}`)
    }
    if (found.when !== null) {
      problems.push(`${table}: trigger ${found.name} is conditional (WHEN ${found.when}), so some mutations pass`)
    }
  }
  return problems
}

/** ENABLE ALWAYS (tgenabled='A') — TRAIN 3, risk #4. Not modelled by
 *  ParsedTrigger, so read directly off the ALTER TABLE statement text: every
 *  trigger this file creates must be armed against
 *  session_replication_role=replica, not just against a plain client. */
function enableAlwaysProblems(sql: string, table: string, triggerNames: readonly string[]): string[] {
  const text = code(sql)
  return triggerNames
    .filter((name) => !new RegExp(`ALTER TABLE ${table.replace(/\./g, '\\.')} ENABLE ALWAYS TRIGGER ${name};`).test(text))
    .map((name) => `${table}: ${name} is not ENABLE ALWAYS — session_replication_role=replica would silently disable it`)
}

/** Re-exported so a test can assert on the parsed shape directly. */
export type { ParsedPolicy }
