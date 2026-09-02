// tests/helpers/grounding-mutations.ts
//
// The catalogue of deliberate breakages for the grounding persistence packages.
//
// Each entry names ONE property of GR-001/GR-002, the edit that removes it, and
// the gate in tests/helpers/grounding-gates.ts that must refuse the result.
// tests/grounding-persistence-mutation.test.ts applies them to an in-memory
// copy — nothing here writes to db/prepared.
//
// Two rules from tests/capability-mutation.test.ts carry over, and they are
// what make the count mean anything:
//
//   1. A mutation must actually CHANGE the text. A stale anchor matches
//      nothing, produces an unmutated source, and yields a violation-free run
//      that reads as a pass.
//   2. It is not enough that SOMETHING objected. The gate that OWNS the
//      property must fire, or the day that gate is weakened the suite stays
//      green because a bystander still notices.

import { FORWARD, ROLLBACK } from './grounding-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The contract clause the property comes from. */
  readonly contract: 'GR-001' | 'GR-002' | 'both'
  readonly change: string
  readonly breaks: string
  readonly expectedGate: readonly string[]
  readonly apply: (sql: string) => string
}

/**
 * Replace the first occurrence, or return the input unchanged.
 *
 * The replacement goes through a FUNCTION, not a string. `String.replace` with
 * a string replacement treats `$$` as an escape for a literal `$`, and half the
 * anchors below quote PostgreSQL dollar quotes — so a plain string replacement
 * silently turned `AS $$` into `AS $`, broke the quote, and killed the mutant
 * with an `unparsed` violation instead of the gate it was written to exercise.
 * Found by rule 3 of the harness, which is the reason rule 3 exists.
 */
const sub = (from: string, to: string) => (sql: string) => sql.replace(from, () => to)

export const ISOLATION_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-01',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'project_id becomes nullable on the version history',
    breaks: 'Project isolation. A nullable project forces every project-scoped predicate to carry an OR IS NULL branch, and such a branch can only widen the boundary.',
    expectedGate: ['scope-columns'],
    apply: sub(
      'project_id uuid NOT NULL REFERENCES public.projects(id),',
      'project_id uuid REFERENCES public.projects(id),',
    ),
  },
  {
    id: 'G-02',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'project_id becomes nullable on the chunk index',
    breaks: 'Project isolation on the retrieval index — the table an answer actually cites.',
    expectedGate: ['scope-columns'],
    apply: sub(
      'project_id uuid NOT NULL REFERENCES public.projects(id),',
      'project_id uuid REFERENCES public.projects(id),',
    ),
  },
  {
    id: 'G-03',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the RESTRICTIVE scope-consistency policy is downgraded to PERMISSIVE',
    breaks: 'The one policy that can only narrow. As PERMISSIVE it ORs with the others instead of ANDing, so it stops bounding anything and becomes a second way IN.',
    expectedGate: ['scope-restrictive'],
    apply: sub(
      'ON public.evidence_document_versions AS RESTRICTIVE FOR ALL',
      'ON public.evidence_document_versions FOR ALL',
    ),
  },
  {
    id: 'G-04',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the RESTRICTIVE policy stops comparing project_id',
    breaks: 'Cross-project isolation at the row level: a chunk filed under the right organization but the wrong project becomes readable.',
    expectedGate: ['scope-restrictive'],
    apply: sub(
      `      AND v.project_id = evidence_chunks.project_id
      AND v.evidence_id = evidence_chunks.evidence_id
  )
);

-- ============================================================
-- 7. Immutability`,
      `      AND v.evidence_id = evidence_chunks.evidence_id
  )
);

-- ============================================================
-- 7. Immutability`,
    ),
  },
  {
    id: 'G-05',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the RESTRICTIVE policy stops covering the definer role',
    breaks: 'The narrowing applies to every reader and not to the one role that WRITES, so the invariant is absent exactly where rows are created.',
    expectedGate: ['scope-restrictive'],
    apply: sub(
      'TO authenticated, uellix_app, uellix_auditor, uellix_cap_grounding\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.evidence_document_versions v',
      'TO authenticated, uellix_app, uellix_auditor\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.evidence_document_versions v',
    ),
  },
  {
    id: 'G-06',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the SELECT policy also names service_role',
    breaks: 'service_role is the PostgREST superuser principal; naming it hands every holder of that JWT the whole grounding index across tenants.',
    expectedGate: ['policy-to-clause'],
    apply: sub(
      'ON public.evidence_chunks FOR SELECT\nTO authenticated, uellix_app, uellix_auditor',
      'ON public.evidence_chunks FOR SELECT\nTO authenticated, uellix_app, uellix_auditor, service_role',
    ),
  },
  {
    id: 'G-07',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the SELECT policy loses its TO clause',
    breaks: 'A policy with no TO clause applies to PUBLIC, which re-activates every pre-cutover grant — the exact defect stella_0005c had to repair on three INSERT policies.',
    expectedGate: ['policy-to-clause'],
    apply: sub(
      'ON public.evidence_document_versions FOR SELECT\nTO authenticated, uellix_app, uellix_auditor\nUSING (',
      'ON public.evidence_document_versions FOR SELECT\nUSING (',
    ),
  },
]

