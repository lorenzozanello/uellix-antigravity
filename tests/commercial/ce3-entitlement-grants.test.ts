// tests/commercial/ce3-entitlement-grants.test.ts
// CE-3 — EntitlementGrant relation and explicit evaluator (HPO-ODS-W2-30,
// docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_v1.0.0.json).
//
// DB-FREE controls over the frozen product contract, proven against the LIVE
// bytes of the migration, the manifest, the schema and the two new
// lib/capabilities modules — never against a copy.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Everything that is a database SEMANTIC —
// RLS denial, FORCE's runtime effect, partial-index behaviour under
// concurrency, definer GUC resolution, effective-privilege inheritance — is
// proven by tests/postgres/ce3-entitlement-grants.pg.test.ts against a real
// cluster. Reading `ALTER TABLE ... FORCE ROW LEVEL SECURITY` out of a file
// proves the STATEMENT is present; it proves nothing about whether anybody is
// actually denied, because FORCE is silently inert for a BYPASSRLS role and for
// the table owner. This file proves the parts a static reading CAN prove, and
// the outcome-mapping controls that a fake executor can prove EXHAUSTIVELY and
// DETERMINISTICALLY — which is a better instrument for those than a container.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'
import { scanBaselineSql, splitSqlStatements, stripSqlComments } from '@/db/hosted/baseline-scanner'
import { entitlementGrants } from '@/db/schema'
import {
  ENTITLEMENT_CAPABILITY_CATALOGUE,
  ENTITLEMENT_CAPABILITY_KEYS,
  ENTITLEMENT_GRANT_SOURCES,
  ENTITLEMENT_LIMIT_KINDS,
  describeCapability,
  isDeclaredCapabilityKey,
} from '@/lib/capabilities/entitlement-catalogue'
import {
  ENTITLEMENT_SQLSTATE,
  evaluateEntitlement,
  type EntitlementEffectiveRow,
  type EntitlementExecutor,
  type EntitlementOutcome,
  type EntitlementQuery,
} from '@/lib/capabilities/entitlement-evaluator'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const lf = (s: string) => s.split('\r\n').join('\n')

// DERIVED from the live manifest, never named by ordinal here: the ordinal is a
// globally contested sequence and this file must keep proving the right unit
// even if the lane had to re-number.
const CE3_UNIT = BASELINE_UNITS.find((u) => /^\d{4}_commercial_account_ce3_entitlement_grants\.sql$/.test(u.id))
if (!CE3_UNIT) throw new Error('the CE-3 entitlement-grants baseline unit is not registered in db/hosted/baseline-manifest.ts')

const MIGRATION_LF = lf(read(CE3_UNIT.file))
const CODE = stripSqlComments(MIGRATION_LF)
const STATEMENTS = splitSqlStatements(CODE)
const FACTS = scanBaselineSql(MIGRATION_LF)

/** The whole file as ONE string. A LINE grep cannot see a multi-line statement. */
const whole = (re: RegExp) => re.test(CODE)

/* ========================================================================== */
/* Meta: the instruments themselves                                           */
/* ========================================================================== */

describe('CE-3 control instruments are not vacuous', () => {
  // A KNOWN-POSITIVE CONTROL FOR EVERY SWEEP. Each helper below is used to
  // assert ABSENCE somewhere in this file, and an absence assertion made with a
  // broken instrument passes for free. These prove the instruments can see
  // something that is genuinely there before any of them is trusted to report
  // that something is genuinely missing.
  it('the comment-stripped source still contains the statements it should', () => {
    expect(CODE.length).toBeGreaterThan(500)
    expect(whole(/CREATE\s+TABLE\s+"entitlement_grants"/)).toBe(true)
    expect(whole(/FORCE\s+ROW\s+LEVEL\s+SECURITY/)).toBe(true)
  })

  it('comment stripping really removes comments, so a prose match cannot satisfy a code control', () => {
    // The migration's PROSE mentions BYPASSRLS (to refuse it by name) and
    // mentions CREATE ROLE (to record that one was written and removed). If the
    // stripper were broken, the absence controls further down would be matching
    // comments and would be worthless.
    expect(MIGRATION_LF).toMatch(/BYPASSRLS/)
    expect(MIGRATION_LF).toMatch(/CREATE ROLE/)
    expect(CODE).not.toMatch(/BYPASSRLS/)
    expect(CODE).not.toMatch(/CREATE ROLE/)
  })

  it('statement splitting yields real statements', () => {
    expect(STATEMENTS.length).toBeGreaterThan(5)
    expect(STATEMENTS.some((s) => /^CREATE\s+TABLE/i.test(s.trim()))).toBe(true)
  })
})

/* ========================================================================== */
/* CE3-P-4 — the physical target shape                                        */
/* ========================================================================== */

