// tests/helpers/train4-mutations.ts
//
// The catalogue of deliberate breakages for the Train 4 persistence packages.
//
// Each entry names ONE property of INT-CAP-001..004 / INT-GR-004, the edit that
// removes it, and the gate in tests/helpers/train4-gates.ts that must refuse
// the result. tests/train4-persistence-mutation.test.ts applies them to an
// in-memory copy — nothing here writes to db/prepared.
//
// Three rules carry over from tests/grounding-persistence-mutation.test.ts, and
// they are what make the count mean anything:
//
//   1. A mutation must actually CHANGE the text. A stale anchor matches
//      nothing, produces an unmutated source, and yields a violation-free run
//      that reads as a pass.
//   2. It is not enough that SOMETHING objected. The gate that OWNS the
//      property must fire, or the day that gate is weakened the suite stays
//      green because a bystander still notices.
//   3. A mutation is NOT detected because the mutated SQL would fail to
//      compile. "PostgreSQL would have rejected it" is an argument about a
//      database this unit is forbidden from touching. Detection means: a named
//      gate returned a violation, offline, from the text.

import { FORWARD, ROLLBACK } from './train4-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The contract clause the property comes from. */
  readonly contract: 'INT-CAP-001' | 'INT-CAP-002' | 'INT-CAP-003' | 'INT-CAP-004' | 'INT-GR-004'
  readonly change: string
  readonly breaks: string
  readonly expectedGate: readonly string[]
  readonly apply: (sql: string) => string
}

/**
 * Replace the first occurrence, or return the input unchanged.
 *
 * The replacement goes through a FUNCTION, not a string. `String.replace` with
 * a string replacement treats `$$` as an escape for a literal `$`, and several
 * anchors below quote PostgreSQL dollar quotes — so a plain string replacement
 * silently breaks the quote and kills the mutant with an `unparsed` violation
 * instead of the gate it was written to exercise.
 */
const sub = (from: string, to: string) => (sql: string) => sql.replace(from, () => to)

/* -------------------------------------------------------------------------- */
/* INT-CAP-001 — the governed vocabulary                                      */
/* -------------------------------------------------------------------------- */