export const PRIVILEGE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-08',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the runtime role receives INSERT on the version history',
    breaks: 'The whole reason the governed function exists. With a direct INSERT grant, any endpoint reachable as uellix_app can invent a version history — and inventing a history is precisely what this table exists to make impossible.',
    expectedGate: ['table-write-grant'],
    apply: sub(
      'GRANT SELECT ON public.evidence_document_versions TO uellix_app;',
      'GRANT SELECT, INSERT ON public.evidence_document_versions TO uellix_app;',
    ),
  },
  {
    id: 'G-09',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'authenticated receives UPDATE on the chunk index',
    breaks: 'A browser session could rewrite a chunk hash or offset in place, so a citation that resolved yesterday quotes a different passage today under the same identity.',
    expectedGate: ['table-write-grant'],
    apply: sub(
      'GRANT SELECT ON public.evidence_chunks TO authenticated;',
      'GRANT SELECT, UPDATE ON public.evidence_chunks TO authenticated;',
    ),
  },
  {
    id: 'G-10',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the SELECT grant to authenticated carries WITH GRANT OPTION',
    breaks: 'The grantee can re-grant SELECT to anon, so the boundary holds only until someone exercises a privilege they were given.',
    expectedGate: ['table-write-grant'],
    apply: sub(
      'GRANT SELECT ON public.evidence_chunks TO authenticated;',
      'GRANT SELECT ON public.evidence_chunks TO authenticated WITH GRANT OPTION;',
    ),
  },
  {
    id: 'G-11',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the defensive REVOKE ALL from service_role is dropped',
    breaks: "Supabase's ALTER DEFAULT PRIVILEGES gives service_role full arwdDxtm on every new table in public. Without the revoke the table is born wide open — the surplus that left four audit tables TRUNCATE-able and forced stella_0002b.",
    expectedGate: ['revoke-all-first'],
    apply: sub('REVOKE ALL ON public.evidence_chunks FROM service_role;\n', ''),
  },
  {
    id: 'G-12',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the definer role receives DELETE on the version history',
    breaks: 'Append-only becomes a claim about what the function happens to do rather than a property of the table. A chain of custody with a reachable DELETE is not one.',
    expectedGate: ['history-no-delete'],
    apply: sub(
      'GRANT SELECT, INSERT ON public.evidence_document_versions TO uellix_cap_grounding;',
      'GRANT SELECT, INSERT, DELETE ON public.evidence_document_versions TO uellix_cap_grounding;',
    ),
  },
]

export const APPEND_ONLY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-13',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'an UPDATE policy is added to the version history',
    breaks: 'Versions are denied UPDATE by ABSENCE of a policy. Adding one is the whole difference between an append-only history and a mutable table.',
    expectedGate: ['history-append-only'],
    apply: sub(
      'DROP POLICY IF EXISTS "evidence_document_versions_definer_insert"',
      `CREATE POLICY "evidence_document_versions_fixup"
ON public.evidence_document_versions FOR UPDATE
TO uellix_app
USING (organization_id = ANY(public.current_user_org_ids()));

DROP POLICY IF EXISTS "evidence_document_versions_definer_insert"`,
    ),
  },
  {
    id: 'G-14',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the append-only row trigger fires AFTER instead of BEFORE',
    breaks: 'An AFTER trigger cannot prevent the row change; it raises once the UPDATE has already been applied to the tuple. Under a caller that traps the error the mutation can survive.',
    expectedGate: ['history-append-only-triggers'],
    apply: sub(
      'BEFORE UPDATE OR DELETE ON public.evidence_document_versions',
      'AFTER UPDATE OR DELETE ON public.evidence_document_versions',
    ),
  },
  {
    id: 'G-15',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the TRUNCATE trigger is removed',
    breaks: 'A FOR EACH ROW trigger never fires on TRUNCATE — there are no OLD/NEW rows — and RLS does not govern it either. This is the exact gap stella_0002b had to close after the fact on four tables, demonstrated on a real PostgreSQL 17.',
    expectedGate: ['history-append-only-triggers'],
    apply: sub(
      `DROP TRIGGER IF EXISTS trg_evidence_document_versions_no_truncate ON public.evidence_document_versions;
CREATE TRIGGER trg_evidence_document_versions_no_truncate
  BEFORE TRUNCATE ON public.evidence_document_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_forbid_mutation();
`,
      '',
    ),
  },
  {
    id: 'G-16',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the append-only trigger becomes conditional on a WHEN predicate',
    breaks: 'A conditional immutability trigger is a permission list written backwards: every row the predicate excludes is mutable, and the exclusion is invisible in the trigger name.',
    expectedGate: ['history-append-only-triggers'],
    apply: sub(
      `  BEFORE UPDATE OR DELETE ON public.evidence_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();`,
      `  BEFORE UPDATE OR DELETE ON public.evidence_document_versions
  FOR EACH ROW WHEN (OLD.ordinal > 1) EXECUTE FUNCTION public.uellix_forbid_mutation();`,
    ),
  },
  {
    id: 'G-17',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the no-update trigger is bound to a different function',
    breaks: 'The trigger name still says the table is immutable and the catalogue still shows a BEFORE UPDATE trigger, while the function it calls does not raise.',
    expectedGate: ['chunk-immutability-triggers'],
    apply: sub(
      `  BEFORE UPDATE ON public.evidence_chunks
  FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();`,
      `  BEFORE UPDATE ON public.evidence_chunks
  FOR EACH ROW EXECUTE FUNCTION public.uellix_touch_updated_at();`,
    ),
  },
  {
    id: 'G-18',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'an UPDATE policy is added to the chunk index',
    breaks: 'Rewriting a chunk in place keeps its identity while changing what it claims. The chunk_id no longer derives from the content it names, and every citation quoting it is silently wrong.',
    expectedGate: ['chunk-no-update'],
    apply: sub(
      'DROP POLICY IF EXISTS "evidence_chunks_definer_delete"',
      `CREATE POLICY "evidence_chunks_reembed"
ON public.evidence_chunks FOR UPDATE
TO uellix_cap_grounding
USING (organization_id IS NOT NULL);

DROP POLICY IF EXISTS "evidence_chunks_definer_delete"`,
    ),
  },
]

