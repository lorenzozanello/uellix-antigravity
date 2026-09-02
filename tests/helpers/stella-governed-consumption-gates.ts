// tests/helpers/stella-governed-consumption-gates.ts
//
// The static contract for the governed-consumption package (stella_0017,
// R6-INT and the residual of R1) as a PURE FUNCTION over file contents.
//
// It is a pure function for the same reason tests/helpers/stella-reserved-quota-
// gates.ts is: tests/stella-governed-consumption-mutation.test.ts has to run
// exactly this code over deliberately broken copies. A gate that lives inside an
// assertion which reads the disk itself cannot be shown to go red, and a gate
// that has never gone red is indistinguishable from a gate that cannot.
//
// SCOPE. These gates judge the TWO stella_0017 files and nothing else. They are
// deliberately NOT folded into evaluateReservedQuotaGates(): that contract
// asserts exact facts about the two stella_0016 files — including that
// `settle_reserved_quota` carries five arguments and files the ledger itself,
// which is precisely the body this package turns into a delegator. Widening it
// would have meant relaxing an assertion that is exact today about a package
// that still ships. Same argument stella-reserved-quota-gates.ts makes for not
// joining the stella_0015 contract, one train earlier.
//
// WHAT THESE GATES CANNOT SEE, SAID ONCE. They read TEXT. "No runtime principal
// holds INSERT" is a fact about a CATALOGUE, and the only honest way to assert it
// is against a running server — scripts/stella-governed-consumption-dry-run.sh
// §7 and §15 do exactly that, twice, against a restored baseline. What these
// gates assert is the half that CAN be read from the text: that the package
// states the revoke, over the role that actually holds the privilege, and that
// its own self-verification asks the question in a way that would notice.

import { unparsedSecurityStatements } from './sql-structure'
import { parseFunctions } from './grounding-gates'

export const GOVERNED_FORWARD = 'stella_0017_governed_stella_consumption.sql'
export const GOVERNED_ROLLBACK = 'stella_0017_rollback.sql'

export const GOVERNED_SQL_FILES = [GOVERNED_FORWARD, GOVERNED_ROLLBACK] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** stella_0013's definer — the ONE non-owner principal that may write the ledger. */
const QUOTA_ROLE = 'uellix_cap_stella_quota'
/** stella_0014's definer — the ONLY principal allowed to reach the conversion. */
const TICKET_ROLE = 'uellix_cap_stella_ticket'
/** The runtime identity, and the one whose INSERT is entirely INHERITED. */
const RUNTIME_ROLE = 'uellix_app'
/** The role that ACTUALLY holds the grant `uellix_app` exercises. */
const WRITER_ROLE = 'uellix_writer'
const QUOTA_SCHEMA = 'uellix_stella'
const TICKET_SCHEMA = 'uellix_stella_ops'
const LEDGER = 'public.stella_interactions'

/** The CHECK that makes the closure survive a re-grant. */
export const IDENTITY_CHECK = 'stella_interactions_governed_identity_check'

/**
 * Every principal that can reach a session in this product. The package must
 * state a REVOKE for each — a revoke for a privilege nobody holds is a no-op,
 * and a missing revoke for a privilege somebody regains is a reopened hole.
 *
 * `uellix_reader` is here and is guarded in the SQL on existence: it exists in
 * some environments of this cluster and not in the restored baseline. Measured,
 * not assumed.
 */
export const RUNTIME_PRINCIPALS = [
  'uellix_writer',
  'uellix_app',
  'uellix_reader',
  'uellix_auditor',
  'authenticated',
  'anon',
  'service_role',
  'authenticator',
] as const

/** The two objects this package publishes, by short name and arity marker. */
export const GOVERNED_OBJECTS = [
  { schema: QUOTA_SCHEMA, name: 'settle_reserved_quota', marker: 'p_response_json jsonb' },
  { schema: TICKET_SCHEMA, name: 'complete_operation_ticket', marker: 'p_response_json jsonb' },
] as const

/** The seven governed categories, as the ticket has carried them since stella_0014. */
export const GOVERNED_CATEGORIES = [
  'advisor', 'validator', 'composer', 'proxy_reviewer',
  'evidence_reviewer', 'audit_assistant', 'grounded_query',
] as const

function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

