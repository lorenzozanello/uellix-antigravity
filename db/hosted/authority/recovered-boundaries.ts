// db/hosted/authority/recovered-boundaries.ts
// COMMIT 3 — the 51 classification-window boundaries, as recovered.
//
// ---------------------------------------------------------------------------
// PROVENANCE
// ---------------------------------------------------------------------------
// These boundaries come from the original A_FINAL stateful partition
// (`rerun-canon.mjs` + `afinal-canon.mjs`), transferred verbatim by the
// operator. They were NOT inferred here, and an earlier attempt to re-derive
// them from the published counts was abandoned on purpose: 26 OWNER windows is
// consistent with many boundary rules, so the count can CHECK a rule but cannot
// IDENTIFY one. Fitting heuristics until a checksum matched would have been the
// generator/verifier collusion this whole design exists to prevent.
//
// What IS re-measured here, and must keep matching, is arithmetic the recovered
// table cannot fake:
//
//   the 26 OWNER window sizes sum to 167
//   the 15 CAPABILITY window sizes sum to  99
//   the 10 TRANSFER window sizes sum to    27
//   167 + 99 + 27 + 8 installer + 3 managed + 16 bookkeeping = 320 hosted
//
// ---------------------------------------------------------------------------
// HOW A BOUNDARY IS EXPRESSED
// ---------------------------------------------------------------------------
// The historical table names its boundaries in prose and by line. Neither is
// used. Each boundary below is a STRUCTURAL predicate — statement class plus
// object identity plus, where it disambiguates, the operands — and it must
// resolve to exactly one statement or the plan refuses. The prose is kept in
// `describedAs` so a reviewer can check the transfer by reading, which is the
// one thing a digest cannot help with.
//
// Two boundary kinds cannot be named by object alone:
//
//   DO blocks      have no object identity at all — they are matched on
//                  distinctive executable content, and the PIN that results is
//                  the digest, which is their identity by design.
//   ALTER TABLE    can occur several times on one table, so the discriminator
//                  is the action text.
//
// In both cases the text predicate is used only to LOCATE the statement; what
// gets pinned into the manifest is the structural identity and the digest.

import type { StatementClass } from './structural-identity'

/** How a boundary statement is found. Exactly one match, or the plan refuses. */
export interface BoundaryPredicate {
  readonly statementClass: StatementClass
  /** `formatObjectIdentity` output, when the statement names an object. */
  readonly object?: string
  /** Operand fragments that must all appear in the identity's operands. */
  readonly operands?: readonly string[]
  /** Distinctive fragments of the normalized executable text. DO / ALTER only. */
  readonly contains?: readonly string[]
}

export interface RecoveredWindow {
  readonly windowId: string
  readonly packageId: string
  readonly authorityClass: 'OWNER' | 'CAPABILITY' | 'OWNER_TRANSFER'
  /** The historical statement count. Compared against the structural one. */
  readonly historicalCount: number
  /** Prose from the recovered table, for human review of the transfer. */
  readonly describedAs: string
  readonly start: BoundaryPredicate
  readonly end: BoundaryPredicate
}

const OPS = 'uellix_stella_ops'
const STELLA = 'uellix_stella'
const GROUNDING = 'uellix_grounding'
const CAP_GROUNDING = 'uellix_cap_grounding'
const CAP_QUOTA = 'uellix_cap_stella_quota'
const CAP_TICKET = 'uellix_cap_stella_ticket'

/**
 * Routine signatures, spelled once so a typo cannot differ between two windows.
 *
 * EXPORTED as `CHAIN_ROUTINE_SIGNATURES` (below) for the same reason it is a
 * constant at all: `forward-boundaries.ts` anchors an AUTHORED window on
 * `claim_active_document_version`, and a second spelling of that signature in a
 * second file is a typo waiting for a package to be misclassified. Exporting it
 * extends the property across the file boundary rather than duplicating it.
 */