export const CONTRACT_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-19',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'normalized_content_hash is removed from the chunk table',
    breaks: 'GR-001 calls this the gravest gap in the old shape and it is: char_start/char_end are offsets into the text with THIS digest, so without it an anchor produced under one normalization resolves against text produced under another — both offsets in range, wrong passage quoted.',
    expectedGate: ['gr001-columns'],
    apply: sub(
      '  normalized_content_hash char(64) NOT NULL,\n\n  -- 0-based, in document order.',
      '\n  -- 0-based, in document order.',
    ),
  },
  {
    id: 'G-20',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'chunker_version becomes nullable',
    breaks: '"Does this index need a reindex?" stops being answerable for any row that leaves it null, and the rows that leave it null are exactly the ones written by a caller that does not know.',
    expectedGate: ['gr001-columns'],
    apply: sub('  chunker_version varchar(32) NOT NULL,\n  injection_scanner_version',
      '  chunker_version varchar(32),\n  injection_scanner_version'),
  },
  {
    id: 'G-21',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the shape guard stops requiring chunk_id',
    breaks: 'GR-001 §5 makes acceptance conditional on the guard REQUIRING the six columns. A guard that omits one adopts a pre-existing table without it and reports success — the columns are then absent in exactly the environment nobody re-checks.',
    expectedGate: ['gr001-shape-guard'],
    apply: sub("      ('chunk_id',                  'character',                'NO'),\n", ''),
  },
  {
    id: 'G-22',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'supersedes_version_id is removed from the version history',
    breaks: 'The chain link itself. Without it a citation against version 1 cannot resolve to "replaced by version 2 on <date>", which is the one sentence GR-002 §3 says an auditor needs to read.',
    expectedGate: ['gr002-columns'],
    apply: sub(
      '  -- version_id of the version this one replaces; NULL only for the root.\n  supersedes_version_id char(64),\n',
      '',
    ),
  },
  {
    id: 'G-23',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'UNIQUE (evidence_id, supersedes_version_id) is dropped from the table definition',
    breaks: 'Two concurrent registrations can both claim to replace version N. The history forks, and "the active version" — max(ordinal) — stops being well defined, so a citation resolves into whichever branch the reader happens to walk.',
    expectedGate: ['history-linearity'],
    apply: sub(
      `  CONSTRAINT evidence_document_versions_supersedes_unique
    UNIQUE (evidence_id, supersedes_version_id),
`,
      '',
    ),
  },
  {
    id: 'G-24',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the root check is weakened to a one-way implication',
    breaks: 'The biconditional is what makes exactly one root. As a one-way implication a history can have several ordinal-1 rows, or an ordinal-1 row that supersedes something, and the chain is no longer rooted.',
    expectedGate: ['history-linearity'],
    apply: sub(
      'CHECK ((ordinal = 1) = (supersedes_version_id IS NULL)\n           AND (supersedes_version_id IS NULL OR supersedes_version_id <> version_id)),',
      'CHECK (ordinal >= 1),',
    ),
  },
  {
    id: 'G-25',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'both',
    change: "grounding_0001's UNIQUE (evidence_id, chunk_index) is reinstated",
    breaks: 'Version 2 of a document collides with version 1 on chunk_index 0, so the second version is unstorable. This is the incompatibility that made grounding_0001 supersedable rather than extensible.',
    expectedGate: ['version-scoped-unique'],
    apply: sub(
      'CONSTRAINT evidence_chunks_version_index_unique UNIQUE (document_version_id, chunk_index),',
      'CONSTRAINT evidence_chunks_evidence_chunk_unique UNIQUE (evidence_id, chunk_index),',
    ),
  },
  {
    id: 'G-26',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the deduplication index loses its WHERE predicate',
    breaks: 'A suppressed occurrence shares its content_hash with the chunk that survived — that is what "duplicate" means — so an unpredicated unique index makes the deduplication relation unstorable and every reindex of a document with repeated boilerplate fails.',
    expectedGate: ['dedup-index'],
    apply: sub(
      '  ON public.evidence_chunks (evidence_id, version_id, content_hash)\n  WHERE canonical_chunk_id IS NULL;',
      '  ON public.evidence_chunks (evidence_id, version_id, content_hash);',
    ),
  },
  {
    id: 'G-27',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the deduplication index drops version_id from its column list',
    breaks: 'Uniqueness collapses across versions of the same document: the second version cannot store a passage the first already had, so an edited document silently loses every unchanged paragraph.',
    expectedGate: ['dedup-index'],
    apply: sub(
      'ON public.evidence_chunks (evidence_id, version_id, content_hash)',
      'ON public.evidence_chunks (evidence_id, content_hash)',
    ),
  },
  {
    id: 'G-28',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the deduplication index is no longer UNIQUE',
    breaks: 'It becomes a performance index wearing a uniqueness name. GR-001 §3 asks for the constraint precisely so the in-memory dedup rule survives a partial reindex or a concurrent write.',
    expectedGate: ['dedup-index'],
    apply: sub(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_chunks_version_content',
      'CREATE INDEX IF NOT EXISTS uq_evidence_chunks_version_content',
    ),
  },
  {
    id: 'G-29',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the content/duplicate biconditional is relaxed to allow text on a suppressed occurrence',
    breaks: 'A suppressed occurrence is a location, not a passage: its text is byte-identical to the canonical chunk by definition. Storing it again duplicates private document text for no informational gain, which is what GR-001 and the retention posture both forbid.',
    expectedGate: ['no-duplicate-text'],
    apply: sub(
      'CHECK ((canonical_chunk_id IS NULL) = (content IS NOT NULL)),',
      'CHECK (content IS NULL OR content <> \'\'),',
    ),
  },
]