export function evaluateGovernedConsumptionGates(input: Sources): Violation[] {
  // LINE ENDINGS ARE NORMALIZED HERE, ONCE, BEFORE ANY ANCHOR IS SOUGHT. Same
  // reason stella-reserved-quota-gates.ts gives: this function is also called
  // with SYNTHETIC sources built in memory by the mutation suite, and a reader
  // whose verdict depends on which line ending it was handed is a reader whose
  // green means nothing. Nothing on disk is rewritten to make a gate pass.
  const sources: Sources = Object.fromEntries(
    Object.entries(input).map(([name, text]) => [
      name,
      typeof text === 'string' ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : text,
    ]),
  )

  const v: Violation[] = []
  const add = (gate: string, detail: string) => {
    v.push({ gate, detail })
  }
  const require_ = (gate: string, ok: boolean, detail: string) => {
    if (!ok) add(gate, detail)
  }

  // ---------------------------------------------------------------------
  // Harness self-check: is the reader reading what it thinks it is?
  // ---------------------------------------------------------------------
  for (const file of GOVERNED_SQL_FILES) {
    if (typeof sources[file] !== 'string' || sources[file].length === 0) {
      add('source-missing', `${file} is absent or empty`)
    }
  }
  if (v.length > 0) return v

  // Fail-closed: a reader that silently drops what it cannot understand reports
  // the same "zero violations" as one that understood everything.
  for (const file of GOVERNED_SQL_FILES) {
    for (const u of unparsedSecurityStatements(sources[file])) {
      add('unparsed', `${file}: ${u.reason} @${u.line} (${u.origin}): ${u.lead}`)
    }
  }

  const fwd = code(sources[GOVERNED_FORWARD])
  const rbk = code(sources[GOVERNED_ROLLBACK])
  const functions = parseFunctions(sources[GOVERNED_FORWARD])

  /**
   * The bodies, found by the marker that distinguishes the new arity from the
   * one it sits beside. `parseFunctions` keys on the qualified NAME, and this
   * package publishes an overload of a name that already exists — so the map
   * alone cannot tell them apart, and a gate that judged the wrong body would
   * pass for the wrong reason.
   */
  const overload = (schema: string, name: string): string | undefined => {
    const all = functions.filter((f) => f.name === `${schema}.${name}` && f.body.length > 0)
    const withPayload = all.filter((f) => f.header.includes('p_response_json'))
    return withPayload.length > 0 ? withPayload[withPayload.length - 1].body : undefined
  }
  const siblingVerb = overload(TICKET_SCHEMA, 'complete_operation_ticket')
  const conversion = overload(QUOTA_SCHEMA, 'settle_reserved_quota')

  // =====================================================================
  // The package constrains a chain it does not create, and says so first
  // =====================================================================
  // Without the guards, a payload-carrying conversion installs over a database
  // with no capacity arithmetic and `CREATE OR REPLACE` MINTS the five-argument
  // signature rather than replacing it — leaving a self-contained conversion
  // beside a delegator with nothing to delegate to.
  for (const [what, re] of [
    ['stella_0013 (the idempotency column)', /column_name = 'idempotency_key'[\s\S]{0,400}?RAISE EXCEPTION/],
    ['stella_0013 (the unique index)', /uq_stella_interactions_idempotency[\s\S]{0,400}?RAISE EXCEPTION/],
    ['stella_0014 (the ticket table)', /IF to_regclass\('uellix_stella_ops\.operation_tickets'\) IS NULL[\s\S]{0,500}?RAISE EXCEPTION/],
    ['stella_0015 (the project-bound complete)', /IF to_regprocedure\('uellix_stella_ops\.complete_operation_ticket\(character, uuid, character\)'\) IS NULL[\s\S]{0,500}?RAISE EXCEPTION/],
    ['stella_0016 (the conversion it republishes)', /IF to_regprocedure\('uellix_stella\.settle_reserved_quota\(uuid, uuid, character varying, character, character\)'\) IS NULL[\s\S]{0,600}?RAISE EXCEPTION/],
    ['stella_0016 (the capacity arithmetic)', /IF to_regprocedure\('uellix_stella\.stella_capacity\(uuid, character\)'\) IS NULL[\s\S]{0,600}?RAISE EXCEPTION/],
  ] as const) {
    require_('governed-package-order', re.test(fwd),
      `${GOVERNED_FORWARD}: nothing aborts when ${what} is absent, so this package installs over a database it cannot constrain`)
  }
  // ...and the project-BLIND signatures must be proven gone before anything is
  // published. Generalising the protocol on top of them would give five more
  // categories a door around the attribution check.
  require_('governed-package-order',
    /bind_operation_ticket\(character, character\)'\) IS NOT NULL[\s\S]{0,900}?RAISE EXCEPTION/.test(fwd),
    `${GOVERNED_FORWARD}: nothing aborts when a project-blind ticket signature survives`)

  // =====================================================================
  // (1) The direct write is REMOVED, from the role that actually holds it
  // =====================================================================
  // MEASURED, not assumed: `uellix_app` has zero entries in the ledger's relacl
  // and can INSERT anyway, because it INHERITS `uellix_writer`. A package that
  // revoked only from `uellix_app` would ship a no-op.
  require_('governed-direct-insert-revoked',
    new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${LEDGER.replace('.', '\\.')} FROM ${WRITER_ROLE}\\b`).test(fwd),
    `${GOVERNED_FORWARD}: nothing revokes INSERT/UPDATE/DELETE/TRUNCATE on the ledger from ${WRITER_ROLE}. That is the role that HOLDS the grant every runtime session exercises; a revoke aimed anywhere else is a statement that changes nothing`)

  for (const role of RUNTIME_PRINCIPALS) {
    require_('governed-runtime-principals',
      new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${LEDGER.replace('.', '\\.')} FROM ${role}\\b`).test(fwd),
      `${GOVERNED_FORWARD}: no REVOKE names ${role}. A revoke for a privilege nobody holds is a no-op; a missing one for a privilege somebody regains is a reopened hole`)
  }
  require_('governed-runtime-principals',
    new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${LEDGER.replace('.', '\\.')} FROM PUBLIC`).test(fwd),
    `${GOVERNED_FORWARD}: PUBLIC keeps its write privileges. A privilege held by PUBLIC is held by every principal above, whatever the statements before it revoked by name`)

  // ...and the capability role that DOES write keeps exactly what it needs.
  require_('governed-charge-path-preserved',
    new RegExp(`GRANT SELECT, INSERT ON ${LEDGER.replace('.', '\\.')} TO ${QUOTA_ROLE}`).test(fwd),
    `${GOVERNED_FORWARD}: ${QUOTA_ROLE} is not granted INSERT, so no governed function can charge anything at all`)
  require_('governed-charge-path-preserved',
    new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${LEDGER.replace('.', '\\.')} FROM ${TICKET_ROLE}`).test(fwd),
    `${GOVERNED_FORWARD}: the ticket definer is not held away from the ledger. It owns a function that files a charge now, which is exactly when that stops being obvious`)

  // =====================================================================
  // (2) The verification asks the question that FOLLOWS role membership
  // =====================================================================
  // A check written over `relacl` reports this table clean while the inherited
  // INSERT stands. That is not a hypothetical: it is the exact shape of the
  // defect, and a self-verification that could not see it would certify it.
  require_('governed-inherited-privilege',
    /has_table_privilege\(r\.oid, tbl_oid, p\.priv\)/.test(fwd),
    `${GOVERNED_FORWARD}: the self-verification does not ask has_table_privilege over roles. aclexplode does not follow membership, so an inherited INSERT verifies clean`)
  require_('governed-inherited-privilege',
    /FROM pg_roles r[\s\S]{0,600}?NOT r\.rolsuper[\s\S]{0,400}?has_table_privilege/.test(fwd),
    `${GOVERNED_FORWARD}: the self-verification is not driven exhaustively from pg_roles. A named list cannot see the role somebody adds`)

  // =====================================================================
  // (3) The CHECK that survives a re-grant
  // =====================================================================
  require_('governed-identity-check',
    new RegExp(`ADD CONSTRAINT ${IDENTITY_CHECK}\\s*\\n?\\s*CHECK \\(idempotency_key IS NOT NULL\\)`).test(fwd),
    `${GOVERNED_FORWARD}: ${IDENTITY_CHECK} is absent or does not require an operation identity. A privilege can be granted again; a CHECK binds the owner too and is not silenceable by session_replication_role`)
  require_('governed-identity-check-not-valid',
    new RegExp(`CHECK \\(idempotency_key IS NOT NULL\\) NOT VALID`).test(fwd),
    `${GOVERNED_FORWARD}: the governed-identity CHECK is not NOT VALID. Every row filed before this package carries no key, so a validated constraint either fails on apply or means rows were removed from an append-only trail`)
  require_('governed-identity-check',
    /NOT c\.convalidated/.test(fwd),
    `${GOVERNED_FORWARD}: the self-verification does not assert the CHECK is NOT VALID`)
  // stella_0013's narrower constraint must survive. Dropping a published
  // package's constraint to install a superset is how a rollback stops being
  // able to return anywhere.
  require_('governed-identity-check',
    /stella_interactions_grounded_query_idempotency_check[\s\S]{0,400}?RAISE EXCEPTION/.test(fwd),
    `${GOVERNED_FORWARD}: nothing asserts that stella_0013's grounded_query idempotency CHECK survives`)

  // =====================================================================
  // (4) The sibling verb: what it may and may not decide
  // =====================================================================
  require_('governed-sibling-verb-present', typeof siblingVerb === 'string',
    `${GOVERNED_FORWARD}: no payload-carrying ${TICKET_SCHEMA}.complete_operation_ticket was found`)
  require_('governed-conversion-present', typeof conversion === 'string',
    `${GOVERNED_FORWARD}: no payload-carrying ${QUOTA_SCHEMA}.settle_reserved_quota was found`)

  if (siblingVerb) {
    // THE CATEGORY comes from the ticket row, never from an argument. A verb
    // that charged an argument's category would let one ticket be spent as any
    // capability the caller named.
    require_('governed-category-validated',
      /INTO v_org, v_project, v_category, v_status/.test(siblingVerb)
      && /settle_reserved_quota\(\s*\n?\s*v_org, v_project, v_category,/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not charge the ticket's own category, read under the row lock. A category that arrives with the request is a capability the caller chose`)

    // THE ACTOR is derived from the session. There is no argument for it.
    require_('governed-actor-derived',
      /v_actor := auth\.uid\(\);/.test(siblingVerb) && !/p_actor/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not derive the actor from auth.uid(), or takes one as an argument`)

    // THE PROJECT, re-proven on THIS call. bind committed in an earlier
    // transaction, and only complete charges.
    require_('governed-project-proved',
      /v_project IS DISTINCT FROM p_expected_project_id/.test(siblingVerb) && /U0110/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not compare the ticket project against the execution project and raise U0110`)

    // THE ROW LOCK, first in the lock order. Two concurrent completes of one
    // ticket have to serialise here or both can reach the conversion.
    require_('governed-row-lock',
      /FROM uellix_stella_ops\.operation_tickets t\s*\n\s*WHERE t\.ticket_id = p_ticket_id\s*\n\s*FOR UPDATE;/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not take the ticket row lock, so two concurrent completes can both reach the conversion`)

    // RETRY. The same ticket presented again reports what happened and charges
    // nothing — including when it carries a different payload, which is the
    // shape a re-run of a non-deterministic model takes.
    require_('governed-retry-same-ticket',
      /IF v_status = 'completed' THEN\s*\n\s*RETURN QUERY SELECT 'replayed'/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not replay a completed ticket. A retry that falls through charges a second unit for one operation`)

    // A SETTLED ticket is not chargeable. Without this, an aborted reservation
    // could still be converted and the abort would have released nothing.
    require_('governed-settled-ticket-refused',
      /IF v_status IN \('aborted', 'expired'\) THEN[\s\S]{0,200}?U0109/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not refuse an aborted or expired ticket, so an abort stops meaning that nothing was charged`)

    // THE KEY is derived from the ticket and a nonce no function returns.
    require_('governed-key-from-ticket',
      /v_key := [\s\S]{0,400}?'stella\/ticket\/charge\/v1'[\s\S]{0,200}?p_ticket_id[\s\S]{0,200}?v_nonce/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not derive its idempotency key from the ticket and the charge nonce`)
    // ...and NOTHING from the request may enter that derivation. A key derived
    // from the payload makes two legitimately identical operations one charge.
    for (const arg of ['p_response_json', 'p_pipeline_step', 'p_model_used', 'p_tokens_used', 'p_query_hash']) {
      const keyExpr = siblingVerb.match(/v_key := [\s\S]{0,500}?'hex'\);/)?.[0] ?? ''
      require_('governed-key-from-ticket', !keyExpr.includes(arg),
        `${GOVERNED_FORWARD}: ${arg} appears inside the idempotency-key derivation. Content-derived identity collapses two distinct operations onto one charge`)
    }
    // A NEW operation must produce a NEW key, and the only thing that can make
    // it do so is the ticket id being in the preimage.
    require_('governed-new-operation-charges',
      /'stella\/ticket\/charge\/v1'[\s\S]{0,200}?p_ticket_id/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the ticket id is not in the key preimage, so two operations under different tickets derive the same key and the second is free`)

    // THE CHARGE goes through the conversion, and nowhere else.
    require_('governed-conversion-surface',
      /uellix_stella\.settle_reserved_quota\(/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb does not charge through settle_reserved_quota`)
    require_('governed-conversion-surface',
      !/uellix_stella\.consume_stella_quota/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb charges through consume_stella_quota, which evaluates the limit against charged rows only — so completing competes again for the unit bind already reserved. That is R1`)
    require_('governed-ledger-single-writer',
      !/INSERT INTO public\.stella_interactions/.test(siblingVerb),
      `${GOVERNED_FORWARD}: the sibling verb writes the ledger directly, going around the governed path it was published to be`)
  }

  if (conversion) {
    // THE PROOF. The conversion does not take its caller's word for the
    // organization, the project, the category or the state.
    require_('governed-organization-proved',
      /v_org\s+IS DISTINCT FROM p_organization_id/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion does not re-prove the ticket's organization against the one it is asked to charge`)
    require_('governed-project-proved',
      /v_project\s+IS DISTINCT FROM p_project_id/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion does not re-prove the ticket's project`)
    require_('governed-category-validated',
      /v_category IS DISTINCT FROM p_stella_role/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion does not re-prove the ticket's category, so one ticket could be spent as any capability`)
    require_('governed-settled-ticket-refused',
      /v_status\s+IS DISTINCT FROM 'bound'/.test(conversion) && /U0111/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion does not require a BOUND ticket, so an aborted or never-reserved ticket could still file a unit`)
    require_('governed-settled-ticket-refused',
      /IF v_expires <= v_now THEN[\s\S]{0,200}?U0111/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion does not refuse an expired reservation, whose unit may already have been handed to somebody else`)

    // NO LIMIT CHECK, and that is the sentence R1 asked for. The unit was
    // committed at bind; testing it again is what made complete lose to a
    // sibling that arrived in between.
    require_('governed-conversion-does-not-compete',
      !/v_cap\.available\s*<=\s*0/.test(conversion) && !/quota_exceeded/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion evaluates the limit. The unit it files was counted against that limit the moment the reservation was taken, so testing it again charges one commitment twice and loses whichever operation asked second`)

    // The shared advisory lock, on the SAME key every other path uses. Two
    // different keys would be two different mutexes.
    require_('governed-shared-lock',
      /pg_advisory_xact_lock\(\s*\n?\s*pg_catalog\.hashtextextended\('stella\/quota\/' \|\| p_organization_id::text, 0\)\)/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion does not take the per-organization advisory lock on the campaign's shared key`)

    // ONE writer. The conflict clause is what keeps "no retry charges twice" a
    // property of the data rather than of who called what.
    require_('governed-ledger-single-writer',
      /ON CONFLICT \(organization_id, idempotency_key\) WHERE idempotency_key IS NOT NULL\s*\n\s*DO NOTHING;/.test(conversion),
      `${GOVERNED_FORWARD}: the conversion's INSERT carries no ON CONFLICT DO NOTHING on the idempotency index`)

    // The payload defaults reproduce stella_0016's row EXACTLY. Without them
    // the grounded path silently changes shape the day the delegator is used.
    for (const [what, re] of [
      ['the fixed literal body', /COALESCE\(p_response_json, '\{"kind":"quota_consumption","version":1\}'::jsonb\)/],
      ['the not-applicable model', /COALESCE\(p_model_used, 'not-applicable'\)/],
      ['the category as pipeline step', /COALESCE\(p_pipeline_step, p_stella_role\)/],
      ['the derived context digest', /COALESCE\(\s*\n?\s*p_context_hash,/],
    ] as const) {
      require_('governed-null-payload-parity', re.test(conversion),
        `${GOVERNED_FORWARD}: the conversion does not default ${what}, so a NULL payload no longer reproduces the row stella_0016 filed`)
    }
  }

  // =====================================================================
  // (5) The five-argument signature stays, and DELEGATES
  // =====================================================================
  // Dropping it would silently disarm STELLA_0016_INSTALLED_PROBE in
  // db/prepared-package-order.ts, which is written over exactly that signature —
  // and with the probe false, stella_0015 becomes re-appliable over stella_0016.
  require_('governed-old-signature-delegates',
    !/DROP FUNCTION[^\n]*settle_reserved_quota\(uuid, uuid, character varying, character, character\)/.test(fwd),
    `${GOVERNED_FORWARD}: the five-argument settle_reserved_quota is dropped. STELLA_0016_INSTALLED_PROBE resolves that signature; removing it disarms the guard that stops stella_0015 being re-applied over stella_0016`)
  {
    const five = functions.filter(
      (f) => f.name === `${QUOTA_SCHEMA}.settle_reserved_quota`
        && !f.header.includes('p_response_json')
        && f.body.length > 0,
    )
    require_('governed-old-signature-delegates', five.length === 1,
      `${GOVERNED_FORWARD}: expected exactly one five-argument settle_reserved_quota body, found ${five.length}`)
    if (five.length === 1) {
      require_('governed-old-signature-delegates',
        /RETURN QUERY[\s\S]{0,300}?uellix_stella\.settle_reserved_quota\(/.test(five[0].body),
        `${GOVERNED_FORWARD}: the five-argument settle_reserved_quota does not delegate to the payload-carrying one`)
      require_('governed-ledger-single-writer',
        !/INSERT INTO public\.stella_interactions/.test(five[0].body),
        `${GOVERNED_FORWARD}: the five-argument settle_reserved_quota still writes the ledger itself. Two writers in one schema are two sets of idempotency semantics`)
    }
  }

  // =====================================================================
  // (6) The grant that IS the security property
  // =====================================================================
  // The conversion files a unit WITHOUT evaluating the limit, so who may execute
  // it is not an access-control detail — it is the whole boundary.
  require_('governed-conversion-grant',
    new RegExp(`GRANT EXECUTE ON FUNCTION ${QUOTA_SCHEMA}\\.settle_reserved_quota\\([^;]*?jsonb\\)\\s*\\n?\\s*TO ${TICKET_ROLE};`).test(fwd),
    `${GOVERNED_FORWARD}: the payload-carrying conversion is not granted to ${TICKET_ROLE}, so no ticket can be completed at all`)
  require_('governed-conversion-grant',
    !new RegExp(`GRANT EXECUTE ON FUNCTION ${QUOTA_SCHEMA}\\.settle_reserved_quota\\([^;]*?jsonb\\)[^;]*TO ${RUNTIME_ROLE}`).test(fwd),
    `${GOVERNED_FORWARD}: the payload-carrying conversion is granted to ${RUNTIME_ROLE}. It files a unit without evaluating the limit; a runtime principal holding EXECUTE could charge past the cap for any ticket it could name`)
  require_('governed-conversion-grant',
    /has_function_privilege\(r\.oid, to_regprocedure\(\s*\n?\s*'uellix_stella\.settle_reserved_quota/.test(fwd),
    `${GOVERNED_FORWARD}: the self-verification does not assert the ABSENCE of that grant for runtime principals. An ungranted privilege and a revoked one read the same in a catalogue only if somebody checks`)
  require_('governed-sibling-verb-grant',
    new RegExp(`GRANT EXECUTE ON FUNCTION ${TICKET_SCHEMA}\\.complete_operation_ticket\\([^;]*?jsonb\\)\\s*\\n?\\s*TO ${RUNTIME_ROLE};`).test(fwd),
    `${GOVERNED_FORWARD}: the sibling completion verb is not granted to ${RUNTIME_ROLE}, so the five actions have nothing to migrate to`)

  // Every function this package publishes is a definer with an empty path, owned
  // by the right capability role, and unreachable by PUBLIC.
  for (const o of GOVERNED_OBJECTS) {
    require_('governed-definer-posture',
      new RegExp(`REVOKE ALL ON FUNCTION ${o.schema}\\.${o.name}\\([^;]*?jsonb\\) FROM PUBLIC;`).test(fwd),
      `${GOVERNED_FORWARD}: ${o.schema}.${o.name} does not revoke EXECUTE from PUBLIC before granting`)
  }
  require_('governed-definer-posture',
    (fwd.match(/SECURITY DEFINER\s*\nSET search_path = ''/g) ?? []).length >= 3,
    `${GOVERNED_FORWARD}: not every published function is SECURITY DEFINER with an empty search_path`)

  // =====================================================================
  // (7) The rollback must not undo the closure
  // =====================================================================
  require_('governed-rollback-keeps-revoke',
    !new RegExp(`GRANT[^\\n;]*\\bINSERT\\b[^\\n;]*ON ${LEDGER.replace('.', '\\.')}`).test(rbk),
    `${GOVERNED_ROLLBACK}: the rollback GRANTs INSERT on the ledger back. The direct write is not a feature this package replaced; it is the defect it closed, and on stella_0016 it composes into a measured oversell`)
  require_('governed-rollback-keeps-revoke',
    /has_table_privilege\(r\.oid, to_regclass\('public\.stella_interactions'\), p\.priv\)/.test(rbk),
    `${GOVERNED_ROLLBACK}: the rollback does not assert, as a postcondition, that no runtime principal can write the ledger. The one thing it must never do has to be checkable by machine`)
  require_('governed-rollback-keeps-check',
    new RegExp(`${IDENTITY_CHECK}[\\s\\S]{0,400}?RAISE EXCEPTION`).test(rbk),
    `${GOVERNED_ROLLBACK}: the rollback does not assert that the governed-identity CHECK survives. A row with no operation identity would be creatable again by the table owner`)
  require_('governed-rollback-keeps-check',
    !new RegExp(`DROP CONSTRAINT[^\\n;]*${IDENTITY_CHECK}`).test(rbk),
    `${GOVERNED_ROLLBACK}: the rollback drops the governed-identity CHECK`)

  // It removes BOTH objects, unconditionally — INT-CAP-004 (1)'s lesson: a DROP
  // nested inside a test for something else is a DROP that silently does not
  // happen.
  require_('governed-rollback-removes-both',
    /DROP FUNCTION IF EXISTS uellix_stella_ops\.complete_operation_ticket\(character, uuid, character, character varying, character varying, integer, jsonb\)/.test(rbk),
    `${GOVERNED_ROLLBACK}: the sibling completion verb is not dropped`)
  require_('governed-rollback-removes-both',
    /DROP FUNCTION IF EXISTS uellix_stella\.settle_reserved_quota\(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb\)/.test(rbk),
    `${GOVERNED_ROLLBACK}: the payload-carrying conversion is not dropped. It is owned by ${QUOTA_ROLE}, so leaving it behind makes stella_0013's DROP ROLE fail three links downstream`)

  // It restores stella_0016's SELF-CONTAINED body, not a delegator whose target
  // it is about to drop.
  require_('governed-rollback-restores-conversion',
    /INSERT INTO public\.stella_interactions/.test(rbk) && /uellix_stella\.stella_capacity/.test(rbk),
    `${GOVERNED_ROLLBACK}: the five-argument conversion is not restored to stella_0016's self-contained body, so it would delegate to a function this rollback drops`)

  // It REFUSES rather than publishing a function that cannot work.
  require_('governed-rollback-order-refusal',
    /IF to_regprocedure\('uellix_stella\.stella_capacity\(uuid, character\)'\) IS NULL THEN[\s\S]{0,600}?RAISE EXCEPTION[^\n]*REFUSED/.test(rbk),
    `${GOVERNED_ROLLBACK}: the rollback does not refuse on a database where stella_0016 is already rolled back. It would install a SECURITY DEFINER function that fails at its first call`)

  // ...and it never removes a charge.
  require_('governed-rollback-keeps-charges',
    !/DELETE FROM public\.stella_interactions/.test(rbk) && !/TRUNCATE[^\n;]*stella_interactions/.test(rbk),
    `${GOVERNED_ROLLBACK}: the rollback removes rows from the ledger. A rollback that can erase a consumption is not a rollback, it is a refund nobody authorised`)

  // =====================================================================
  // (8) Neither file may hold a payload in a place it does not belong
  // =====================================================================
  // The TICKET table stays free of text: the ban lives there, not on the ledger,
  // which has held response_json since migration 0012.
  require_('governed-ticket-table-untouched',
    !/ALTER TABLE uellix_stella_ops\.operation_tickets\s+ADD COLUMN/.test(fwd),
    `${GOVERNED_FORWARD}: this package adds a column to the ticket table. It stores digests and closed-vocabulary codes, never the query, a prompt, an answer or evidence`)

  return v
}