describe('CE3-P-4 — entitlement_grants carries EXACTLY the parent thirteen columns', () => {
  const COLUMNS = [
    'id',
    'organization_id',
    'capability_key',
    'source',
    'commercial_account_id',
    'plan_ref',
    'limit_kind',
    'limit_value',
    'effective_from',
    'effective_to',
    'reason',
    'actor_user_id',
    'audit_log_id',
  ] as const

  /** The live Drizzle table, by physical column name. */
  const physical = new Map(
    Object.values(entitlementGrants).filter(
      (c): c is { name: string; notNull: boolean; columnType: string } =>
        typeof c === 'object' && c !== null && 'name' in c && 'notNull' in c,
    ).map((c) => [c.name, c]),
  )

  it('has exactly thirteen columns, by name, in the schema', () => {
    expect([...physical.keys()].sort()).toEqual([...COLUMNS].sort())
    expect(physical.size).toBe(13)
  })

  // ASSERTED AS AN ABSENCE, because the presence of these is what would make the
  // relation a DIFFERENT concept. A relation carrying `status` is not the
  // ratified one: status must DERIVE from the effective period (SC-6), and a
  // stored copy is a second source of truth the partial unique index cannot keep
  // honest.
  it.each(['status', 'created_at', 'updated_at', 'deleted_at', 'current', 'is_active', 'deleted'])(
    'does NOT carry a %s column',
    (forbidden) => {
      expect(physical.has(forbidden)).toBe(false)
      expect(whole(new RegExp(`"${forbidden}"\\s+(uuid|varchar|text|integer|timestamp|boolean)`))).toBe(false)
    },
  )

  it('pins the parent nullability exactly', () => {
    const NOT_NULL = ['id', 'organization_id', 'capability_key', 'source', 'limit_kind', 'effective_from']
    const NULLABLE = ['commercial_account_id', 'plan_ref', 'limit_value', 'effective_to', 'reason', 'actor_user_id', 'audit_log_id']
    for (const c of NOT_NULL) expect(physical.get(c)?.notNull, `${c} must be NOT NULL`).toBe(true)
    // actor_user_id NULL is MEANINGFUL (PI-5): a machine-originated grant. Making
    // it NOT NULL would force a service account to be attributed as a person.
    for (const c of NULLABLE) expect(physical.get(c)?.notNull, `${c} must be NULLABLE`).toBe(false)
  })

  // timestamptz, NOT timestamp. A `timestamp without time zone` would make both
  // CHECK-5 and the evaluator's transaction_timestamp() comparison depend on the
  // session TimeZone of whoever connected, so a grant could be live for one
  // caller and not another at the same instant. This is mutation 16.
  it('both period columns are timestamptz in the emitted DDL', () => {
    expect(whole(/"effective_from"\s+timestamp with time zone\s+NOT NULL/)).toBe(true)
    expect(whole(/"effective_to"\s+timestamp with time zone/)).toBe(true)
    expect(whole(/"effective_(from|to)"\s+timestamp(?!\s+with time zone)/)).toBe(false)
  })

  it('effective_from carries NO database default, so a grant must state when it takes effect', () => {
    expect(whole(/"effective_from"\s+timestamp with time zone\s+DEFAULT/)).toBe(false)
  })

  it('limit_kind carries NO default, so an unstated metered semantic fails closed', () => {
    expect(whole(/"limit_kind"[^,\n]*DEFAULT/)).toBe(false)
  })
})