export const DEFINER_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-30',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: "a definer's search_path becomes 'public, pg_temp'",
    breaks: "With pg_temp on the path a caller creates a temporary object that shadows an unqualified name, and the SECURITY DEFINER then runs the caller's version with the definer's privileges.",
    expectedGate: ['definer-search-path'],
    apply: sub(
      "SET search_path = ''\nAS $$\nDECLARE\n  v_version    public.evidence_document_versions%ROWTYPE;",
      "SET search_path = 'public, pg_temp'\nAS $$\nDECLARE\n  v_version    public.evidence_document_versions%ROWTYPE;",
    ),
  },
  {
    id: 'G-31',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'chunks_in_scope loses SECURITY DEFINER',
    breaks: 'It runs as the caller, so RLS applies and the function returns nothing for uellix_app — which reads as "no chunks" rather than "no privilege", and a grounded answer abstains without anyone learning why.',
    expectedGate: ['definer-security'],
    apply: sub(
      'LANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER',
      'LANGUAGE plpgsql\nSTABLE',
    ),
  },
  {
    id: 'G-32',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the registrar is owned by uellix_owner instead of the capability role',
    breaks: 'A SECURITY DEFINER owned by uellix_owner runs with the privileges of the role that owns all 38 tables. The capability role exists so the function can write ONE table and nothing else.',
    expectedGate: ['definer-owner'],
    apply: sub(
      'ALTER FUNCTION uellix_grounding.register_document_version(uuid, char(64), char(64), char(64), varchar(32), varchar(32), varchar(32), varchar(255))\n  OWNER TO uellix_cap_grounding;',
      'ALTER FUNCTION uellix_grounding.register_document_version(uuid, char(64), char(64), char(64), varchar(32), varchar(32), varchar(32), varchar(255))\n  OWNER TO uellix_owner;',
    ),
  },
  {
    id: 'G-33',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'EXECUTE on the insert function is not revoked from PUBLIC',
    breaks: 'PostgreSQL grants EXECUTE to PUBLIC by default on a new function. Without the revoke, every role in the cluster — anon included — can call the governed write path.',
    expectedGate: ['definer-acl'],
    apply: sub('REVOKE ALL ON FUNCTION uellix_grounding.insert_evidence_chunks(uuid, jsonb) FROM PUBLIC;\n', ''),
  },
  {
    id: 'G-34',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: "chunks_in_scope stops consulting the caller's organizations",
    breaks: 'SECURITY DEFINER bypasses RLS, so this check IS the boundary. Without it any caller that can guess a document_version_id reads another tenant\'s passages, and the scope arguments become decoration.',
    expectedGate: ['definer-scope-check'],
    apply: sub(
      'p_organization_id = ANY(public.current_user_org_ids())\n          OR public.current_user_is_super_admin()',
      'true',
    ),
  },
  {
    id: 'G-35',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the read function returns SELECT * instead of an explicit column list',
    breaks: "A column added later silently changes the function's result shape, and the callers that break are the ones that were reading provenance positionally.",
    expectedGate: ['definer-no-star'],
    apply: sub(
      'SELECT ch.chunk_id, ch.chunk_index, ch.content, ch.content_hash,',
      'SELECT *, ch.content_hash,',
    ),
  },
  {
    id: 'G-36',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the registrar composes and executes dynamic SQL',
    breaks: 'A definer that builds a statement from its arguments is an injection surface running with the capability role\'s privileges, and the static contract cannot read what it will execute.',
    expectedGate: ['definer-no-dynamic-sql', 'unparsed'],
    apply: sub(
      '  RETURN v_id;\nEND;\n$$;',
      "  EXECUTE 'ANALYZE public.evidence_document_versions';\n  RETURN v_id;\nEND;\n$$;",
    ),
  },
  {
    id: 'G-37',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the conflict error quotes the version digest back to the caller',
    breaks: 'An error message is a channel. Echoing a digest to an untrusted caller turns a refusal into an oracle: "does this document exist in some other tenant?" becomes answerable by watching which error comes back.',
    expectedGate: ['definer-error-detail'],
    apply: sub(
      "        'grounding: this version is already registered under a different pipeline; stored anchors would no longer resolve'\n        USING ERRCODE = 'U0101';",
      "        'grounding: version % is already registered under a different pipeline', p_version_id\n        USING ERRCODE = 'U0101';",
    ),
  },
  {
    id: 'G-38',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the capability role is given BYPASSRLS',
    breaks: 'Every RESTRICTIVE policy in both packages stops applying to the one role that writes, so the scope-consistency invariant is enforced nowhere at insert time.',
    expectedGate: ['role-attributes'],
    apply: sub(
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;',
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;',
    ),
  },
  {
    id: 'G-39',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the runtime role is made a member of the capability role',
    breaks: 'SET ROLE is transitive and uellix_app is a LOGIN role. One membership turns the governed write path into two statements from a real connection string, which is the reason the campaign keeps these roles at zero members.',
    expectedGate: ['role-zero-members'],
    apply: sub(
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;\nGRANT uellix_cap_grounding TO uellix_app;',
    ),
  },
]