const FN = {
  register: `function:${GROUNDING}.register_document_version(uuid,bpchar,bpchar,bpchar,varchar,varchar,varchar,varchar)`,
  claim: `function:${GROUNDING}.claim_active_document_version(uuid)`,
  insertChunks: `function:${GROUNDING}.insert_evidence_chunks(uuid,jsonb)`,
  chunksInScope: `function:${GROUNDING}.chunks_in_scope(uuid,uuid,uuid)`,
  chunksAttested: `function:${GROUNDING}.chunks_in_scope_attested(uuid,uuid,uuid)`,
  consumeQuota: `function:${STELLA}.consume_stella_quota(uuid,uuid,varchar,bpchar)`,
  capacity: `function:${STELLA}.stella_capacity(uuid,bpchar)`,
  settle5: `function:${STELLA}.settle_reserved_quota(uuid,uuid,varchar,bpchar,bpchar)`,
  settle10: `function:${STELLA}.settle_reserved_quota(uuid,uuid,varchar,bpchar,bpchar,varchar,bpchar,varchar,int4,jsonb)`,
  issue: `function:${OPS}.issue_operation_ticket(uuid,uuid,varchar)`,
  expire: `function:${OPS}.expire_operation_tickets(int4)`,
  bind3: `function:${OPS}.bind_operation_ticket(bpchar,uuid,bpchar)`,
  bind4: `function:${OPS}.bind_operation_ticket(bpchar,uuid,bpchar,varchar)`,
  complete3: `function:${OPS}.complete_operation_ticket(bpchar,uuid,bpchar)`,
  complete7: `function:${OPS}.complete_operation_ticket(bpchar,uuid,bpchar,varchar,varchar,int4,jsonb)`,
  inspect2: `function:${OPS}.inspect_operation_ticket(bpchar,uuid)`,
  // M-2 / T11. The only entry here that names an object in `public` and the
  // only one the recovered partition never saw: unit 41 published it long
  // before this table was taken. It lives in FN anyway, for the reason the
  // docstring above gives — `forward-boundaries.ts` anchors an AUTHORED window
  // on it, and a second spelling in a second file is a typo waiting for a
  // package to be misclassified. Being in FN does not make it recovered; no
  // RECOVERED_WINDOWS entry references it, and RECOVERED_TOTALS is unmoved.
  canWriteEvidenceObject: 'function:public.can_write_evidence_object(text,uuid)',
} as const

/** The routine signatures above, for authored windows in sibling modules. */
export const CHAIN_ROUTINE_SIGNATURES = FN

export const createFn = (object: string): BoundaryPredicate => ({ statementClass: 'create-function', object })
const transferTo = (object: string, target: string): BoundaryPredicate => ({
  statementClass: 'owner-transfer',
  object,
  operands: [target],
})
const revokeFromPublic = (object: string): BoundaryPredicate => ({
  statementClass: 'revoke-privilege',
  object,
  operands: ['PUBLIC'],
})
export const commentOn = (object: string): BoundaryPredicate => ({ statementClass: 'comment', object })