describe('CE3-P-4 — the six parent constraints plus the two closed value-set pins', () => {
  const CHECKS = [
    ['entitlement_grants_capped_limit_check', /limit_kind"?\s*<>\s*'CAPPED'\s+OR\s+\([\s\S]*?limit_value[\s\S]*?IS NOT NULL\s+AND[\s\S]*?>=\s*0\)/],
    ['entitlement_grants_unmetered_blocked_limit_check', /limit_kind"?\s+NOT IN\s+\('UNMETERED',\s*'BLOCKED'\)\s+OR[\s\S]*?limit_value"?\s+IS NULL/],
    ['entitlement_grants_commercial_basis_required_check', /source"?\s+NOT IN\s+\('PLAN',\s*'COMMERCIAL_EXCEPTION'\)\s+OR[\s\S]*?commercial_account_id"?\s+IS NOT NULL/],
    ['entitlement_grants_commercial_basis_forbidden_check', /source"?\s+NOT IN\s+\('PLATFORM_ADMIN',\s*'BOOTSTRAP_DEFAULT'\)\s+OR[\s\S]*?commercial_account_id"?\s+IS NULL/],
    ['entitlement_grants_effective_period_check', /effective_to"?\s+IS NULL\s+OR[\s\S]*?effective_to"?\s*>\s*"?entitlement_grants"?\."?effective_from/],
    ['entitlement_grants_source_check', /source"?\s+IN\s+\('PLAN',\s*'PLATFORM_ADMIN',\s*'BOOTSTRAP_DEFAULT',\s*'COMMERCIAL_EXCEPTION'\)/],
    ['entitlement_grants_limit_kind_check', /limit_kind"?\s+IN\s+\('UNMETERED',\s*'BLOCKED',\s*'CAPPED'\)/],
  ] as const

  it.each(CHECKS.map(([name]) => name))('declares CHECK %s', (name) => {
    expect(whole(new RegExp(`CONSTRAINT\\s+"${name}"\\s+CHECK`))).toBe(true)
  })

  it.each(CHECKS)('%s carries the ratified predicate, not merely the name', (_name, predicate) => {
    expect(predicate.test(CODE)).toBe(true)
  })

  // BOTH HALVES OF THE COMMERCIAL BICONDITIONAL. Keeping only the first would
  // still refuse the obvious bad row while admitting a PLATFORM_ADMIN grant
  // carrying a commercial basis that never existed — mutation CE3-M-7, and the
  // half an implementer omits by default.
  it('the commercial-provenance biconditional has BOTH halves', () => {
    expect(whole(/entitlement_grants_commercial_basis_required_check/)).toBe(true)
    expect(whole(/entitlement_grants_commercial_basis_forbidden_check/)).toBe(true)
  })

  // THE EFFECTIVE-PERIOD INEQUALITY IS STRICT. `>=` would silently admit
  // effective_to = effective_from — a zero-length period — which is the case
  // CE3-N-6 names explicitly because it is the one a non-strict implementation
  // accepts without complaint. This is mutation 5.
  it('the effective-period check is a STRICT inequality', () => {
    expect(whole(/"effective_to"\s*>\s*"entitlement_grants"\."effective_from"/)).toBe(true)
    expect(whole(/"effective_to"\s*>=\s*"entitlement_grants"\."effective_from"/)).toBe(false)
  })

  // THE PARTIAL UNIQUE INDEX — the SOLE and FINAL mechanism for "exactly one
  // live grant" (CONCURRENCY_CONTRACT). Its predicate must be effective_to IS
  // NULL and must carry NO effective_from term: narrowing it would admit two
  // rows SC-5 forbids. This is mutation 1.
  it('declares the partial unique index on (organization_id, capability_key) WHERE effective_to IS NULL', () => {
    expect(whole(
      /CREATE UNIQUE INDEX\s+"uq_entitlement_grants_live_org_capability"\s+ON\s+"entitlement_grants"\s+USING btree\s+\("organization_id","capability_key"\)\s+WHERE\s+"entitlement_grants"\."effective_to"\s+IS NULL/,
    )).toBe(true)
  })

  it('the unique predicate carries NO effective_from term', () => {
    const idx = CODE.match(/CREATE UNIQUE INDEX[^;]*uq_entitlement_grants_live_org_capability[^;]*;/)
    expect(idx).not.toBeNull()
    expect(idx![0]).not.toMatch(/effective_from/)
  })

  it('carries exactly ONE unique index, so no second effective key exists', () => {
    const uniques = CODE.match(/CREATE UNIQUE INDEX[^;]*ON "entitlement_grants"/g) ?? []
    expect(uniques.length).toBe(1)
  })

  // SC-11: plan_ref is a SNAPSHOT and an FK here is PROHIBITED. The absent FK is
  // the load-bearing half — with one, editing a plan definition would
  // retroactively rewrite what an Organization was granted (CE3-N-12b).
  it('plan_ref carries NO foreign key', () => {
    expect(whole(/FOREIGN KEY\s*\("plan_ref"\)/)).toBe(false)
    // Known-positive: the FKs that SHOULD exist are found by the same sweep.
    expect(whole(/FOREIGN KEY\s*\("organization_id"\)/)).toBe(true)
  })

  // ON DELETE CASCADE is PROHIBITED on every FK: a cascading delete is a DELETE
  // of grant rows performed by the database on behalf of an unrelated statement,
  // destroying exactly the rows SEC-12 requires to survive.
  it('every foreign key is ON DELETE no action — never CASCADE or SET NULL', () => {
    const fks = CODE.match(/FOREIGN KEY[^;]*;/g) ?? []
    expect(fks.length).toBe(4)
    for (const fk of fks) {
      expect(fk).toMatch(/ON DELETE no action/)
      expect(fk).not.toMatch(/ON DELETE (cascade|set null|set default)/i)
    }
  })
})

/* ========================================================================== */
/* RLS posture and the definer — the STATIC half                              */
/* ========================================================================== */

describe('CE-3 RLS posture — F-CE3-1 resolved as R-A', () => {
  it('ENABLE and FORCE row level security are both in the SAME migration as the CREATE TABLE', () => {
    expect(whole(/ALTER TABLE entitlement_grants ENABLE ROW LEVEL SECURITY/)).toBe(true)
    expect(whole(/ALTER TABLE entitlement_grants FORCE ROW LEVEL SECURITY/)).toBe(true)
    expect(FACTS.rlsEnabledTables).toEqual(['public.entitlement_grants'])
  })

  it('creates EXACTLY ONE policy, SELECT-only, addressed to uellix_owner', () => {
    expect(FACTS.policiesCreated).toEqual(['public.entitlement_grants.entitlement_grants_select_owner'])
    expect(whole(/CREATE POLICY "entitlement_grants_select_owner" ON entitlement_grants FOR SELECT\s*\nTO uellix_owner\s*\nUSING \(true\)/)).toBe(true)
  })

  // ZERO TENANT-FACING POLICIES, each forbidden role checked BY NAME rather than
  // inferred from the count above. This is mutation 11 (widen the policy to
  // authenticated) and it is also what defers every tenant-facing decision to
  // tenancy S4 instead of pre-empting it.
  // SCOPED TO THE POLICY STATEMENTS THEMSELVES, not to the whole file.
  //
  // THE UNBOUNDED FORM WAS WRONG AND IS RECORDED RATHER THAN QUIETLY REPLACED:
  // /CREATE POLICY[\s\S]*?TO\s+authenticated/ matched, because the lazy gap ran
  // from the single CREATE POLICY statement all the way across the file to the
  // unrelated `GRANT EXECUTE ON FUNCTION ... TO authenticated` line. A FUNCTION
  // ACL is not a POLICY, so the control reported a tenant-facing policy that
  // does not exist. An absence control with an unbounded gap answers a question
  // nobody asked — and the next person "fixes" it by weakening the assertion.
  const POLICY_STATEMENTS = CODE.match(/CREATE POLICY[\s\S]*?;/g) ?? []

  it('there is exactly one CREATE POLICY statement to scope the role controls to', () => {
    expect(POLICY_STATEMENTS.length).toBe(1)
  })

  it.each(['authenticated', 'anon', 'uellix_app', 'uellix_writer', 'service_role', 'public'])(
    'creates NO policy addressed to %s',
    (role) => {
      const offending = POLICY_STATEMENTS.filter((s) => new RegExp(`TO\\s+${role}\\b`).test(s))
      expect(offending).toEqual([])
    },
  )

  it('the scoped role control can still see the role the policy DOES address', () => {
    // Known-positive: the same instrument, same shape, must find uellix_owner.
    expect(POLICY_STATEMENTS.filter((s) => /TO\s+uellix_owner\b/.test(s)).length).toBe(1)
  })

  it('creates no INSERT, UPDATE or DELETE policy of any kind', () => {
    expect(whole(/CREATE POLICY[\s\S]*?FOR\s+(INSERT|UPDATE|DELETE|ALL)\b/)).toBe(false)
  })

  // No BYPASSRLS role is created or altered, and the unit introduces no role
  // statement and no ownership transfer at all — BASELINE_GLOBAL_INVARIANTS pins
  // both at zero for every baseline unit with no per-unit opt-out.
  it('introduces no role statement, no ownership transfer and no BYPASSRLS posture', () => {
    const f = FACTS as unknown as Record<string, unknown[]>
    expect(f.roleStatements).toEqual([])
    expect(f.ownershipStatements).toEqual([])
    expect(f.superuserDependencies).toEqual([])
    expect(f.extensionStatements).toEqual([])
    expect(CODE).not.toMatch(/BYPASSRLS/)
  })

  it('grants direct table SELECT to uellix_owner and to NO tenant identity', () => {
    expect(whole(/GRANT SELECT ON public\.entitlement_grants TO uellix_owner/)).toBe(true)
    for (const role of ['authenticated', 'anon', 'uellix_app', 'uellix_writer', 'service_role']) {
      expect(new RegExp(`GRANT[^;]*ON public\\.entitlement_grants[^;]*\\b${role}\\b`).test(CODE)).toBe(false)
    }
  })
})

describe('CE-3 evaluator function — the STATIC half', () => {
  it('is declared exactly once, SECURITY DEFINER, STABLE, with a pinned search_path', () => {
    expect(FACTS.securityDefinerFunctions).toEqual(['public.entitlement_effective'])
    expect(FACTS.searchPathSettings).toEqual(['public'])
    expect(whole(/CREATE OR REPLACE FUNCTION public\.entitlement_effective\(\s*\n\s*p_organization_id uuid,\s*\n\s*p_capability_key varchar\s*\n\)/)).toBe(true)
    expect(whole(/RETURNS TABLE \(kind text, limit_value integer\)/)).toBe(true)
    expect(whole(/LANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER\nSET search_path = public/)).toBe(true)
  })

  // THE ORGANIZATION ARGUMENT IS THE SCOPE, and the containment check is against
  // THAT ARGUMENT. Mutation CE3-M-4 makes it optional or falls back to ambient
  // context; the forbidden mechanisms are named individually so that swapping in
  // any one of them is caught.
  it('checks caller scope by containment against the EXPLICIT argument', () => {
    expect(whole(/p_organization_id = ANY \(public\.current_user_org_ids\(\)\)/)).toBe(true)
  })

  it.each(['user_single_active_membership', 'selected_organization', 'selected_org', 'current_user_role_in_org', 'current_user_is_super_admin', 'hasRole', 'ROLE_HIERARCHY'])(
    'uses NO %s substitute for the explicit organization',
    (mechanism) => {
      expect(CODE.includes(mechanism)).toBe(false)
    },
  )

  // ORDERING IS LOAD-BEARING: scope first, capability second. Reversed, an
  // out-of-scope caller could distinguish declared from undeclared keys by
  // SQLSTATE and enumerate the capability vocabulary from outside their scope.
  it('raises U0113 for scope BEFORE it validates the capability key', () => {
    const body = CODE.slice(CODE.indexOf('CREATE OR REPLACE FUNCTION public.entitlement_effective'))
    const u0113 = body.indexOf('U0113')
    const u0114 = body.indexOf('U0114')
    expect(u0113).toBeGreaterThan(-1)
    expect(u0114).toBeGreaterThan(-1)
    expect(u0113).toBeLessThan(u0114)
  })

  // THE SQL-SIDE CATALOGUE CHECK IS NOT OPTIONAL. EXECUTE is granted to
  // `authenticated`, so a caller can invoke the function directly and bypass the
  // TypeScript pre-check entirely. Removing this while leaving TypeScript intact
  // is mutation 17.
  it('validates the capability key AT THE DATABASE against the production catalogue literal', () => {
    expect(whole(/p_capability_key <> 'stella\.grounded_query'/)).toBe(true)
  })

  it('the SQL catalogue literal and the TypeScript catalogue cannot drift apart', () => {
    // Every production key must appear as a literal in the function body, and
    // the function must name no key the catalogue does not declare.
    const body = CODE.slice(CODE.indexOf('CREATE OR REPLACE FUNCTION public.entitlement_effective'))
    for (const key of ENTITLEMENT_CAPABILITY_KEYS) expect(body).toContain(`'${key}'`)
    const literals = [...body.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1])
    expect([...new Set(literals)].sort()).toEqual([...ENTITLEMENT_CAPABILITY_KEYS].sort())
  })

  // BOTH REFUSALS ARE UNIFORM: identical fixed message, no DETAIL, no HINT, and
  // no echoed argument. The SQLSTATE is the entire signal.
  it('both refusals carry the identical fixed message and echo nothing', () => {
    const raises = [...CODE.matchAll(/RAISE EXCEPTION '([^']*)' USING ERRCODE = '(U011[34])'/g)]
    expect(raises.length).toBe(2)
    expect(new Set(raises.map((m) => m[1])).size).toBe(1)
    expect(new Set(raises.map((m) => m[2]))).toEqual(new Set(['U0113', 'U0114']))
    for (const [, message] of raises) {
      expect(message).not.toMatch(/%/)
      expect(message).not.toMatch(/p_organization_id|p_capability_key|grounded_query/)
    }
    expect(whole(/USING ERRCODE = 'U011[34]'[^;]*,\s*(DETAIL|HINT)/)).toBe(false)
  })

  // THE EXPLICIT EVALUATION-INSTANT DECISION
  // (EVALUATOR_CONTRACT.evaluation_instant_semantics). Recorded in the predicate
  // rather than left to emerge from whichever comparison the query happened to
  // carry: a live row whose effective_from is in the future OCCUPIES the unique
  // key but is NOT in force.
  it('requires effective_from <= transaction_timestamp() in the effective-grant predicate', () => {
    expect(whole(/g\.effective_to IS NULL\s*\n\s*AND g\.effective_from <= transaction_timestamp\(\)/)).toBe(true)
  })

  it('answers NO_LIVE_GRANT as a row, never as an exception or an empty set', () => {
    expect(whole(/RETURN QUERY SELECT 'NO_LIVE_GRANT'::text, NULL::integer/)).toBe(true)
  })

  // PostgreSQL grants EXECUTE to PUBLIC by default at CREATE time, and 0033's
  // historical blanket revoke cannot reach a function created later. Removing
  // this REVOKE is mutation 15.
  it('REVOKEs EXECUTE from PUBLIC on both new functions and re-grants only to authenticated', () => {
    expect(whole(/REVOKE EXECUTE ON FUNCTION public\.entitlement_effective\(uuid, varchar\) FROM PUBLIC/)).toBe(true)
    expect(whole(/REVOKE EXECUTE ON FUNCTION public\.enforce_entitlement_grant_append_only\(\) FROM PUBLIC/)).toBe(true)
    expect(whole(/GRANT EXECUTE ON FUNCTION public\.entitlement_effective\(uuid, varchar\) TO authenticated/)).toBe(true)
    expect(whole(/GRANT EXECUTE[^;]*TO[^;]*\banon\b/)).toBe(false)
  })

  it('the evaluator mutates nothing — no INSERT, UPDATE, DELETE or set_config in the unit', () => {
    expect(FACTS.dmlStatements).toEqual([])
    expect(CODE).not.toMatch(/\bset_config\b/)
  })
})

/* ========================================================================== */
/* CE3-N-8 / CE3-M-6 — the append-only storage boundary, STATIC half          */
/* ========================================================================== */

describe('CE-3 append-only storage boundary', () => {
  it('installs a BEFORE UPDATE OR DELETE row trigger on the relation', () => {
    expect(FACTS.triggersCreated).toEqual(['trg_entitlement_grants_append_only'])
    expect(whole(/CREATE TRIGGER trg_entitlement_grants_append_only\s*\n\s*BEFORE UPDATE OR DELETE ON entitlement_grants\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.enforce_entitlement_grant_append_only\(\)/)).toBe(true)
  })

  // NOT uellix_forbid_mutation(). That guard refuses EVERY update, which would
  // refuse the ONE legal transition this relation has — so reuse would make the
  // ratified revoke-and-replace lifecycle unexpressible.
  it('uses a BESPOKE guard and does not reuse uellix_forbid_mutation()', () => {
    expect(CODE).not.toMatch(/uellix_forbid_mutation/)
    expect(whole(/CREATE OR REPLACE FUNCTION public\.enforce_entitlement_grant_append_only\(\)/)).toBe(true)
  })

  it('refuses DELETE, a second close, and a re-open — each as its own arm', () => {
    expect(whole(/IF TG_OP = 'DELETE' THEN[\s\S]{0,200}?ERRCODE = 'insufficient_privilege'/)).toBe(true)
    expect(whole(/IF OLD\.effective_to IS NOT NULL THEN/)).toBe(true)
    expect(whole(/IF NEW\.effective_to IS NULL THEN/)).toBe(true)
  })

  // NULL-SAFE COMPARISON, and this is the arm that matters most. SEVEN of the
  // twelve guarded columns are nullable, and `NEW.x <> OLD.x` yields UNKNOWN
  // when either side is NULL — so an equality chain would NOT fire for exactly
  // the rows an attacker would edit, and the mutation would be ADMITTED.
  it('compares the other twelve columns with row-wise IS DISTINCT FROM', () => {
    expect(whole(/IS DISTINCT FROM/)).toBe(true)
    const guard = CODE.match(/IF \(NEW\.id[\s\S]*?END IF;/)
    expect(guard).not.toBeNull()
    const block = guard![0]
    const guarded = ['id', 'organization_id', 'capability_key', 'source', 'commercial_account_id', 'plan_ref', 'limit_kind', 'limit_value', 'effective_from', 'reason', 'actor_user_id', 'audit_log_id']
    for (const c of guarded) {
      expect(block, `NEW.${c} must be guarded`).toContain(`NEW.${c}`)
      expect(block, `OLD.${c} must be guarded`).toContain(`OLD.${c}`)
    }
    // EXACTLY TWELVE — effective_to is the one column an UPDATE may touch, and
    // including it here would forbid the legal close.
    expect((block.match(/NEW\.\w+/g) ?? []).length).toBe(12)
    expect(block).not.toMatch(/NEW\.effective_to/)
  })
})

/* ========================================================================== */
/* CE3-N-12 — the two prohibited couplings                                    */
/* ========================================================================== */

describe('CE3-N-12 — prohibited couplings are absent from the diff', () => {
  it('creates no trigger, rule or FK action on commercial_accounts (SC-15)', () => {
    expect(whole(/(CREATE|ALTER)\s+TRIGGER[^;]*ON\s+commercial_accounts/i)).toBe(false)
    expect(whole(/CREATE\s+RULE/i)).toBe(false)
    // Known-positive: the sweep DOES find the one trigger this unit creates.
    expect(whole(/CREATE TRIGGER[^;]*ON entitlement_grants/)).toBe(true)
  })

  it('creates no view, materialized view or rule over the relation', () => {
    expect(whole(/CREATE\s+(OR REPLACE\s+)?(MATERIALIZED\s+)?VIEW/i)).toBe(false)
  })
})

/* ========================================================================== */
/* The capability catalogue                                                   */
/* ========================================================================== */

describe('CE-3 capability catalogue', () => {
  it('the PRODUCTION catalogue is EXACTLY stella.grounded_query', () => {
    expect(ENTITLEMENT_CAPABILITY_KEYS).toEqual(['stella.grounded_query'])
    expect(ENTITLEMENT_CAPABILITY_CATALOGUE.length).toBe(1)
  })

  // EVERY ENTRY DECLARES ITS METERED SEMANTIC EXPLICITLY (SC-9). No outcome may
  // be derived from missing catalogue metadata, so the descriptor enumerates its
  // admissible kinds rather than leaving them to a default.
  it('every entry enumerates its admissible limit kinds explicitly', () => {
    for (const entry of ENTITLEMENT_CAPABILITY_CATALOGUE) {
      expect(entry.admissibleLimitKinds.length).toBeGreaterThan(0)
      for (const k of entry.admissibleLimitKinds) expect(ENTITLEMENT_LIMIT_KINDS).toContain(k)
    }
  })

  it('the single production capability can express ALL THREE metered states', () => {
    const d = describeCapability('stella.grounded_query')
    expect(d).toBeDefined()
    expect([...d!.admissibleLimitKinds].sort()).toEqual(['BLOCKED', 'CAPPED', 'UNMETERED'])
  })

  // ABSENCE IS NOT A LIMIT KIND. NO_LIVE_GRANT is what the evaluator ANSWERS
  // when no row matches; making it storable would let a "no grant" row exist,
  // which the partial unique index could not even keep unique.
  it('NO_LIVE_GRANT is NOT a member of the stored limit-kind vocabulary', () => {
    expect(ENTITLEMENT_LIMIT_KINDS).toEqual(['UNMETERED', 'BLOCKED', 'CAPPED'])
    expect(ENTITLEMENT_LIMIT_KINDS as readonly string[]).not.toContain('NO_LIVE_GRANT')
  })

  it('the four grant sources match the ratified closed set', () => {
    expect([...ENTITLEMENT_GRANT_SOURCES].sort()).toEqual(['BOOTSTRAP_DEFAULT', 'COMMERCIAL_EXCEPTION', 'PLAN', 'PLATFORM_ADMIN'])
  })

  // EXACT STRING EQUALITY, no normalisation. The value persisted in
  // capability_key is compared by the database with exact equality too, so a
  // catalogue that accepted other spellings would answer about a grant that can
  // never exist.
  it.each([
    'Stella.Grounded_Query',
    'stella.grounded_query ',
    ' stella.grounded_query',
    'stella.grounded_quer',
    'stella.grounded_queryy',
    'stella',
    '',
  ])('treats %j as UNDECLARED', (key) => {
    expect(isDeclaredCapabilityKey(key)).toBe(false)
    expect(describeCapability(key)).toBeUndefined()
  })

  it('declares the one production key', () => {
    expect(isDeclaredCapabilityKey('stella.grounded_query')).toBe(true)
  })

  it('does NOT edit lib/capabilities/contracts.ts — the CAP vocabulary is untouched', () => {
    const contracts = read('lib/capabilities/contracts.ts')
    expect(contracts).not.toMatch(/entitlement/i)
    expect(contracts).not.toMatch(/NO_LIVE_GRANT|UNMETERED|U0113|U0114/)
  })
})

/* ========================================================================== */
/* The evaluator's outcome mapping — exhaustive, deterministic, DB-free       */
/* ========================================================================== */

describe('CE3-P-8 / CE3-P-9 — evaluator outcome mapping', () => {
  /** Records every call, so purity and round-trip avoidance are measurable. */
  class RecordingExecutor implements EntitlementExecutor {
    calls: EntitlementQuery[] = []
    constructor(private readonly result: readonly EntitlementEffectiveRow[] | (() => never)) {}
    async effective(query: EntitlementQuery): Promise<readonly EntitlementEffectiveRow[]> {
      this.calls.push(query)
      const r = this.result
      if (typeof r === 'function') r()
      return r as readonly EntitlementEffectiveRow[]
    }
  }

  const sqlError = (code: string) => () => {
    const e = new Error('entitlement request refused') as Error & { code: string }
    e.code = code
    throw e
  }

  const QUERY: EntitlementQuery = { organizationId: 'org-1', capabilityKey: 'stella.grounded_query' }

  it.each([
    [{ kind: 'NO_LIVE_GRANT', limit_value: null }, { kind: 'NO_LIVE_GRANT' }],
    [{ kind: 'BLOCKED', limit_value: null }, { kind: 'BLOCKED' }],
    [{ kind: 'UNMETERED', limit_value: null }, { kind: 'UNMETERED' }],
    [{ kind: 'CAPPED', limit_value: 100 }, { kind: 'CAPPED', limitValue: 100 }],
    // CAPPED 0 is a CAP OF ZERO and is NOT BLOCKED. Collapsing them would
    // reintroduce the legacy stella_monthly_quota 0-means-blocked overload that
    // limit_kind exists to stop generalising.
    [{ kind: 'CAPPED', limit_value: 0 }, { kind: 'CAPPED', limitValue: 0 }],
  ] as [EntitlementEffectiveRow, EntitlementOutcome][])('maps %j to %j', async (row, expected) => {
    const exec = new RecordingExecutor([row])
    await expect(evaluateEntitlement(QUERY, exec)).resolves.toEqual(expected)
  })

  it('maps U0113 to REFUSED/CROSS_ORGANIZATION and U0114 to REFUSED/UNDECLARED_CAPABILITY', async () => {
    await expect(evaluateEntitlement(QUERY, new RecordingExecutor(sqlError(ENTITLEMENT_SQLSTATE.CROSS_ORGANIZATION))))
      .resolves.toEqual({ kind: 'REFUSED', reason: 'CROSS_ORGANIZATION' })
    await expect(evaluateEntitlement(QUERY, new RecordingExecutor(sqlError(ENTITLEMENT_SQLSTATE.UNDECLARED_CAPABILITY))))
      .resolves.toEqual({ kind: 'REFUSED', reason: 'UNDECLARED_CAPABILITY' })
  })

  // ANYTHING ELSE PROPAGATES. Folding an outage, a missing migration (42883), a
  // missing grant (42501) or a malformed uuid (22P02) into an entitlement
  // outcome would turn a deployment defect into a confident, wrong statement
  // about what an Organization is entitled to. This is mutation 9's detector.
  it.each(['42501', '42883', '22P02', '08006', '23505', 'U0001', 'U0112', 'U0115'])(
    'PROPAGATES SQLSTATE %s rather than folding it into an outcome',
    async (code) => {
      await expect(evaluateEntitlement(QUERY, new RecordingExecutor(sqlError(code)))).rejects.toThrow()
    },
  )

  it('refuses an UNDECLARED capability WITHOUT a database round trip', async () => {
    const exec = new RecordingExecutor([{ kind: 'UNMETERED', limit_value: null }])
    await expect(evaluateEntitlement({ organizationId: 'org-1', capabilityKey: 'nope.not_declared' }, exec))
      .resolves.toEqual({ kind: 'REFUSED', reason: 'UNDECLARED_CAPABILITY' })
    expect(exec.calls, 'an undeclared key must not reach the database').toEqual([])
  })

  // THE FIVE OUTCOMES ARE PAIRWISE DISTINCT. Any two collapsing fails this even
  // when each individual answer looks correct — which is precisely the shape of
  // the defect CE3-P-8 exists to catch.
  it('NO_LIVE_GRANT, BLOCKED, and both REFUSED reasons are four DIFFERENT values', async () => {
    const outcomes = [
      await evaluateEntitlement(QUERY, new RecordingExecutor([{ kind: 'NO_LIVE_GRANT', limit_value: null }])),
      await evaluateEntitlement(QUERY, new RecordingExecutor([{ kind: 'BLOCKED', limit_value: null }])),
      await evaluateEntitlement(QUERY, new RecordingExecutor(sqlError('U0113'))),
      await evaluateEntitlement(QUERY, new RecordingExecutor(sqlError('U0114'))),
    ]
    const serialized = outcomes.map((o) => JSON.stringify(o))
    expect(new Set(serialized).size).toBe(4)
  })

  it('the EXPLICIT organization argument is passed through unchanged', async () => {
    const exec = new RecordingExecutor([{ kind: 'UNMETERED', limit_value: null }])
    await evaluateEntitlement({ organizationId: 'org-XYZ', capabilityKey: 'stella.grounded_query' }, exec)
    expect(exec.calls).toEqual([{ organizationId: 'org-XYZ', capabilityKey: 'stella.grounded_query' }])
  })

  // FAIL CLOSED ON A SHAPE FAULT. Zero rows or several means the deployed
  // function is not the one this module was written against; reading that as
  // "nothing granted" would hide a broken deployment behind a plausible answer.
  it.each([[[]], [[{ kind: 'UNMETERED', limit_value: null }, { kind: 'BLOCKED', limit_value: null }]]])(
    'throws rather than answering when the function returns %j',
    async (rows) => {
      await expect(evaluateEntitlement(QUERY, new RecordingExecutor(rows as EntitlementEffectiveRow[]))).rejects.toThrow(/exactly one semantic answer row/)
    },
  )

  it('throws rather than inventing a number when CAPPED arrives without a limit_value', async () => {
    await expect(evaluateEntitlement(QUERY, new RecordingExecutor([{ kind: 'CAPPED', limit_value: null }])))
      .rejects.toThrow(/CAPPED without a limit_value/)
  })

  it('throws on an unrecognised kind rather than treating it as an answer', async () => {
    await expect(evaluateEntitlement(QUERY, new RecordingExecutor([{ kind: 'THROTTLED', limit_value: 1 }])))
      .rejects.toThrow(/unrecognised kind/)
  })

  // CE3-P-9 PURITY, measured as a DELTA over the executor's whole interaction:
  // exactly one read, no second call, and no write surface of any kind on the
  // executor interface.
  it('performs exactly ONE read per evaluation and offers no write surface', async () => {
    const exec = new RecordingExecutor([{ kind: 'CAPPED', limit_value: 5 }])
    await evaluateEntitlement(QUERY, exec)
    expect(exec.calls.length).toBe(1)
    const surface = Object.keys(Object.getPrototypeOf(exec)).concat(Object.keys(exec))
    expect(surface.filter((k) => /insert|update|delete|write|set|materiali/i.test(k))).toEqual([])
  })
})

describe('CE3-P-1 — the evaluator signature makes the organization IMPOSSIBLE to omit', () => {
  const SOURCE = read('lib/capabilities/entitlement-evaluator.ts')

  /**
   * CODE ONLY, comments stripped. The module's PROSE legitimately names
   * user_single_active_membership — it explains that an optional organization
   * would evaluate the wrong tenant the moment tenancy S7 removes that index —
   * and an absence control run over raw text would fire on that explanation.
   * A control that forbids describing the hazard is not a control.
   */
  const SOURCE_CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')

  it('declares organizationId and capabilityKey as REQUIRED readonly fields', () => {
    expect(SOURCE).toMatch(/readonly organizationId: string\n\s*readonly capabilityKey: string/)
  })

  // A SIGNATURE THAT PERMITTED OMITTING THE ORGANIZATION WOULD BE
  // NON-CONFORMANT EVEN IF EVERY CALL SITE PASSED ONE, because the evaluator
  // would then evaluate the WRONG TENANT — not fail — the moment tenancy S7
  // removes user_single_active_membership. Mutation CE3-M-4.
  it('declares no optional organization id and no ambient fallback', () => {
    expect(SOURCE_CODE).not.toMatch(/organizationId\?:/)
    expect(SOURCE_CODE).not.toMatch(/organizationId\s*\|\|/)
    expect(SOURCE_CODE).not.toMatch(/organizationId\s*\?\?/)
    for (const m of ['selectedOrganization', 'activeOrganization', 'firstMembership', 'user_single_active_membership', 'currentOrganization']) {
      expect(SOURCE_CODE, `${m} must not appear in evaluator CODE`).not.toContain(m)
    }
  })

  // The stripper is itself a control, so it gets a known-positive: it must
  // remove a string the prose really contains while leaving the code intact.
  it('the comment stripper removes prose and preserves code', () => {
    expect(SOURCE).toContain('user_single_active_membership')
    expect(SOURCE_CODE).not.toContain('user_single_active_membership')
    expect(SOURCE_CODE).toContain('export async function evaluateEntitlement(')
  })

  it('exports the symbol the enforcement boundary is measured against', () => {
    expect(typeof evaluateEntitlement).toBe('function')
    expect(SOURCE).toMatch(/export async function evaluateEntitlement\(/)
  })
})