export const ROLLBACK_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-40',
    file: ROLLBACK.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the authorization comparison is loosened to a truthiness test',
    breaks: "'yes', '1', 'on', 't' and ' true ' all begin authorizing the destruction of chain-of-custody history, so a habit from another tool approves it by accident.",
    expectedGate: ['rollback-authorization'],
    apply: sub(
      "IF authorized IS DISTINCT FROM 'true' THEN",
      "IF authorized IS NULL OR lower(authorized) NOT IN ('true','yes','1','on','t') THEN",
    ),
  },
  {
    id: 'G-41',
    file: ROLLBACK.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the persisted-setting provenance check is removed',
    breaks: 'An ALTER DATABASE/ROLE ... SET pre-authorizes every future session, which moves the defect from psql flags to the GUC layer instead of removing it. The session that destroys the history need never have approved anything.',
    expectedGate: ['rollback-authorization'],
    apply: sub(
      `      SELECT EXISTS (
        SELECT 1 FROM pg_db_role_setting s`,
      `      SELECT false, EXISTS (
        SELECT 1 FROM pg_catalog.pg_class s`,
    ),
  },
  {
    id: 'G-42',
    file: ROLLBACK.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the FORCE ROW LEVEL SECURITY guard on the row count is removed',
    breaks: 'FORCE removes the owner\'s RLS bypass, so an owner without rolbypassrls counts 0 over a populated table. The script then announces "no history lost" in the log while destroying it — reproduced on PostgreSQL 17.6 for stella_0003.',
    expectedGate: ['rollback-authorization'],
    apply: sub(
      "    IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = tbl_oid) THEN",
      "    IF false THEN",
    ),
  },
  {
    id: 'G-43',
    file: ROLLBACK.CHUNKS,
    severity: 'CRITICAL',
    contract: 'both',
    change: 'the chunk rollback also drops the schema and the capability role',
    breaks: 'It takes objects grounding_0002 owns and still needs. A database with the version history applied loses its governed write path, and the next apply of 0003 finds a role that no longer exists.',
    expectedGate: ['rollback-targets'],
    apply: sub(
      "    EXECUTE 'DROP TABLE public.evidence_chunks';",
      "    EXECUTE 'DROP TABLE public.evidence_chunks';\n    EXECUTE 'DROP SCHEMA uellix_grounding';",
    ),
  },
  {
    id: 'G-44',
    file: ROLLBACK.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the post-drop assertion that the version history survived is removed',
    breaks: 'A CASCADE added to the DROP above would take the chain of custody with it, and this assertion is the last moment at which the transaction could still roll back.',
    expectedGate: ['rollback-targets'],
    apply: sub(
      "  IF to_regclass('public.evidence_document_versions') IS NULL\n     AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'uellix_grounding') THEN",
      '  IF false THEN',
    ),
  },
  {
    id: 'G-45',
    file: ROLLBACK.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the table is dropped with CASCADE',
    breaks: 'CASCADE silently removes every dependent object this rollback never named — including, for a future package, whatever came to reference the chunk index.',
    expectedGate: ['rollback-no-cascade'],
    apply: sub(
      "EXECUTE 'DROP TABLE public.evidence_chunks';",
      "EXECUTE 'DROP TABLE public.evidence_chunks CASCADE';",
    ),
  },
  {
    id: 'G-46',
    file: ROLLBACK.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the DROP is moved out of the DO block to the top level',
    breaks: "The guard and the destruction become two statements. Without -v ON_ERROR_STOP=1 psql reports the guard's error and SENDS THE NEXT STATEMENT — and those flags are a convention of invocation, not a property of the file. The Supabase SQL editor supplies neither.",
    expectedGate: ['rollback-single-block'],
    apply: sub(
      'DO $$\nDECLARE\n  tbl_oid      oid;',
      'DROP TABLE IF EXISTS public.evidence_document_versions;\n\nDO $$\nDECLARE\n  tbl_oid      oid;',
    ),
  },
  {
    id: 'G-47',
    file: ROLLBACK.VERSIONS,
    severity: 'MAJOR',
    contract: 'both',
    change: 'the refusal to run while evidence_chunks still references the table is removed',
    breaks: 'The rollback either fails with PostgreSQL\'s raw foreign-key message or, once someone adds a CASCADE, silently takes the chunk index with the history.',
    expectedGate: ['rollback-targets'],
    apply: sub(
      "      'grounding_0002 rollback refused: public.evidence_chunks still references this table. Roll back grounding_0003 first (db/prepared/grounding_0003_rollback.sql).';",
      "      'grounding_0002 rollback refused: dependent objects present.';",
    ),
  },
]