export const VOCABULARY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-01',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'grounded_query is removed from the stella_role CHECK',
    breaks: 'The literal ask of INT-CAP-001. A grounded query becomes unrepresentable in the ledger again, so the capability enforces a monthly quota it cannot charge and local-runtime-ready stays blocked for the reason it was already blocked.',
    expectedGate: ['quota-role-vocabulary'],
    apply: sub(
      "                             'evidence_reviewer', 'audit_assistant', 'grounded_query'));",
      "                             'evidence_reviewer', 'audit_assistant'));",
    ),
  },
  {
    id: 'T-02',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: "grounded_query is removed from the function's governed array while the CHECK keeps it",
    breaks: 'The two lists drift. A capability the constraint admits and the function rejects can be RECORDED by the direct write path and never CHARGED by the governed one, which is the same "enforced but not charged" split one layer down and harder to see.',
    expectedGate: ['quota-role-vocabulary'],
    apply: sub(
      "                              'evidence_reviewer', 'audit_assistant', 'grounded_query'];",
      "                              'evidence_reviewer', 'audit_assistant'];",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* INT-CAP-001 — the consumption mechanism                                    */
/* -------------------------------------------------------------------------- */

export const CONSUMPTION_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-03',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the charge is written to a different table than the one the quota is measured from',
    breaks: 'checkStellaQuota counts rows of stella_interactions. A charge recorded anywhere else is a charge no quota check will ever see, so the function reports "consumed" while usage never moves — the exact defect INT-CAP-001 reports, wearing a governed name.',
    expectedGate: ['quota-transactional-path'],
    apply: sub(
      '  INSERT INTO public.stella_interactions (',
      '  INSERT INTO public.stella_quota_shadow (',
    ),
  },
  {
    id: 'T-04',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the advisory lock is removed entirely',
    breaks: 'Two transactions racing for the last unit both read used = quota - 1, both pass the limit check and both insert. The organization spends one unit more than it was sold, and nothing in the ledger says which of the two was the overspend.',
    expectedGate: ['quota-advisory-lock'],
    apply: sub(
      "  PERFORM pg_advisory_xact_lock(hashtextextended('stella/quota/' || p_organization_id::text, 0));\n",
      '',
    ),
  },
  {
    id: 'T-05',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the advisory lock is taken AFTER the usage count instead of before it',
    breaks: 'Serialising after the decision serialises nothing: both transactions have already read the same usage, so both queue and both then charge on a number that was true for neither. A lock in the wrong place reads as protection in every review that greps for the primitive.',
    expectedGate: ['quota-advisory-lock'],
    apply: (sql) => {
      const lockLine =
        "  PERFORM pg_advisory_xact_lock(hashtextextended('stella/quota/' || p_organization_id::text, 0));\n"
      const anchor =
        '  SELECT o.stella_monthly_quota INTO v_quota\n'
      return sql.replace(lockLine, () => '').replace(anchor, () => lockLine + anchor)
    },
  },
  {
    id: 'T-06',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'the advisory lock key stops being namespaced',
    breaks: "grounding_0002's register_document_version hashes a bare uuid text with the same primitive and the same seed. An un-namespaced organization key can collide with an evidence-item key, so an ingestion and a quota consumption serialise against each other for reasons neither can see and neither can debug.",
    expectedGate: ['quota-advisory-lock'],
    apply: sub(
      "hashtextextended('stella/quota/' || p_organization_id::text, 0)",
      'hashtextextended(p_organization_id::text, 0)',
    ),
  },
  {
    id: 'T-07',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the limit comparison is short-circuited to false',
    breaks: 'Every call charges. The monthly quota becomes a number displayed on a screen with nothing behind it, and an organization sold 50 queries can run any number of them — which is worse than the reported defect, because usage now moves and looks enforced.',
    expectedGate: ['quota-limit-check'],
    apply: sub('    IF v_used >= v_quota THEN', '    IF false THEN'),
  },
  {
    id: 'T-08',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'an exhausted quota and an unassigned one collapse into one outcome',
    breaks: 'The product renders them differently and must: "your organization has no Stella plan" is a sales conversation, and "you used your 50 queries, they renew on the 1st" is not. Collapsing them sends every blocked reviewer to the wrong message.',
    expectedGate: ['quota-limit-check'],
    apply: sub("      RETURN QUERY SELECT 'no_quota'::text, v_used, v_quota;", "      RETURN QUERY SELECT 'quota_exceeded'::text, v_used, v_quota;"),
  },
  {
    id: 'T-09',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: "the caller's organization membership is never consulted",
    breaks: 'SECURITY DEFINER bypasses RLS, so this check IS the boundary. Without it any caller holding an organization id — a uuid that appears in URLs — charges that tenant\'s ledger and exhausts a quota belonging to somebody else.',
    expectedGate: ['quota-caller-boundary'],
    apply: sub(
      `  IF NOT (p_organization_id = ANY(public.current_user_org_ids())
          OR public.current_user_is_super_admin()) THEN
    RAISE EXCEPTION 'stella quota: organization not found' USING ERRCODE = 'U0102';
  END IF;
`,
      '',
    ),
  },
  {
    id: 'T-10',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the project is no longer checked against the organization being charged',
    breaks: "A caller inside organization A files a unit against a project of organization B while still satisfying its own membership check. The ledger then attributes A's spend to a project A cannot see, and B's usage reports gain a row B never caused.",
    expectedGate: ['quota-caller-boundary'],
    apply: sub(
      `  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'stella quota: organization not found' USING ERRCODE = 'U0102';
  END IF;
`,
      '',
    ),
  },
  {
    id: 'T-11',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the actor becomes an argument instead of being derived from the session',
    breaks: 'A caller charges a unit in another user\'s name. The compliance trail then attributes a Stella invocation to somebody who never made one, and "who ran this query?" — the question the trail exists to answer — is answerable only by whoever wrote the payload.',
    expectedGate: ['quota-actor-derived'],
    apply: sub(
      `  p_stella_role varchar(50),
  p_idempotency_key char(64)
)`,
      `  p_stella_role varchar(50),
  p_idempotency_key char(64),
  p_created_by uuid
)`,
    ),
  },
  {
    id: 'T-12',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'the fixed response_json literal is replaced by caller-derived content',
    breaks: 'A quota row records that a unit was spent. The moment it can carry caller text it carries a prompt or a passage, which puts private document content into a table five other flows read for usage analytics and which the retention policy never scoped for it.',
    expectedGate: ['quota-no-payload-in-ledger'],
    apply: sub(
      `    '{"kind":"quota_consumption","version":1}'::jsonb,`,
      '    to_jsonb(p_stella_role),',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* INT-CAP-001 — idempotency                                                  */
/* -------------------------------------------------------------------------- */

export const IDEMPOTENCY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-13',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the ON CONFLICT ... DO NOTHING clause is removed from the charge',
    breaks: 'A retried server action charges twice. Every network timeout on a grounded query costs the organization a second unit for an answer it never received, and the ledger records two invocations where one happened.',
    expectedGate: ['quota-idempotency'],
    apply: sub(
      `  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING;`,
      '  ;',
    ),
  },
  {
    id: 'T-14',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the idempotency index is no longer UNIQUE',
    breaks: 'It becomes a performance index wearing a uniqueness name. ON CONFLICT has no arbiter to infer, and the no-double-charge guarantee stops being a property of the data — so the direct write path, which takes no advisory lock, can charge the same key any number of times.',
    expectedGate: ['quota-idempotency'],
    apply: sub(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_stella_interactions_idempotency',
      'CREATE INDEX IF NOT EXISTS uq_stella_interactions_idempotency',
    ),
  },
  {
    id: 'T-15',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the idempotency index loses its WHERE predicate',
    breaks: 'Every row written by the five pre-existing Stella roles carries a NULL key. Without the predicate the index covers them too, and although NULLs do not collide in a b-tree, the index stops describing the set it was written for — the package then claims a guarantee scoped to identified charges while indexing rows that have no identity.',
    expectedGate: ['quota-idempotency'],
    apply: sub(
      `  ON public.stella_interactions (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;`,
      '  ON public.stella_interactions (organization_id, idempotency_key);',
    ),
  },
  {
    id: 'T-16',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'the key stops being mandatory for grounded_query',
    breaks: "uellix_app inherits uellix_writer, which holds INSERT on this table, so the governed function is not the only way a row lands here. Without the mandate that direct path files an unidentified grounded_query charge, which no retry can recognise and no audit can match to an operation.",
    expectedGate: ['quota-idempotency'],
    apply: sub(
      "      CHECK (stella_role <> 'grounded_query' OR idempotency_key IS NOT NULL);",
      '      CHECK (idempotency_key IS NULL OR idempotency_key IS NOT NULL);',
    ),
  },
  {
    id: 'T-17',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'the idempotency_key column is never added',
    breaks: 'There is nothing for the index, the CHECKs or the conflict clause to reference, so the whole no-double-charge apparatus is applied to a column that does not exist and the package installs an identity mechanism with no identity in it.',
    expectedGate: ['quota-idempotency'],
    apply: sub(
      '  ADD COLUMN IF NOT EXISTS idempotency_key char(64);',
      '  ADD COLUMN IF NOT EXISTS idempotency_note text;',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* INT-CAP-001 — privilege and policy                                         */
/* -------------------------------------------------------------------------- */

export const PRIVILEGE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-18',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the capability role receives UPDATE on the ledger',
    breaks: 'An append-only compliance trail whose writer can rewrite a row in place is not one. A charge could be relabelled to a different capability, a different project or a different actor after the fact, with the row keeping its identity and its timestamp.',
    expectedGate: ['train4-write-grant'],
    apply: sub(
      'GRANT SELECT, INSERT ON public.stella_interactions TO uellix_cap_stella_quota;',
      'GRANT SELECT, INSERT, UPDATE ON public.stella_interactions TO uellix_cap_stella_quota;',
    ),
  },
  {
    id: 'T-19',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'the defensive REVOKE of UPDATE/DELETE/TRUNCATE from the capability role is dropped',
    breaks: "Supabase's ALTER DEFAULT PRIVILEGES is what left four audit tables TRUNCATE-able and forced stella_0002b. Relying on \"we never granted it\" instead of revoking means the posture holds only until the next bootstrap grants something nobody asked for.",
    expectedGate: ['quota-ledger-append-only'],
    apply: sub(
      'REVOKE UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_quota;\n',
      '',
    ),
  },
  {
    id: 'T-20',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the definer INSERT policy also names the runtime role',
    breaks: 'The policy exists to bind the ONE role that charges. Naming uellix_app as well hands the shared runtime identity a second, ungoverned way to write a charge row directly — around the advisory lock, around the limit check and around the replay check.',
    expectedGate: ['quota-definer-insert-policy'],
    apply: sub(
      'ON public.stella_interactions FOR INSERT\nTO uellix_cap_stella_quota',
      'ON public.stella_interactions FOR INSERT\nTO uellix_cap_stella_quota, uellix_app',
    ),
  },
  {
    id: 'T-21',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the policy stops tying the project charged to the organization charged',
    breaks: 'The cross-organization invariant survives only inside the function body. A future edit to that body — or the direct write path, which never enters it — files a unit against a project of another tenant while the policy waves it through.',
    expectedGate: ['quota-definer-insert-policy'],
    apply: sub(
      `  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = stella_interactions.project_id
      AND p.organization_id = stella_interactions.organization_id
  )
);`,
      ');',
    ),
  },
  {
    id: 'T-22',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the capability role is given BYPASSRLS',
    breaks: 'Every policy this package writes stops applying to the one role that writes, so the created_by, idempotency and cross-organization invariants are enforced nowhere at insert time and rest entirely on a function body nobody re-reads.',
    expectedGate: ['role-attributes'],
    apply: sub(
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;',
      'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;',
    ),
  },
  {
    id: 'T-23',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the runtime role is made a member of the capability role',
    breaks: 'SET ROLE is transitive and uellix_app is a LOGIN role. One membership turns the governed charge path into two statements from a real connection string, which is the reason this campaign keeps every capability role at zero members.',
    expectedGate: ['role-zero-members'],
    apply: sub(
      'GRANT USAGE ON SCHEMA uellix_stella TO uellix_app;',
      'GRANT USAGE ON SCHEMA uellix_stella TO uellix_app;\nGRANT uellix_cap_stella_quota TO uellix_app;',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* SECURITY DEFINER contract                                                  */
/* -------------------------------------------------------------------------- */

export const DEFINER_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-24',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the consumption function loses SECURITY DEFINER',
    breaks: 'It runs as the caller. uellix_app then needs direct INSERT on the ledger for the path to work at all, which is precisely the ungoverned write this package exists to replace — and the RLS policy written for the capability role stops applying to anybody.',
    expectedGate: ['definer-security'],
    apply: sub(
      'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = \'\'',
      "LANGUAGE plpgsql\nSET search_path = ''",
    ),
  },
  {
    id: 'T-25',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: "the definer's search_path becomes 'public, pg_temp'",
    breaks: "With pg_temp on the path a caller creates a temporary object that shadows an unqualified name, and the SECURITY DEFINER then runs the caller's version with the capability role's privileges — including its INSERT on the ledger.",
    expectedGate: ['definer-search-path'],
    apply: sub("SET search_path = ''\nAS $$\nDECLARE", "SET search_path = 'public, pg_temp'\nAS $$\nDECLARE"),
  },
  {
    id: 'T-26',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the consumption function is owned by uellix_owner instead of the capability role',
    breaks: 'A SECURITY DEFINER owned by uellix_owner runs with the privileges of the role that owns every table in the schema. The capability role exists so the charge path can write ONE table and read three, and nothing else.',
    expectedGate: ['definer-owner'],
    apply: sub('  OWNER TO uellix_cap_stella_quota;', '  OWNER TO uellix_owner;'),
  },
  {
    id: 'T-27',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'EXECUTE on the consumption function is not revoked from PUBLIC',
    breaks: 'PostgreSQL grants EXECUTE to PUBLIC by default on a new function. Without the revoke every role in the cluster — anon included — can call the governed charge path, and anon has no session, so it would exhaust nothing and charge nothing but would map the error taxonomy for free.',
    expectedGate: ['definer-acl'],
    apply: sub(
      'REVOKE ALL ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) FROM PUBLIC;\n',
      '',
    ),
  },
  {
    id: 'T-28',
    file: FORWARD.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the runtime role loses EXECUTE on the consumption function',
    breaks: 'The package installs cleanly and the whole path is dead: every call fails with permission denied, the server action reports an unknown error, and a dry-run that only inspects structure certifies that the function exists. This is the exact class of defect that made both grounding packages functionally dead in train 2.',
    expectedGate: ['definer-acl'],
    apply: sub(
      'GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) TO uellix_app;\n',
      '',
    ),
  },
  {
    id: 'T-29',
    file: FORWARD.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-GR-004',
    change: 'the attested reader is declared outside the capability schema',
    breaks: 'It disappears from the definer inventory, so every per-function assertion — search_path, ownership, ACL, the caller-boundary check — stops being applied to it while the object still exists and is still callable.',
    expectedGate: ['definer-inventory'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_grounding.chunks_in_scope_attested(',
      'CREATE OR REPLACE FUNCTION public.chunks_in_scope_attested(',
    ),
  },
  {
    id: 'T-30',
    file: FORWARD.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-GR-004',
    change: 'the argument-validation error quotes the requested version back to the caller',
    breaks: 'An error message is a channel. Echoing an id to an untrusted caller turns a refusal into an oracle: "does this document version exist in some other tenant?" becomes answerable by watching which error comes back.',
    expectedGate: ['definer-error-detail'],
    apply: sub(
      "    RAISE EXCEPTION 'grounding: organization, project and document version are all required' USING ERRCODE = 'U0100';",
      "    RAISE EXCEPTION 'grounding: version % is not readable', p_document_version_id USING ERRCODE = 'U0100';",
    ),
  },
  {
    id: 'T-31',
    file: FORWARD.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-GR-004',
    change: 'the attested reader returns SELECT * instead of an explicit column list',
    breaks: "A column added to evidence_chunks later silently changes the function's result shape, and the callers that break are the ones reading provenance positionally — which is every caller that trusted a fixed column order to compare scope.",
    expectedGate: ['definer-no-star'],
    apply: sub(
      '  SELECT ch.chunk_id, ch.chunk_index, ch.content, ch.content_hash,',
      '  SELECT *, ch.content_hash,',
    ),
  },
  {
    id: 'T-32',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'the attested reader composes and executes dynamic SQL',
    breaks: "A definer that builds a statement at run time is an injection surface running with the capability role's privileges, and the static contract cannot read what it will execute — every gate that inspects the body goes quiet while the SQL still runs.",
    expectedGate: ['definer-no-dynamic-sql'],
    apply: sub(
      '  RETURN QUERY\n  SELECT ch.chunk_id,',
      "  EXECUTE 'ANALYZE public.evidence_chunks';\n  RETURN QUERY\n  SELECT ch.chunk_id,",
    ),
  },
  {
    id: 'T-56',
    file: FORWARD.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-CAP-003',
    change: 'a constraint rebuild is rewritten as EXECUTE format(...)',
    breaks: 'The static contract cannot read a composed statement, so it is reported as unparsed rather than judged. Every gate that reads that statement goes quiet while the SQL still runs — which makes the OTHER gates report a clean file for a package they never finished reading.',
    expectedGate: ['unparsed'],
    apply: sub(
      '      ALTER TABLE public.evidence_chunks DROP CONSTRAINT evidence_chunks_content_hash_derivation_check;',
      "      EXECUTE format('ALTER TABLE public.evidence_chunks DROP CONSTRAINT %I', 'evidence_chunks_content_hash_derivation_check');",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* INT-GR-004 — scope attestation                                             */
/* -------------------------------------------------------------------------- */

export const ATTESTATION_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-33',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'organization_id is dropped from the attested result shape',
    breaks: "The repository adapter is back to stamping the organization it asked for onto every chunk, so enforceRepositoryScope's isSameScope compares the query's scope with itself. The guard reads as verification and verifies nothing — which is the finding INT-GR-004 exists to close.",
    expectedGate: ['scope-attestation-columns'],
    apply: sub(
      '  signals jsonb,\n  organization_id uuid,\n  project_id uuid,',
      '  signals jsonb,\n  project_id uuid,',
    ),
  },
  {
    id: 'T-34',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'project_id is dropped from the attested result shape',
    breaks: "Project is the boundary this product has no membership table for: buildAdvisorContext authorises a project by checking only that it belongs to the session's organization. Without the column returned, a cross-project chunk is undetectable above SQL, and scopeContains becomes tautological for the narrower half of the scope.",
    expectedGate: ['scope-attestation-columns'],
    apply: sub(
      '  organization_id uuid,\n  project_id uuid,\n  evidence_id uuid,',
      '  organization_id uuid,\n  evidence_id uuid,',
    ),
  },
  {
    id: 'T-35',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'the attestation columns are filled from the ARGUMENTS instead of from the row',
    breaks: 'The result declares four scope columns and every one of them agrees with the request by construction. This is strictly worse than returning nothing: a reader of the adapter now sees a comparison against fields that came off a row, and the tautology has been moved one layer down where the type system endorses it.',
    expectedGate: ['scope-attestation-not-echoed'],
    apply: sub(
      '         ch.organization_id, ch.project_id, ch.evidence_id, ch.document_version_id',
      '         p_organization_id, p_project_id, ch.evidence_id, ch.document_version_id',
    ),
  },
  {
    id: 'T-36',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'the project predicate is removed from the attested read',
    breaks: 'The function returns every chunk of the version inside the organization, and then attests the project each row actually carries. A caller comparing scopes would now see the mismatch — but a caller that does not compare gets cross-project passages, which is a wider read than the function it replaces.',
    expectedGate: ['scope-boundary-check'],
    apply: sub('    AND ch.project_id = p_project_id\n', ''),
  },
  {
    id: 'T-37',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'the canonical filter is removed from the attested read',
    breaks: 'Suppressed occurrences enter the retrieval result. They carry NO text by construction (the content-presence biconditional), so a citation resolving to one quotes nothing while looking like a valid anchor — and this filter is the only thing that stops a deduplicated duplicate being cited as if it were the passage.',
    expectedGate: ['scope-boundary-check'],
    apply: sub('    AND ch.canonical_chunk_id IS NULL\n', ''),
  },
  {
    id: 'T-38',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: "the attested reader stops consulting the caller's organizations",
    breaks: 'SECURITY DEFINER bypasses RLS, so this check IS the boundary. Without it any caller that can guess a document_version_id reads another tenant\'s passages, and the scope arguments become decoration the function itself supplies.',
    expectedGate: ['scope-boundary-check'],
    apply: sub(
      '  IF NOT (p_organization_id = ANY(public.current_user_org_ids())\n          OR public.current_user_is_super_admin()) THEN',
      '  IF false THEN',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* INT-CAP-002 / 003 / 004 — read surface and integrity                       */
/* -------------------------------------------------------------------------- */

export const INTEGRITY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-39',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-CAP-002',
    change: "the SELECT grant to authenticated is not revoked",
    breaks: 'PostgREST keeps a direct read on evidence_chunks, so a browser session reads the whole organization\'s chunk index around chunks_in_scope and around its canonical_chunk_id filter. The governed reader becomes optional, and the suppressed-duplicate guarantee holds only for callers who choose to go through it.',
    expectedGate: ['chunk-read-surface'],
    apply: sub('REVOKE SELECT ON public.evidence_chunks FROM authenticated;\n', ''),
  },
  {
    id: 'T-40',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-CAP-002',
    change: 'the replacement SELECT policy names authenticated again',
    breaks: 'Revoking the table grant while the policy still names the principal leaves a boundary that depends on nobody re-granting SELECT. A single ALTER DEFAULT PRIVILEGES, or one operator restoring a grant they believe is missing, re-opens the read with the policy already waving it through.',
    expectedGate: ['chunk-read-surface'],
    apply: sub(
      'ON public.evidence_chunks FOR SELECT\nTO uellix_app, uellix_auditor, uellix_cap_grounding',
      'ON public.evidence_chunks FOR SELECT\nTO authenticated, uellix_app, uellix_auditor, uellix_cap_grounding',
    ),
  },
  {
    id: 'T-41',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-CAP-003',
    change: 'content_hash is only shape-checked instead of being verified against content',
    breaks: "The package's own header promises a third party can re-normalise, slice, hash and recover content_hash. With a shape check the stored digest is whatever the caller sent, the server-derived chunk_id certifies it, and the adapter's re-derivation passes because it re-derives from the same unverified value.",
    expectedGate: ['content-hash-derivation'],
    apply: sub(
      `      CHECK (content IS NULL
             OR content_hash = encode(sha256(convert_to(content, 'UTF8')), 'hex'));`,
      `      CHECK (content IS NULL OR content_hash ~ '^[0-9a-f]{64}$');`,
    ),
  },
  {
    id: 'T-42',
    file: FORWARD.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-CAP-003',
    change: 'the span bound loses its lower half',
    breaks: 'A span of ten thousand characters can be declared for a passage of ten. char_start/char_end are what a reviewer uses to find the quoted text in the sealed file, so an unbounded span sends them to a region the citation never quoted while every hash still checks out.',
    expectedGate: ['span-length-bound'],
    apply: sub(
      '             OR ((char_end - char_start) >= length(content)',
      '             OR ((char_end - char_start) >= 0',
    ),
  },
  {
    id: 'T-43',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-CAP-004',
    change: "chunk_id's derivation constraint is weakened to a shape check",
    breaks: "The derivation goes back to living only in insert_evidence_chunks' body, and uellix_owner does not go through it: §5 of grounding_0003 revokes from seven principals and not from the owner, which keeps implicit INSERT and is not bound by RLS. A forged chunk_id becomes representable again, and one corrupt row kills an entire query through the adapter's per-query re-derivation.",
    expectedGate: ['chunk-id-derivation-check'],
    apply: sub(
      '      CHECK (chunk_id = encode(sha256(convert_to(',
      "      CHECK (chunk_id ~ '^[0-9a-f]{64}$' AND '' = md5(convert_to(",
    ),
  },
  {
    id: 'T-44',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'an EXCEPTION WHEN handler is added around the precondition guard',
    breaks: "A handler swallows the guard's RAISE and lets every statement after it run, with the whole suite green. The script then installs a quota path onto a database that has no ledger, no quota column or no RLS helpers, and reports success.",
    expectedGate: ['no-exception-handler'],
    apply: sub(
      `  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: missing role(s): %.', missing_roles;
  END IF;
END $$;`,
      `  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0013 aborted: missing role(s): %.', missing_roles;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'preconditions skipped';
END $$;`,
    ),
  },
  {
    id: 'T-57',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: 'the capability role is dropped from the chunk table\'s SELECT policy',
    breaks: 'uellix_cap_grounding holds SELECT and no BYPASSRLS and owns no table, so RLS applies to it in full and every SECURITY DEFINER read returns the empty set. chunks_in_scope and chunks_in_scope_attested both answer nothing, and the attestation columns attest about rows that never arrive. A missing GRANT raises; a missing POLICY is silent.',
    expectedGate: ['definer-read-policy'],
    apply: sub(
      'ON public.evidence_chunks FOR SELECT\nTO uellix_app, uellix_auditor, uellix_cap_grounding',
      'ON public.evidence_chunks FOR SELECT\nTO uellix_app, uellix_auditor',
    ),
  },
  {
    id: 'T-58',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-GR-004',
    change: "the capability role is dropped from the version table's SELECT policy",
    breaks: 'The other half of the same finding, and the more damaging one: register_document_version can no longer see the previous version, so `ordinal` is always 1 and `supersedes_version_id` always NULL — which makes version 2 of any document unstorable against UNIQUE (evidence_id, ordinal), and claim_active_document_version answers U0102 for every document that exists.',
    expectedGate: ['definer-read-policy'],
    apply: sub(
      'ON public.evidence_document_versions FOR SELECT\nTO authenticated, uellix_app, uellix_auditor, uellix_cap_grounding',
      'ON public.evidence_document_versions FOR SELECT\nTO authenticated, uellix_app, uellix_auditor',
    ),
  },
  {
    id: 'T-59',
    file: FORWARD.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-CAP-002',
    change: 'the re-created SELECT policies name the role but drop the organization bound',
    breaks: 'A read repair becomes a tenancy hole. The definer would then read every chunk and every version in the database, and each function\'s own explicit organization check would be the single remaining boundary — which is exactly the "one statement of the boundary" posture both packages were written to avoid.',
    expectedGate: ['definer-read-policy'],
    apply: (sql) =>
      sql.replace(
        /USING \(\n  organization_id = ANY\(public\.current_user_org_ids\(\)\)\n  OR public\.current_user_is_super_admin\(\)\n\);/g,
        () => 'USING (true);',
      ),
  },
  {
    id: 'T-60',
    file: ROLLBACK.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-GR-004',
    change: "the version table's SELECT policy is not restored by the rollback",
    breaks: "The database keeps a policy grounding_0002 never wrote, on a table this package does not own. A later rollback of grounding_0002 would then drop a policy set it cannot recognise, and the apply/rollback comparison reports convergence over two different end states.",
    expectedGate: ['rollback-convergence'],
    apply: sub(
      `    EXECUTE 'CREATE POLICY "evidence_document_versions_select" ON public.evidence_document_versions FOR SELECT TO authenticated, uellix_app, uellix_auditor USING (organization_id = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin())';\n`,
      '',
    ),
  },
  {
    id: 'T-45',
    file: FORWARD.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-CAP-002',
    change: 'privilege self-verification stops using aclexplode',
    breaks: 'information_schema reports privileges a role merely INHERITS through membership and short-circuits for superusers, so a table that still grants SELECT to authenticated verifies clean. That is exactly what made the old write-path guard in stella_0003 vacuous.',
    expectedGate: ['self-verification'],
    apply: (sql) => sql.split('aclexplode').join('information_schema_privileges'),
  },
  {
    id: 'T-46',
    file: FORWARD.QUOTA,
    severity: 'MAJOR',
    contract: 'INT-CAP-001',
    change: 'the zero-members postcondition is removed from self-verification',
    breaks: 'Nothing re-checks, at the end of the transaction, that the capability role is still unreachable by SET ROLE — and a membership granted between this package and another would pass every other assertion in the file.',
    expectedGate: ['self-verification'],
    apply: (sql) => sql.split('pg_auth_members').join('pg_class'),
  },
]

/* -------------------------------------------------------------------------- */
/* Rollbacks                                                                  */
/* -------------------------------------------------------------------------- */

export const ROLLBACK_MUTATIONS: readonly Mutation[] = [
  {
    id: 'T-47',
    file: ROLLBACK.ATTEST,
    severity: 'CRITICAL',
    contract: 'INT-CAP-004',
    change: 'the DROP FUNCTION is nested inside the table-existence guard',
    breaks: 'This is INT-CAP-004 (1) reintroduced verbatim: a database whose evidence_chunks went by another route gets a rollback that reports success and leaves a callable SECURITY DEFINER function behind, which then blocks the next package\'s rollback permanently.',
    expectedGate: ['rollback-function-drop-unconditional'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)';",
      "  IF tbl_oid IS NOT NULL THEN\n    EXECUTE 'DROP FUNCTION IF EXISTS uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)';\n  END IF;",
    ),
  },
  {
    id: 'T-48',
    file: ROLLBACK.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the six-value stella_role CHECK is never restored',
    breaks: 'The rollback drops the column, the index and the function but leaves the ledger admitting a capability that no longer has a consumption path. The database then matches neither the state before the package nor the state after it, and the next apply reconciles a constraint it believes it created.',
    expectedGate: ['rollback-convergence'],
    apply: sub(
      "    EXECUTE 'ALTER TABLE public.stella_interactions ADD CONSTRAINT stella_interactions_stella_role_check CHECK (stella_role IN (''advisor'', ''validator'', ''composer'', ''proxy_reviewer'', ''evidence_reviewer'', ''audit_assistant''))';\n",
      '',
    ),
  },
  {
    id: 'T-49',
    file: ROLLBACK.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'one of the grants the package made is never revoked before DROP ROLE',
    breaks: 'DROP ROLE is blocked by PRIVILEGES HELD as well as by ownership: a surviving grant on a baseline table makes PostgreSQL refuse with "some objects depend on it", the transaction aborts, and the rollback leaves the schema dropped and the role standing. This is the defect the grounding train found only by RUNNING its rollback, and no static reading of the forward script could have shown it.',
    expectedGate: ['rollback-convergence'],
    apply: sub(
      "    EXECUTE 'REVOKE SELECT ON public.organizations FROM uellix_cap_stella_quota';\n",
      '',
    ),
  },
  {
    id: 'T-50',
    file: ROLLBACK.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-CAP-002',
    change: "grounding_0003's read surface is not restored",
    breaks: 'Rolling back this package leaves the narrowed grant in place, so the database is at neither end state. A later apply/rollback comparison reads as convergent while the two runs measured different things, which is how a convergence claim becomes decorative.',
    expectedGate: ['rollback-convergence'],
    apply: sub("    EXECUTE 'GRANT SELECT ON public.evidence_chunks TO authenticated';\n", ''),
  },
  {
    id: 'T-51',
    file: ROLLBACK.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-CAP-002',
    change: 'the warning about re-opening INT-CAP-002 is removed',
    breaks: 'The rollback re-grants PostgREST a direct read over the chunk index and says nothing. An operator rolling back a scope-attestation package has no reason to expect it also re-opens a tenancy read path, and silence is what turns a known trade-off into an unknown one.',
    expectedGate: ['rollback-convergence'],
    apply: sub('    RAISE WARNING ', '    RAISE NOTICE '),
  },
  {
    id: 'T-52',
    file: ROLLBACK.ATTEST,
    severity: 'MAJOR',
    contract: 'INT-GR-004',
    change: "the assertion that grounding_0003's reader survived is removed",
    breaks: 'A DROP naming the wrong signature would take chunks_in_scope with it, and this assertion is the last moment at which the transaction could still roll back. Without it the grounding read path disappears and the failure surfaces later as "provider unavailable".',
    expectedGate: ['rollback-convergence'],
    apply: sub(
      "  IF tbl_oid IS NOT NULL\n     AND to_regprocedure('uellix_grounding.chunks_in_scope(uuid, uuid, uuid)') IS NULL THEN",
      '  IF false THEN',
    ),
  },
  {
    id: 'T-53',
    file: ROLLBACK.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the refusal over a charged ledger is downgraded to a notice',
    breaks: 'Narrowing the vocabulary over stored grounded_query rows is impossible — the table is append-only for every role including the owner, so the rows cannot be removed to make room. Without the refusal the operator gets a raw constraint violation from a statement three sections later and no statement of why.',
    expectedGate: ['rollback-refuses-charged-ledger'],
    apply: sub("        'stella_0013 rollback refused:", "        'stella_0013 rollback proceeding:"),
  },
  {
    id: 'T-54',
    file: ROLLBACK.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the schema is dropped with CASCADE',
    breaks: 'CASCADE silently removes every dependent object this rollback never named — including, for a future package, whatever came to live in the capability schema alongside the consumption path.',
    expectedGate: ['rollback-no-cascade'],
    apply: sub("EXECUTE 'DROP SCHEMA uellix_stella'", "EXECUTE 'DROP SCHEMA uellix_stella CASCADE'"),
  },
  {
    id: 'T-55',
    file: ROLLBACK.QUOTA,
    severity: 'CRITICAL',
    contract: 'INT-CAP-001',
    change: 'the destructive statement is moved out of the DO block to the top level',
    breaks: "The guard and the destruction become two statements. Without -v ON_ERROR_STOP=1 psql reports the guard's error and SENDS THE NEXT STATEMENT — and those flags are a convention of invocation, not a property of the file. The Supabase SQL editor supplies neither.",
    expectedGate: ['rollback-single-block'],
    apply: sub(
      'DO $$\nDECLARE\n  tbl_oid     oid;',
      'DROP FUNCTION IF EXISTS uellix_stella.consume_stella_quota(uuid, uuid, character varying, character);\n\nDO $$\nDECLARE\n  tbl_oid     oid;',
    ),
  },
]

export const MUTATIONS: readonly Mutation[] = [
  ...VOCABULARY_MUTATIONS,
  ...CONSUMPTION_MUTATIONS,
  ...IDEMPOTENCY_MUTATIONS,
  ...PRIVILEGE_MUTATIONS,
  ...DEFINER_MUTATIONS,
  ...ATTESTATION_MUTATIONS,
  ...INTEGRITY_MUTATIONS,
  ...ROLLBACK_MUTATIONS,
]