export const RECOVERED_WINDOWS: readonly RecoveredWindow[] = [
  /* ---------------------------------------------------------------- T1 --- */
  {
    windowId: 'W01',
    packageId: 'T1',
    authorityClass: 'OWNER',
    historicalCount: 6,
    describedAs: 'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC … GRANT SELECT ON public.evidence_items TO uellix_cap_grounding',
    start: { statementClass: 'revoke-privilege', object: `schema:${GROUNDING}`, operands: ['PUBLIC'] },
    end: { statementClass: 'grant-privilege', object: 'table:public.evidence_items', operands: [CAP_GROUNDING] },
  },
  {
    windowId: 'W02',
    packageId: 'T1',
    authorityClass: 'OWNER',
    historicalCount: 33,
    describedAs: 'DO block inspecting pg_get_constraintdef on evidence_document_versions … COMMENT ON TABLE public.evidence_document_versions',
    start: { statementClass: 'do-block', contains: ['pg_get_constraintdef', 'evidence_document_versions'] },
    end: commentOn('table:public.evidence_document_versions'),
  },
  {
    windowId: 'W03',
    packageId: 'T1',
    authorityClass: 'OWNER',
    historicalCount: 2,
    describedAs: 'CREATE FUNCTION register_document_version … claim_active_document_version',
    start: createFn(FN.register),
    end: createFn(FN.claim),
  },
  {
    windowId: 'W04',
    packageId: 'T1',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 2,
    describedAs: 'ALTER FUNCTION register_document_version … claim_active_document_version OWNER TO uellix_cap_grounding',
    start: transferTo(FN.register, CAP_GROUNDING),
    end: transferTo(FN.claim, CAP_GROUNDING),
  },
  {
    windowId: 'W05',
    packageId: 'T1',
    authorityClass: 'CAPABILITY',
    historicalCount: 6,
    describedAs: 'REVOKE ALL ON FUNCTION register_document_version FROM PUBLIC … COMMENT ON FUNCTION claim_active_document_version',
    start: revokeFromPublic(FN.register),
    end: commentOn(FN.claim),
  },

  /* ---------------------------------------------------------------- T2 --- */
  {
    windowId: 'W06',
    packageId: 'T2',
    authorityClass: 'OWNER',
    historicalCount: 35,
    describedAs: 'DO constraint/ALTER/DROP block for evidence_chunks … COMMENT ON TABLE public.evidence_chunks',
    start: { statementClass: 'do-block', contains: ['pg_get_constraintdef', 'evidence_chunks'] },
    end: commentOn('table:public.evidence_chunks'),
  },
  {
    windowId: 'W07',
    packageId: 'T2',
    authorityClass: 'OWNER',
    historicalCount: 3,
    describedAs: 'CREATE FUNCTION insert_evidence_chunks … chunks_in_scope',
    start: createFn(FN.insertChunks),
    end: createFn(FN.chunksInScope),
  },
  {
    windowId: 'W08',
    packageId: 'T2',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 3,
    describedAs: 'ALTER FUNCTION insert_evidence_chunks … chunks_in_scope OWNER TO uellix_cap_grounding',
    start: transferTo(FN.insertChunks, CAP_GROUNDING),
    end: transferTo(FN.chunksInScope, CAP_GROUNDING),
  },
  {
    windowId: 'W09',
    packageId: 'T2',
    authorityClass: 'CAPABILITY',
    historicalCount: 9,
    describedAs: 'REVOKE ALL ON FUNCTION insert_evidence_chunks FROM PUBLIC … COMMENT ON FUNCTION chunks_in_scope',
    start: revokeFromPublic(FN.insertChunks),
    end: commentOn(FN.chunksInScope),
  },

  /* ---------------------------------------------------------------- T3 --- */
  {
    windowId: 'W10',
    packageId: 'T3',
    authorityClass: 'OWNER',
    historicalCount: 8,
    describedAs: 'DO constraint/ALTER/DROP block for evidence_chunks … COMMENT ON POLICY evidence_chunks_select',
    // `evidence_chunks` alone matched three DO blocks in T3 and the plan
    // refused, which is the anchor-cardinality rule doing its job. The
    // constraint-definition read is what makes this the constraint block.
    start: { statementClass: 'do-block', contains: ['pg_get_constraintdef'] },
    end: commentOn('policy:public.evidence_chunks_select@public.evidence_chunks'),
  },
  {
    windowId: 'W11',
    packageId: 'T3',
    authorityClass: 'OWNER',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION chunks_in_scope_attested',
    start: createFn(FN.chunksAttested),
    end: createFn(FN.chunksAttested),
  },
  {
    windowId: 'W12',
    packageId: 'T3',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 1,
    describedAs: 'ALTER FUNCTION chunks_in_scope_attested OWNER TO uellix_cap_grounding',
    start: transferTo(FN.chunksAttested, CAP_GROUNDING),
    end: transferTo(FN.chunksAttested, CAP_GROUNDING),
  },
  {
    windowId: 'W13',
    packageId: 'T3',
    authorityClass: 'CAPABILITY',
    historicalCount: 4,
    describedAs: 'REVOKE ALL ON FUNCTION chunks_in_scope_attested FROM PUBLIC … COMMENT ON FUNCTION chunks_in_scope',
    start: revokeFromPublic(FN.chunksAttested),
    end: commentOn(FN.chunksInScope),
  },

  /* ---------------------------------------------------------------- T4 --- */
  {
    windowId: 'W14',
    packageId: 'T4',
    authorityClass: 'OWNER',
    historicalCount: 5,
    describedAs: 'REVOKE ALL ON SCHEMA uellix_stella FROM PUBLIC … GRANT EXECUTE ON public.current_user_is_super_admin() TO uellix_cap_stella_quota',
    start: { statementClass: 'revoke-privilege', object: `schema:${STELLA}`, operands: ['PUBLIC'] },
    end: {
      statementClass: 'grant-privilege',
      object: 'function:public.current_user_is_super_admin()',
      operands: [CAP_QUOTA],
    },
  },
  {
    windowId: 'W15',
    packageId: 'T4',
    authorityClass: 'OWNER',
    historicalCount: 4,
    describedAs: 'GRANT SELECT ON public.organizations TO uellix_cap_stella_quota … REVOKE UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_quota',
    start: { statementClass: 'grant-privilege', object: 'table:public.organizations', operands: [CAP_QUOTA] },
    end: { statementClass: 'revoke-privilege', object: 'table:public.stella_interactions', operands: [CAP_QUOTA] },
  },
  {
    windowId: 'W16',
    packageId: 'T4',
    authorityClass: 'OWNER',
    historicalCount: 5,
    describedAs: 'ALTER TABLE public.stella_interactions ADD COLUMN idempotency_key … CREATE POLICY stella_interactions_quota_definer_insert',
    start: { statementClass: 'alter-table', object: 'table:public.stella_interactions', contains: ['idempotency_key'] },
    end: {
      statementClass: 'create-policy',
      object: 'policy:public.stella_interactions_quota_definer_insert@public.stella_interactions',
    },
  },
  {
    windowId: 'W17',
    packageId: 'T4',
    authorityClass: 'OWNER',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION consume_stella_quota',
    start: createFn(FN.consumeQuota),
    end: createFn(FN.consumeQuota),
  },
  {
    windowId: 'W18',
    packageId: 'T4',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 1,
    describedAs: 'ALTER FUNCTION consume_stella_quota OWNER TO uellix_cap_stella_quota',
    start: transferTo(FN.consumeQuota, CAP_QUOTA),
    end: transferTo(FN.consumeQuota, CAP_QUOTA),
  },
  {
    windowId: 'W19',
    packageId: 'T4',
    authorityClass: 'CAPABILITY',
    historicalCount: 3,
    describedAs: 'REVOKE ALL ON FUNCTION consume_stella_quota FROM PUBLIC … COMMENT ON FUNCTION consume_stella_quota',
    start: revokeFromPublic(FN.consumeQuota),
    end: commentOn(FN.consumeQuota),
  },

  /* ---------------------------------------------------------------- T5 --- */
  {
    windowId: 'W20',
    packageId: 'T5',
    authorityClass: 'OWNER',
    historicalCount: 6,
    describedAs: 'REVOKE ALL ON SCHEMA uellix_stella_ops FROM PUBLIC … GRANT EXECUTE ON public.current_user_is_super_admin() TO uellix_cap_stella_ticket',
    start: { statementClass: 'revoke-privilege', object: `schema:${OPS}`, operands: ['PUBLIC'] },
    end: {
      statementClass: 'grant-privilege',
      object: 'function:public.current_user_is_super_admin()',
      operands: [CAP_TICKET],
    },
  },
  {
    windowId: 'W21',
    packageId: 'T5',
    authorityClass: 'OWNER',
    historicalCount: 4,
    describedAs: 'GRANT SELECT ON public.projects TO uellix_cap_stella_ticket … REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_ticket',
    start: { statementClass: 'grant-privilege', object: 'table:public.projects', operands: [CAP_TICKET] },
    end: { statementClass: 'revoke-privilege', object: 'table:public.stella_interactions', operands: [CAP_TICKET] },
  },
  {
    windowId: 'W22',
    packageId: 'T5',
    authorityClass: 'CAPABILITY',
    historicalCount: 1,
    describedAs: 'GRANT EXECUTE ON FUNCTION consume_stella_quota TO uellix_cap_stella_ticket — cross-package capability authority',
    start: { statementClass: 'grant-privilege', object: FN.consumeQuota, operands: [CAP_TICKET] },
    end: { statementClass: 'grant-privilege', object: FN.consumeQuota, operands: [CAP_TICKET] },
  },
  {
    windowId: 'W23',
    packageId: 'T5',
    authorityClass: 'OWNER',
    historicalCount: 21,
    describedAs: 'COMMENT ON TABLE operation_tickets … CREATE POLICY operation_tickets_definer_update',
    start: commentOn(`table:${OPS}.operation_tickets`),
    end: {
      statementClass: 'create-policy',
      object: `policy:${OPS}.operation_tickets_definer_update@${OPS}.operation_tickets`,
    },
  },
  {
    windowId: 'W24',
    packageId: 'T5',
    authorityClass: 'OWNER',
    historicalCount: 6,
    describedAs: 'CREATE FUNCTION issue_operation_ticket … expire_operation_tickets',
    start: createFn(FN.issue),
    end: createFn(FN.expire),
  },
  {
    windowId: 'W25',
    packageId: 'T5',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 6,
    describedAs: 'ALTER FUNCTION issue_operation_ticket … expire_operation_tickets OWNER TO uellix_cap_stella_ticket',
    start: transferTo(FN.issue, CAP_TICKET),
    end: transferTo(FN.expire, CAP_TICKET),
  },
  {
    windowId: 'W26',
    packageId: 'T5',
    authorityClass: 'CAPABILITY',
    historicalCount: 12,
    describedAs: 'REVOKE ALL ON FUNCTION issue_operation_ticket FROM PUBLIC … GRANT EXECUTE ON expire_operation_tickets TO uellix_app',
    start: revokeFromPublic(FN.issue),
    end: { statementClass: 'grant-privilege', object: FN.expire, operands: ['uellix_app'] },
  },
  {
    windowId: 'W27',
    packageId: 'T5',
    authorityClass: 'OWNER',
    historicalCount: 3,
    describedAs: 'REVOKE ALL ON operation_tickets FROM PUBLIC … REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER FROM uellix_cap_stella_ticket',
    start: { statementClass: 'revoke-privilege', object: `table:${OPS}.operation_tickets`, operands: ['PUBLIC'] },
    end: { statementClass: 'revoke-privilege', object: `table:${OPS}.operation_tickets`, operands: [CAP_TICKET] },
  },
  {
    windowId: 'W28',
    packageId: 'T5',
    authorityClass: 'CAPABILITY',
    historicalCount: 6,
    describedAs: 'COMMENT ON FUNCTION issue_operation_ticket … expire_operation_tickets',
    start: commentOn(FN.issue),
    end: commentOn(FN.expire),
  },

  /* ---------------------------------------------------------------- T6 --- */
  {
    windowId: 'W29',
    packageId: 'T6',
    authorityClass: 'CAPABILITY',
    historicalCount: 1,
    describedAs: 'DO block checking to_regprocedure and dynamically REVOKEing on existing ticket functions',
    // The two-argument legacy signature appears only in the block that revokes
    // it; the self-verification block at the end of T6 names the project-bound
    // three-argument form instead. `to_regprocedure` alone matched both and the
    // plan refused, which is the point of the cardinality rule.
    start: { statementClass: 'do-block', contains: ["EXECUTE 'REVOKE ALL ON FUNCTION"] },
    end: { statementClass: 'do-block', contains: ["EXECUTE 'REVOKE ALL ON FUNCTION"] },
  },
  {
    windowId: 'W30',
    packageId: 'T6',
    authorityClass: 'OWNER',
    historicalCount: 4,
    describedAs: 'CREATE FUNCTION bind_operation_ticket(3) … inspect_operation_ticket(2)',
    start: createFn(FN.bind3),
    end: createFn(FN.inspect2),
  },
  {
    windowId: 'W31',
    packageId: 'T6',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 4,
    describedAs: 'ALTER FUNCTION bind_operation_ticket(3) … inspect_operation_ticket(2) OWNER TO uellix_cap_stella_ticket',
    start: transferTo(FN.bind3, CAP_TICKET),
    end: transferTo(FN.inspect2, CAP_TICKET),
  },
  {
    windowId: 'W32',
    packageId: 'T6',
    authorityClass: 'CAPABILITY',
    historicalCount: 16,
    describedAs: 'REVOKE ALL ON FUNCTION bind_operation_ticket(3) FROM PUBLIC … COMMENT ON FUNCTION inspect_operation_ticket(2)',
    start: revokeFromPublic(FN.bind3),
    end: commentOn(FN.inspect2),
  },

  /* ---------------------------------------------------------------- T7 --- */
  {
    windowId: 'W33',
    packageId: 'T7',
    authorityClass: 'OWNER',
    historicalCount: 2,
    describedAs: 'ALTER TABLE operation_tickets ADD COLUMN period_month GENERATED … COMMENT ON COLUMN period_month',
    start: { statementClass: 'alter-table', object: `table:${OPS}.operation_tickets`, contains: ['period_month'] },
    end: commentOn(`column:${OPS}.period_month@${OPS}.operation_tickets`),
  },
  {
    windowId: 'W34',
    packageId: 'T7',
    authorityClass: 'OWNER',
    historicalCount: 3,
    describedAs: 'REVOKE ALL ON operation_tickets FROM uellix_cap_stella_quota … GRANT USAGE ON SCHEMA uellix_stella_ops TO uellix_cap_stella_quota',
    start: { statementClass: 'revoke-privilege', object: `table:${OPS}.operation_tickets`, operands: [CAP_QUOTA] },
    end: { statementClass: 'grant-privilege', object: `schema:${OPS}`, operands: [CAP_QUOTA] },
  },
  {
    windowId: 'W35',
    packageId: 'T7',
    authorityClass: 'OWNER',
    historicalCount: 2,
    describedAs: 'DROP POLICY operation_tickets_capacity_select … CREATE POLICY operation_tickets_capacity_select',
    start: {
      statementClass: 'drop-object',
      object: `policy:${OPS}.operation_tickets_capacity_select@${OPS}.operation_tickets`,
    },
    end: {
      statementClass: 'create-policy',
      object: `policy:${OPS}.operation_tickets_capacity_select@${OPS}.operation_tickets`,
    },
  },
  {
    windowId: 'W36',
    packageId: 'T7',
    authorityClass: 'OWNER',
    historicalCount: 3,
    describedAs: 'CREATE FUNCTION stella_capacity … settle_reserved_quota(5)',
    start: createFn(FN.capacity),
    end: createFn(FN.settle5),
  },
  {
    windowId: 'W37',
    packageId: 'T7',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 3,
    describedAs: 'ALTER FUNCTION stella_capacity … settle_reserved_quota(5) OWNER TO uellix_cap_stella_quota',
    start: transferTo(FN.capacity, CAP_QUOTA),
    end: transferTo(FN.settle5, CAP_QUOTA),
  },
  {
    windowId: 'W38',
    packageId: 'T7',
    authorityClass: 'CAPABILITY',
    historicalCount: 12,
    describedAs: 'MULTI-ROLE. REVOKE ALL ON FUNCTION stella_capacity FROM PUBLIC … CREATE FUNCTION complete_operation_ticket(3)',
    start: revokeFromPublic(FN.capacity),
    end: createFn(FN.complete3),
  },
  {
    windowId: 'W39',
    packageId: 'T7',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 2,
    describedAs: 'ALTER FUNCTION bind_operation_ticket(3) … complete_operation_ticket(3) OWNER TO uellix_cap_stella_ticket',
    start: transferTo(FN.bind3, CAP_TICKET),
    end: transferTo(FN.complete3, CAP_TICKET),
  },
  {
    windowId: 'W40',
    packageId: 'T7',
    authorityClass: 'CAPABILITY',
    historicalCount: 6,
    describedAs: 'REVOKE ALL ON FUNCTION bind_operation_ticket(3) FROM PUBLIC … COMMENT ON FUNCTION complete_operation_ticket(3)',
    start: revokeFromPublic(FN.bind3),
    end: commentOn(FN.complete3),
  },

  /* ---------------------------------------------------------------- T8 --- */
  {
    windowId: 'W41',
    packageId: 'T8',
    authorityClass: 'OWNER',
    historicalCount: 5,
    describedAs: 'DO block checking pg_roles and REVOKEing on public.stella_interactions … REVOKE INSERT, UPDATE, DELETE, TRUNCATE FROM uellix_cap_stella_ticket',
    // `pg_roles` alone matched three DO blocks in T8. The writer role is named
    // only by the block that revokes the direct write path.
    start: { statementClass: 'do-block', contains: ["rolname = 'uellix_writer'"] },
    end: { statementClass: 'revoke-privilege', object: 'table:public.stella_interactions', operands: [CAP_TICKET] },
  },
  {
    windowId: 'W42',
    packageId: 'T8',
    authorityClass: 'OWNER',
    historicalCount: 2,
    describedAs: 'DO constraint ALTER/DROP block for governed identity … COMMENT ON CONSTRAINT stella_interactions_governed_identity_check',
    start: { statementClass: 'do-block', contains: ['current_def text'] },
    end: commentOn(
      'constraint:public.stella_interactions_governed_identity_check@public.stella_interactions',
    ),
  },
  {
    windowId: 'W43',
    packageId: 'T8',
    authorityClass: 'OWNER',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION settle_reserved_quota(10)',
    start: createFn(FN.settle10),
    end: createFn(FN.settle10),
  },
  {
    windowId: 'W44',
    packageId: 'T8',
    authorityClass: 'CAPABILITY',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION settle_reserved_quota(5) — already owned by uellix_cap_stella_quota; needs temporary schema CREATE',
    start: createFn(FN.settle5),
    end: createFn(FN.settle5),
  },
  {
    windowId: 'W45',
    packageId: 'T8',
    authorityClass: 'OWNER',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION complete_operation_ticket(7)',
    start: createFn(FN.complete7),
    end: createFn(FN.complete7),
  },
  {
    windowId: 'W46',
    packageId: 'T8',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 3,
    describedAs: 'MULTI-TARGET. ALTER FUNCTION settle_reserved_quota(10) OWNER TO uellix_cap_stella_quota … complete_operation_ticket(7) OWNER TO uellix_cap_stella_ticket',
    start: transferTo(FN.settle10, CAP_QUOTA),
    end: transferTo(FN.complete7, CAP_TICKET),
  },
  {
    windowId: 'W47',
    packageId: 'T8',
    authorityClass: 'CAPABILITY',
    historicalCount: 9,
    describedAs: 'MULTI-ROLE. REVOKE ALL ON FUNCTION settle_reserved_quota(10) FROM PUBLIC … COMMENT ON FUNCTION complete_operation_ticket(7)',
    start: revokeFromPublic(FN.settle10),
    end: commentOn(FN.complete7),
  },

  /* ---------------------------------------------------------------- T9 --- */
  {
    windowId: 'W48',
    packageId: 'T9',
    authorityClass: 'OWNER',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION bind_operation_ticket(4)',
    start: createFn(FN.bind4),
    end: createFn(FN.bind4),
  },
  {
    windowId: 'W49',
    packageId: 'T9',
    authorityClass: 'CAPABILITY',
    historicalCount: 1,
    describedAs: 'CREATE FUNCTION bind_operation_ticket(3) — already owned by uellix_cap_stella_ticket; needs temporary schema CREATE',
    start: createFn(FN.bind3),
    end: createFn(FN.bind3),
  },
  {
    windowId: 'W50',
    packageId: 'T9',
    authorityClass: 'OWNER_TRANSFER',
    historicalCount: 2,
    describedAs: 'ALTER FUNCTION bind_operation_ticket(4) … bind_operation_ticket(3) OWNER TO uellix_cap_stella_ticket',
    start: transferTo(FN.bind4, CAP_TICKET),
    end: transferTo(FN.bind3, CAP_TICKET),
  },
  {
    windowId: 'W51',
    packageId: 'T9',
    authorityClass: 'CAPABILITY',
    historicalCount: 12,
    describedAs: 'MULTI-ROLE. REVOKE ALL ON FUNCTION bind_operation_ticket(4) FROM PUBLIC … COMMENT ON FUNCTION consume_stella_quota',
    start: revokeFromPublic(FN.bind4),
    end: commentOn(FN.consumeQuota),
  },
]

/** The declared totals. Re-derived from the table and asserted by a test. */
export const RECOVERED_TOTALS = {
  owner: 26,
  capability: 15,
  transfer: 10,
  ownerStatements: 167,
  capabilityStatements: 99,
  transferStatements: 27,
  installerStatements: 8,
  managedRewriteStatements: 3,
  bookkeepingStatements: 16,
  hostedStatements: 320,
} as const