export const INTEGRITY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-52',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'the active-version reader is redeclared as a PROCEDURE',
    breaks: 'It disappears from the definer inventory, so every per-function assertion — search_path, ownership, ACL, the caller-boundary check — stops being applied to it while the object still exists and is still callable.',
    expectedGate: ['definer-inventory'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_grounding.claim_active_document_version(',
      'CREATE OR REPLACE PROCEDURE uellix_grounding.claim_active_document_version(',
    ),
  },
  {
    id: 'G-53',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the definer INSERT policy is reduced to WITH CHECK (true)',
    breaks: 'The policy still exists, is still RESTRICTIVE-compatible and still names one role, so every shape assertion passes — while the scope it was written to verify is no longer compared to anything, and a version can be filed under an organization its evidence item does not belong to.',
    expectedGate: ['policy-predicate'],
    apply: sub(
      `WITH CHECK (
  -- The scope written must be the scope the evidence row actually has. The
  -- registrar derives it, so this can only fire if someone changes the
  -- registrar — which is the point: the invariant is in the database, not only
  -- in the function that currently upholds it.
  EXISTS (
    SELECT 1 FROM public.evidence_items e
    WHERE e.id = evidence_document_versions.evidence_id
      AND e.organization_id = evidence_document_versions.organization_id
      AND e.project_id = evidence_document_versions.project_id
  )
);`,
      'WITH CHECK (true);',
    ),
  },
  {
    id: 'G-48',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'an EXCEPTION WHEN handler is added around the shape guard',
    breaks: "A handler swallows the guard's RAISE and lets every statement after it run, with the whole suite green. The script then adopts an incompatible table and reports success.",
    expectedGate: ['no-exception-handler'],
    apply: sub(
      '    END IF;\n  END IF;\nEND $$;\n\n-- ============================================================\n-- 1. Table (owner window)',
      '    END IF;\n  END IF;\nEXCEPTION WHEN OTHERS THEN\n  RAISE NOTICE \'shape guard skipped\';\nEND $$;\n\n-- ============================================================\n-- 1. Table (owner window)',
    ),
  },
  {
    id: 'G-49',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'privilege self-verification stops using aclexplode',
    breaks: 'information_schema reports privileges a role merely INHERITS through membership and short-circuits for superusers, so an over-granted table verifies clean. That is exactly what made the old write-path guard in stella_0003 vacuous.',
    expectedGate: ['self-verification'],
    apply: (sql) => sql.split('aclexplode').join('information_schema_privileges'),
  },
  {
    id: 'G-50',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the zero-members postcondition is removed from self-verification',
    breaks: 'Nothing re-checks, at the end of the transaction, that the capability role is still unreachable by SET ROLE — and a membership granted between the two packages would pass every other assertion.',
    expectedGate: ['self-verification'],
    apply: (sql) => sql.split('pg_auth_members').join('pg_class'),
  },
  {
    id: 'G-51',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'a constraint rebuild is rewritten as EXECUTE format(...)',
    breaks: 'The static contract cannot read a composed statement, so it is reported as unparsed rather than judged. Every gate that reads that statement goes quiet while the SQL still runs.',
    expectedGate: ['unparsed'],
    apply: sub(
      '      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_chunk_index_check;',
      "      EXECUTE format('ALTER TABLE public.evidence_chunks DROP CONSTRAINT %I', 'evidence_chunks_chunk_index_check');",
    ),
  },
]

// TRAIN 3 HARDENING — canonical_chunk_id integrity, server-derived chunk_id,
// and ENABLE ALWAYS. Each mutation removes one property this train added and
// names the gate that must be the one to notice.
export const CANONICAL_INTEGRITY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'G-54',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'evidence_chunks_canonical_fk is removed from the table definition',
    breaks: 'canonical_chunk_id can name ANY 64-hex string again — out of scope, out of version, or with different content — because nothing checks that the target row exists and agrees on organization, project, evidence item, document version and content_hash.',
    expectedGate: ['canonical-fk'],
    apply: sub(
      `  -- The dedup relation's referential integrity. canonical_chunk_id must name a
  -- chunk that EXISTS and shares this row's organization, project, evidence
  -- item, document version AND content_hash — "the same passage, the same
  -- document, the same tenant" — closing risk #1 (no FK existed at all: any
  -- 64-hex string was accepted, canonical or not, in scope or out of it).
  --
  -- This does NOT by itself stop a chain (A -> B -> C) or a cycle (A -> B,
  -- B -> A): a FK only proves the target row exists and matches scope, not
  -- that the target is ITSELF canonical. That half of risk #2 is closed by
  -- trg_evidence_chunks_canonical_integrity in section 7b, which requires the
  -- target's OWN canonical_chunk_id to be NULL — so canonical_chunk_id can
  -- only ever point one level deep, at a row nothing else points through, and
  -- a chain or a cycle of any length becomes unrepresentable rather than
  -- merely undetected. Self-reference (A -> A) is already excluded by
  -- evidence_chunks_hash_shape_check's \`canonical_chunk_id <> chunk_id\`.
  CONSTRAINT evidence_chunks_canonical_fk
    FOREIGN KEY (canonical_chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)
    REFERENCES public.evidence_chunks (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash)
    ON DELETE CASCADE
);`,
      ');',
    ),
  },
  {
    id: 'G-55',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'evidence_chunks_identity_scope_unique (the FK target) is removed from the table definition',
    breaks: "Without it, PostgreSQL has no UNIQUE/PK constraint over exactly (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash) to bind evidence_chunks_canonical_fk to — the package would fail to install at all, which is worse than a weaker guarantee: the failure mode is silent until someone tries to apply it.",
    expectedGate: ['canonical-fk'],
    apply: sub(
      `  CONSTRAINT evidence_chunks_identity_scope_unique
    UNIQUE (chunk_id, organization_id, project_id, evidence_id, document_version_id, content_hash),

`,
      '',
    ),
  },
  {
    id: 'G-56',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'evidence_chunks_version_scope_fk is removed from the table definition',
    breaks: "A chunk's organization, project, evidence item or pipeline versions can disagree with its own document version row again. Only the RESTRICTIVE RLS policy would say so, and RLS does not bind the table owner — a direct `SET ROLE uellix_owner; INSERT ...` bypasses it completely.",
    expectedGate: ['version-scope-fk'],
    apply: sub(
      `  CONSTRAINT evidence_chunks_version_scope_fk
    FOREIGN KEY (document_version_id, organization_id, project_id, evidence_id, version_id,
                 raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
    REFERENCES public.evidence_document_versions (id, organization_id, project_id, evidence_id, version_id,
                 raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
    ON DELETE CASCADE,

`,
      '',
    ),
  },
  {
    id: 'G-57',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'evidence_document_versions_identity_unique (evidence_chunks\' FK target) is removed from the table definition',
    breaks: 'evidence_chunks_version_scope_fk has no UNIQUE/PK constraint over exactly its 9 referenced columns to bind to — grounding_0003 fails to install.',
    expectedGate: ['identity-unique'],
    apply: sub(
      `  CONSTRAINT evidence_document_versions_identity_unique
    UNIQUE (id, organization_id, project_id, evidence_id, version_id,
            raw_content_hash, normalized_content_hash, normalization_version, chunker_version)
);`,
      ');',
    ),
  },
  {
    id: 'G-58',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the self-reference clause is dropped from evidence_chunks_hash_shape_check',
    breaks: 'A chunk can name itself as its own canonical_chunk_id. Combined with the content-presence biconditional, a self-referencing row has canonical_chunk_id NOT NULL and so content IS NULL — a chunk that cites nothing and resolves nowhere, forever.',
    expectedGate: ['canonical-self-reference-check'],
    apply: sub(
      "AND (canonical_chunk_id IS NULL\n                OR (canonical_chunk_id ~ '^[0-9a-f]{64}$' AND canonical_chunk_id <> chunk_id))),",
      "AND (canonical_chunk_id IS NULL\n                OR canonical_chunk_id ~ '^[0-9a-f]{64}$')),",
    ),
  },
  {
    id: 'G-59',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'insert_evidence_chunks stores the caller\'s chunk_id directly instead of the server-derived one',
    breaks: "A caller can choose ANY chunk_id — including one already used by another tenant's chunk sharing the same UNIQUE(chunk_id), or one that simply does not derive from what was actually stored, so a citation naming it can never be re-verified from the sealed file.",
    expectedGate: ['chunk-id-server-derivation'],
    apply: sub(
      `  SELECT
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        'grounding/chunk/v1' || chr(10) || v_version.version_id || chr(10) || c.chunk_index::text || chr(10) || c.content_hash,
        'UTF8')),
      'hex'),
    v_version.organization_id,`,
      `  SELECT
    c.chunk_id,
    v_version.organization_id,`,
    ),
  },
  {
    id: 'G-60',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the chunk_id derivation/verification check is removed from insert_evidence_chunks',
    breaks: 'A caller-supplied chunk_id that does NOT derive from (version_id, chunk_index, content_hash) is no longer rejected — the mismatch is never surfaced, even though (with G-59 absent) the row would still be stored under the correct derived value, so a citation computed the same way the caller did would silently point at a different row than the one the caller believed it created.',
    expectedGate: ['chunk-id-server-derivation'],
    apply: sub(
      `  SELECT count(*) INTO v_mismatched
  FROM jsonb_to_recordset(p_chunks) AS c(chunk_id char(64), chunk_index integer, content_hash char(64))
  WHERE c.chunk_id IS DISTINCT FROM pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'grounding/chunk/v1' || chr(10) || v_version.version_id || chr(10) || c.chunk_index::text || chr(10) || c.content_hash,
      'UTF8')),
    'hex');

  IF v_mismatched > 0 THEN
    RAISE EXCEPTION
      'grounding: % chunk(s) carry a chunk_id that does not derive from (version_id, chunk_index, content_hash)', v_mismatched
      USING ERRCODE = 'U0104';
  END IF;

`,
      '',
    ),
  },
  {
    id: 'G-61',
    file: FORWARD.VERSIONS,
    severity: 'MAJOR',
    contract: 'GR-002',
    change: 'ENABLE ALWAYS is dropped for the append-only trigger',
    breaks: 'session_replication_role=replica silences the trigger. A session that sets replica mode — deliberately, to bypass triggers, or incidentally, via logical replication — can UPDATE or DELETE a version row with nothing to stop it.',
    expectedGate: ['history-append-only-triggers'],
    apply: sub(
      'ALTER TABLE public.evidence_document_versions ENABLE ALWAYS TRIGGER trg_evidence_document_versions_append_only;\n',
      '',
    ),
  },
  {
    id: 'G-62',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'ENABLE ALWAYS is dropped for the no-update trigger',
    breaks: 'session_replication_role=replica silences the trigger, so a chunk can be rewritten in place under replica mode with nothing to stop it.',
    expectedGate: ['chunk-immutability-triggers'],
    apply: sub(
      'ALTER TABLE public.evidence_chunks ENABLE ALWAYS TRIGGER trg_evidence_chunks_no_update;\n',
      '',
    ),
  },
  {
    id: 'G-63',
    file: FORWARD.VERSIONS,
    severity: 'CRITICAL',
    contract: 'GR-002',
    change: 'the owner-proof scope-check trigger is removed entirely',
    breaks: "`SET ROLE uellix_owner; INSERT INTO evidence_document_versions ...` can file a version under an organization or project its evidence item does not belong to — the RLS WITH CHECK that used to be the only guard does not bind the table owner.",
    expectedGate: ['history-append-only-triggers'],
    apply: sub(
      `DROP TRIGGER IF EXISTS trg_evidence_document_versions_scope_check ON public.evidence_document_versions;
CREATE TRIGGER trg_evidence_document_versions_scope_check
  BEFORE INSERT ON public.evidence_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.uellix_check_document_version_scope();

`,
      '',
    ),
  },
  {
    id: 'G-64',
    file: FORWARD.CHUNKS,
    severity: 'CRITICAL',
    contract: 'GR-001',
    change: 'the canonical-acyclicity trigger is removed entirely',
    breaks: 'canonical_chunk_id can chain through a non-canonical row (A -> B, B -> C where B is itself a duplicate) — the composite FK alone proves the target EXISTS and matches scope, never that the target is itself canonical, so a chain or a cycle of any length becomes representable again.',
    expectedGate: ['chunk-immutability-triggers'],
    apply: sub(
      `DROP TRIGGER IF EXISTS trg_evidence_chunks_canonical_integrity ON public.evidence_chunks;
CREATE TRIGGER trg_evidence_chunks_canonical_integrity
  AFTER INSERT ON public.evidence_chunks
  FOR EACH ROW EXECUTE FUNCTION public.uellix_check_canonical_chunk();

`,
      '',
    ),
  },
  {
    id: 'G-65',
    file: FORWARD.CHUNKS,
    severity: 'MAJOR',
    contract: 'GR-001',
    change: 'the canonical-acyclicity trigger fires BEFORE instead of AFTER',
    breaks: "BEFORE INSERT sees the row being inserted but not the FINAL state of other rows the same statement or transaction is still writing — combined with insert_evidence_chunks' two-pass insert, a BEFORE trigger checking a duplicate in pass 2 could race a canonical row pass 1 has not yet made visible to it, in the ways PostgreSQL's own visibility rules for BEFORE vs AFTER triggers differ.",
    expectedGate: ['chunk-immutability-triggers'],
    apply: sub(
      'CREATE TRIGGER trg_evidence_chunks_canonical_integrity\n  AFTER INSERT ON public.evidence_chunks',
      'CREATE TRIGGER trg_evidence_chunks_canonical_integrity\n  BEFORE INSERT ON public.evidence_chunks',
    ),
  },
]

export const MUTATIONS: readonly Mutation[] = [
  ...ISOLATION_MUTATIONS,
  ...PRIVILEGE_MUTATIONS,
  ...APPEND_ONLY_MUTATIONS,
  ...CONTRACT_MUTATIONS,
  ...DEFINER_MUTATIONS,
  ...ROLLBACK_MUTATIONS,
  ...INTEGRITY_MUTATIONS,
  ...CANONICAL_INTEGRITY_MUTATIONS,
]
