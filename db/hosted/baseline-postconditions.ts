// db/hosted/baseline-postconditions.ts
// TRAIN 5C0 — Phase 10. What CHECKPOINT B0 must verify, read-only, the moment
// the baseline finishes and before the bootstrap is even considered.
//
// ---------------------------------------------------------------------------
// THE PROBLEM WITH POSTCONDITIONS
// ---------------------------------------------------------------------------
// A postcondition that cannot fail is documentation wearing a check's clothes.
// The usual way one becomes unfalsifiable is that its expected value is derived
// from the same place as its observed value, so the comparison is a tautology —
// `expected.length === expected.length` with two extra steps.
//
// Two rules keep that from happening here:
//
//   1. THE EXPECTATION COMES FROM THE SQL, THE OBSERVATION COMES FROM THE
//      DATABASE. `deriveExpectedBaselineState()` walks the fifty manifest units,
//      scans their text, and accumulates what they SAY they create. The
//      observation is a separate structure the operator fills from catalog
//      queries. The two are produced by different processes from different
//      inputs, so disagreement is possible — which is the only thing that makes
//      agreement worth anything.
//
//   2. EVERY POSTCONDITION CARRIES AN EXECUTABLE NEGATIVE CONTROL. Not a
//      sentence describing what would break it: a `mutate()` that produces the
//      broken observation. The unit suite runs each check twice — once against
//      a conforming observation, once against its own mutation — and fails the
//      build if a check passes both times. A decorative postcondition cannot
//      survive that, because a check that ignores its input passes its own
//      negative control.

import { BASELINE_UNITS } from './baseline-manifest'
import { scanBaselineSql } from './baseline-scanner'

/**
 * A read-only picture of the database after the baseline.
 *
 * Deliberately flat strings rather than nested catalog objects: an operator
 * fills this from nine `psql -c` queries, and every extra level of structure is
 * another place for a transcription to go wrong silently.
 */
export interface BaselineObservation {
  /** `SELECT nspname FROM pg_namespace` */
  readonly schemas: readonly string[]
  /** `public.users`, … */
  readonly tables: readonly string[]
  /** `public.users` -> its column names. Only the probed tables need entries. */
  readonly columns: Readonly<Record<string, readonly string[]>>
  /** Constraint names, unqualified as PostgreSQL reports them. */
  readonly constraints: readonly string[]
  /** `public.current_user_org_ids`, … */
  readonly functions: readonly string[]
  /** Trigger names. */
  readonly triggers: readonly string[]
  /** Tables with `relrowsecurity` true. */
  readonly rlsEnabledTables: readonly string[]
  /** `public.users.users_select_self`, … */
  readonly policies: readonly string[]
  /** `SELECT rolname FROM pg_roles` */
  readonly roles: readonly string[]
  /**
   * `grantee:PRIVILEGE:relation`, e.g. `anon:INSERT:public.marketing_leads`.
   * Only the grants the checks below ask about need to be present.
   */
  readonly grants: readonly string[]
  /** Row counts per table, from `count(*)`. Every probed table must appear. */
  readonly rowCounts: Readonly<Record<string, number>>
  readonly extensions: readonly string[]
  /** `SELECT id FROM storage.buckets` */
  readonly storageBuckets: readonly string[]
  /**
   * Secret NAMES — never values — configured for every deployment pointing at
   * this database. `null` means not inventoried, which B0-14 refuses.
   */
  readonly environmentSecretNames: readonly string[] | null
}

export interface PostconditionResult {
  readonly passed: boolean
  readonly detail: string
}

export interface BaselinePostcondition {
  readonly id: string
  /** What must be true, in one sentence an operator can read at 2am. */
  readonly requirement: string
  /** The read-only query that produces the evidence. Never a write. */
  readonly probeSql: string
  check: (observed: BaselineObservation, expected: ExpectedBaselineState) => PostconditionResult
  /**
   * A state in which this check MUST fail. Executable on purpose — see the
   * header. `mutate` receives a conforming observation and returns a broken one.
   */
  readonly negativeControl: {
    readonly description: string
    mutate: (conforming: BaselineObservation) => BaselineObservation
  }
}

/** What the fifty units, read as text, say the database should contain. */
export interface ExpectedBaselineState {
  readonly tables: readonly string[]
  readonly functions: readonly string[]
  readonly triggers: readonly string[]
  readonly rlsEnabledTables: readonly string[]
  readonly policies: readonly string[]
}

/**
 * Derives the expectation from the corpus.
 *
 * Uses the SAME reader the runner uses, so a unit the runner would apply and a
 * unit this expects are the same set by construction. What it deliberately does
 * NOT do is consult the manifest's `expect` block: those are pinned COUNTS, and
 * checking observed names against pinned counts would compare two things that
 * cannot disagree in the way that matters.
 */
export function deriveExpectedBaselineState(
  readSql: (file: string) => string | null,
): ExpectedBaselineState {
  const tables = new Set<string>()
  const functions = new Set<string>()
  const triggers = new Set<string>()
  const rls = new Set<string>()
  const policies = new Set<string>()

  for (const unit of BASELINE_UNITS) {
    const sql = readSql(unit.file)
    if (sql === null) continue
    const facts = scanBaselineSql(sql)
    for (const t of facts.tablesCreated) tables.add(t)
    for (const f of facts.functionsCreated) functions.add(f)
    for (const t of facts.triggersCreated) triggers.add(t)
    for (const t of facts.rlsEnabledTables) rls.add(t)
    // A policy DROPPED after being created is not part of the end state. 0031
    // issues 71 drops against 69 creates precisely because two policies from an
    // earlier shape are retired, and an expectation that ignored the drops would
    // demand two policies the baseline deliberately removes.
    for (const p of facts.policiesCreated) policies.add(p)
  }

  // Second pass for retirement: a policy dropped by a LATER unit and never
  // re-created is gone. Order matters, so this cannot be folded into the loop
  // above without making the result depend on Set iteration order.
  const finalPolicies = new Set<string>()
  for (const unit of BASELINE_UNITS) {
    const sql = readSql(unit.file)
    if (sql === null) continue
    const facts = scanBaselineSql(sql)
    for (const p of facts.policiesDropped) finalPolicies.delete(p)
    for (const p of facts.policiesCreated) finalPolicies.add(p)
  }

  return {
    tables: [...tables].sort(),
    functions: [...functions].sort(),
    triggers: [...triggers].sort(),
    rlsEnabledTables: [...rls].sort(),
    policies: [...finalPolicies].sort(),
  }
}

const missingFrom = (expected: readonly string[], observed: readonly string[]): string[] => {
  const have = new Set(observed)
  return expected.filter((e) => !have.has(e))
}

/** Columns whose absence would be a silent correctness failure, with the reason. */
const CRITICAL_COLUMNS: readonly (readonly [string, string, string])[] = [
  ['public.users', 'is_super_admin', 'every RLS helper in 0031 reads it; without it current_user_is_super_admin() cannot compile'],
  ['public.stella_interactions', 'organization_id', 'the ledger is org-scoped; stella_0013 indexes on it'],
  ['public.project_investments', 'funder_id', '0018 sets it NOT NULL after backfill — a nullable column means the backfill half-ran'],
  ['public.project_investments', 'amount_usd', 'Fase 1 FX; portfolio aggregation reads only USD'],
  ['public.financial_proxies', 'value_usd', 'the tightened approved_proxy_check requires it'],
  ['public.marketing_leads', 'email', 'the PII column policy 008 exists to protect'],
]

/** Constraints that encode an invariant rather than a shape. */
const CRITICAL_CONSTRAINTS: readonly (readonly [string, string])[] = [
  ['approved_proxy_check', '0018 tightened it to require value_usd on approved proxies'],
  ['project_investments_contribution_type_check', 'cash | in_kind, nothing else'],
  ['project_investments_in_kind_notes_check', 'an in-kind contribution without valuation notes is unauditable'],
  ['organizations_slug_unique', 'tenancy depends on the slug being unique'],
  ['users_email_unique', 'the login path does INSERT ... ON CONFLICT on it'],
]

export const BASELINE_POSTCONDITIONS: readonly BaselinePostcondition[] = [
  {
    id: 'B0-01-schemas',
    requirement:
      'Exactly the schemas a managed Supabase project plus the Uellix baseline produce. public present; ' +
      'NO uellix_* schema of any kind — the baseline creates none, and one appearing here means a Stella ' +
      'package ran early.',
    probeSql: `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY 1;`,
    check(observed) {
      if (!observed.schemas.includes('public')) {
        return { passed: false, detail: 'schema public is absent' }
      }
      const uellix = observed.schemas.filter((s) => s.startsWith('uellix_'))
      return uellix.length === 0
        ? { passed: true, detail: 'public present; no uellix_* schema exists yet, as the baseline creates none' }
        : { passed: false, detail: `uellix schema(s) already present after the BASELINE phase: ${uellix.join(', ')}. Nothing in the fifty baseline units creates one; this database has had Stella run against it.` }
    },
    negativeControl: {
      description: 'a database where uellix_bootstrap already exists must fail B0-01',
      mutate: (o) => ({ ...o, schemas: [...o.schemas, 'uellix_bootstrap'] }),
    },
  },
  {
    id: 'B0-02-tables',
    requirement: 'Every table the fifty units create exists.',
    probeSql: `SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;`,
    check(observed, expected) {
      const missing = missingFrom(expected.tables, observed.tables)
      return missing.length === 0
        ? { passed: true, detail: `all ${expected.tables.length} baseline tables present` }
        : { passed: false, detail: `missing ${missing.length} table(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}. A missing table means a unit aborted; the chain is not resumable — see the recovery plan.` }
    },
    negativeControl: {
      description: 'dropping public.projects from the observation must fail B0-02',
      mutate: (o) => ({ ...o, tables: o.tables.filter((t) => t !== 'public.projects') }),
    },
  },
  {
    id: 'B0-03-critical-columns',
    requirement: 'The columns whose absence would be a silent correctness failure, not a loud one.',
    probeSql: `SELECT table_schema||'.'||table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2;`,
    check(observed) {
      const missing = CRITICAL_COLUMNS.filter(
        ([table, column]) => !(observed.columns[table] ?? []).includes(column),
      )
      return missing.length === 0
        ? { passed: true, detail: `all ${CRITICAL_COLUMNS.length} critical columns present` }
        : { passed: false, detail: missing.map(([t, c, why]) => `${t}.${c} — ${why}`).join('; ') }
    },
    negativeControl: {
      description: 'removing users.is_super_admin must fail B0-03',
      mutate: (o) => ({
        ...o,
        columns: { ...o.columns, 'public.users': (o.columns['public.users'] ?? []).filter((c) => c !== 'is_super_admin') },
      }),
    },
  },
  {
    id: 'B0-04-constraints',
    requirement: 'The constraints that encode an invariant survived the backfill in 0018.',
    probeSql: `SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY 1;`,
    check(observed) {
      const missing = CRITICAL_CONSTRAINTS.filter(([name]) => !observed.constraints.includes(name))
      return missing.length === 0
        ? { passed: true, detail: `all ${CRITICAL_CONSTRAINTS.length} invariant constraints present` }
        : { passed: false, detail: missing.map(([n, why]) => `${n} — ${why}`).join('; ') }
    },
    negativeControl: {
      description: 'dropping approved_proxy_check must fail B0-04',
      mutate: (o) => ({ ...o, constraints: o.constraints.filter((c) => c !== 'approved_proxy_check') }),
    },
  },
  {
    id: 'B0-05-functions',
    requirement: 'Every function the corpus defines exists — including the two storage helpers 0039 grants on.',
    probeSql: `SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1;`,
    check(observed, expected) {
      const missing = missingFrom(expected.functions, observed.functions)
      return missing.length === 0
        ? { passed: true, detail: `all ${expected.functions.length} baseline functions present` }
        : { passed: false, detail: `missing: ${missing.join(', ')}. If can_read_evidence_object or can_write_evidence_object is in that list, the Supabase migration units were skipped and 0039 could not have succeeded.` }
    },
    negativeControl: {
      description: 'removing can_read_evidence_object must fail B0-05 — this is the 0039 ordering defect',
      mutate: (o) => ({ ...o, functions: o.functions.filter((f) => f !== 'public.can_read_evidence_object') }),
    },
  },
  {
    id: 'B0-06-triggers',
    requirement: 'The three append-only triggers and the two auth.users sync triggers exist.',
    probeSql: `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;`,
    check(observed, expected) {
      const missing = missingFrom(expected.triggers, observed.triggers)
      return missing.length === 0
        ? { passed: true, detail: `all ${expected.triggers.length} triggers present` }
        : { passed: false, detail: `missing: ${missing.join(', ')}. trg_*_append_only missing means audit_logs and the SROI ledgers are mutable.` }
    },
    negativeControl: {
      description: 'removing trg_audit_logs_append_only must fail B0-06',
      mutate: (o) => ({ ...o, triggers: o.triggers.filter((t) => t !== 'trg_audit_logs_append_only') }),
    },
  },
  {
    id: 'B0-07-rls-enabled',
    requirement: 'Every table the corpus switches RLS on has it on. RLS off on one table is a silent read of the whole tenancy.',
    probeSql: `SELECT schemaname||'.'||tablename FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename WHERE c.relrowsecurity AND schemaname='public' ORDER BY 1;`,
    check(observed, expected) {
      const missing = missingFrom(expected.rlsEnabledTables, observed.rlsEnabledTables)
      return missing.length === 0
        ? { passed: true, detail: `RLS enabled on all ${expected.rlsEnabledTables.length} tables the corpus names` }
        : { passed: false, detail: `RLS NOT enabled on: ${missing.join(', ')}. marketing_leads in this list means policy 008 never ran — it is the only unit that enables it.` }
    },
    negativeControl: {
      description: 'RLS off on marketing_leads must fail B0-07 — the A2-step-008 failure mode',
      mutate: (o) => ({ ...o, rlsEnabledTables: o.rlsEnabledTables.filter((t) => t !== 'public.marketing_leads') }),
    },
  },
  {
    id: 'B0-08-policies',
    requirement: 'Every policy the corpus leaves in place exists, counting the ones it retires.',
    // BOTH schemas. The local rehearsal caught this probe scoped to `public`
    // alone, which silently excused the three storage.objects policies that
    // 20260716000001 creates — the evidence-bucket read/write gate. A probe
    // narrower than the expectation reports a clean pass for objects it never
    // looked at.
    probeSql: `SELECT schemaname||'.'||tablename||'.'||policyname FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY 1;`,
    check(observed, expected) {
      const missing = missingFrom(expected.policies, observed.policies)
      return missing.length === 0
        ? { passed: true, detail: `all ${expected.policies.length} end-state policies present` }
        : { passed: false, detail: `missing ${missing.length}: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}` }
    },
    negativeControl: {
      description: 'removing one policy must fail B0-08',
      mutate: (o) => ({ ...o, policies: o.policies.slice(1) }),
    },
  },
  {
    id: 'B0-09-roles',
    requirement:
      'anon / authenticated / service_role exist because Supabase creates them. NO uellix_* role exists: ' +
      'the baseline creates none, and stella_hosted_0001 has not run.',
    probeSql: `SELECT rolname FROM pg_roles ORDER BY 1;`,
    check(observed) {
      const required = ['anon', 'authenticated', 'service_role']
      const missing = required.filter((r) => !observed.roles.includes(r))
      if (missing.length > 0) {
        return { passed: false, detail: `Supabase roles absent: ${missing.join(', ')}. 0033 grants to all three and would have raised 42704.` }
      }
      const premature = observed.roles.filter((r) => r.startsWith('uellix_'))
      return premature.length === 0
        ? { passed: true, detail: 'the three Supabase roles exist; no uellix_* role exists yet' }
        : { passed: false, detail: `uellix role(s) already present: ${premature.join(', ')}. The baseline creates no roles — verified by BASELINE_GLOBAL_INVARIANTS.roleStatements === 0.` }
    },
    negativeControl: {
      description: 'uellix_owner existing after the baseline must fail B0-09',
      mutate: (o) => ({ ...o, roles: [...o.roles, 'uellix_owner'] }),
    },
  },
  {
    id: 'B0-10-no-anon-write-surface',
    requirement:
      'Neither anon NOR PUBLIC holds any table privilege in schema public. Policy 008 allows an anon ' +
      'INSERT at the RLS layer; the grant layer is the first gate and is what keeps it inert.',
    // aclexplode, NOT information_schema.role_table_grants.
    //
    // Adversarial review A caught this against the repository's own rule:
    // db/audit/canonical_acl.sql BANS that view as a gate criterion, and gives
    // the measured reason — "IT CANNOT EXPRESS PUBLIC. The PUBLIC grantee is OID
    // 0 … the view simply omits it. An expectation of the form 'for PUBLIC: no
    // rows' is therefore UNFALSIFIABLE — it is satisfied by a database where
    // PUBLIC holds everything."
    //
    // Privileges granted to PUBLIC are held by anon. So the one check standing
    // between `TO anon WITH CHECK (true)` and an unauthenticated public write
    // path had a documented blind spot for exactly the grantee that would open
    // it. COALESCE(relacl, acldefault(...)) is required too: a NULL relacl means
    // "the built-in default", not "no privileges".
    probeSql: `SELECT COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC')||':'||a.privilege_type||':'||n.nspname||'.'||c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) = 'anon')
  ORDER BY 1;`,
    check(observed) {
      const exposed = observed.grants.filter((g) => g.startsWith('anon:') || g.startsWith('PUBLIC:'))
      return exposed.length === 0
        ? {
            passed: true,
            detail:
              'neither anon nor PUBLIC holds a table privilege anywhere in public; the 008 INSERT policy ' +
              'is a second gate with no first gate behind it',
          }
        : {
            passed: false,
            detail: `exposed to an unauthenticated caller: ${exposed.join(', ')}. A PUBLIC grant is held by anon. If any of these names marketing_leads, staging has an unauthenticated public write path.`,
          }
    },
    negativeControl: {
      // The mutation uses PUBLIC rather than anon on purpose: it is the grantee
      // the previous probe could not see at all, so it also proves the new probe
      // shape is what is being exercised.
      description: 'a GRANT INSERT … TO PUBLIC on marketing_leads must fail B0-10',
      mutate: (o) => ({ ...o, grants: [...o.grants, 'PUBLIC:INSERT:public.marketing_leads'] }),
    },
  },
  {
    id: 'B0-14-no-service-role-key',
    requirement:
      'SUPABASE_SERVICE_ROLE_KEY is absent from every environment pointing at this database. 0033 grants ' +
      'service_role ALL PRIVILEGES on every table in public, including the PII in marketing_leads; the ' +
      'grant is inert only while nobody can authenticate as that role.',
    // Adversarial review A: the manifest CLAIMED "the baseline postconditions
    // assert the key's ABSENCE from the environment", and no such postcondition
    // existed. A named safeguard that was never built is worse than no
    // safeguard, because an auditor reads the claim and stops looking.
    //
    // This one is not a catalog query. It is an operator attestation, and it says
    // so — `environmentSecretNames` is filled by a human reading the secret
    // manager. That is weaker than a probe and it is the strongest thing
    // available: the key lives in Vercel, not in PostgreSQL.
    probeSql: `-- NOT a database question. Operator: list the secret NAMES (never values)
-- configured for every deployment that points at this project, and supply them
-- as observation.environmentSecretNames. Do not paste any value anywhere.`,
    check(observed) {
      const names = observed.environmentSecretNames
      if (names === null) {
        return {
          passed: false,
          detail:
            'no environment secret inventory supplied. "Not checked" is not "absent" — and this is the ' +
            'only control standing between the 0033 service_role grant and a principal who can use it.',
        }
      }
      const forbidden = names.filter((n) =>
        ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_GEMINI_API_KEY'].includes(n.trim()),
      )
      return forbidden.length === 0
        ? {
            passed: true,
            detail: `${names.length} secret name(s) declared; neither SUPABASE_SERVICE_ROLE_KEY nor NEXT_PUBLIC_GEMINI_API_KEY is among them`,
          }
        : {
            passed: false,
            detail: `forbidden secret(s) provisioned: ${forbidden.join(', ')}. §4.4 of the provisioning requirements forbids both, and for SUPABASE_SERVICE_ROLE_KEY the reason is 0033: the role already holds ALL on every table in public.`,
          }
    },
    negativeControl: {
      description: 'SUPABASE_SERVICE_ROLE_KEY present in the environment must fail B0-14',
      mutate: (o) => ({
        ...o,
        environmentSecretNames: [...(o.environmentSecretNames ?? []), 'SUPABASE_SERVICE_ROLE_KEY'],
      }),
    },
  },
  {
    id: 'B0-15-evidence-bucket-exists',
    requirement:
      "The 'uellix-evidence' Storage bucket exists. All three storage.objects policies gate on it, and " +
      'NOTHING in the fifty units creates it.',
    // Adversarial review A. supabase/config.toml declares
    // [storage.buckets.uellix-evidence], so the local CLI creates it at start;
    // no baseline unit, provisioning step or nextAction mentions it. A staging
    // project provisioned exactly to plan would have evidence policies guarding
    // a bucket that does not exist, and every upload and read would fail for a
    // reason no check looked for. Identical in shape to the 0039 defect: a thing
    // `supabase start` does for us locally and nobody does hosted.
    probeSql: `SELECT id FROM storage.buckets WHERE id = 'uellix-evidence';`,
    check(observed) {
      return observed.storageBuckets.includes('uellix-evidence')
        ? { passed: true, detail: "the 'uellix-evidence' bucket exists, so the three storage policies guard something" }
        : {
            passed: false,
            detail:
              "the 'uellix-evidence' bucket does NOT exist. 0031:424 states it must be created in " +
              'Supabase Storage; supabase/config.toml creates it locally and no hosted step does. Create ' +
              'it in the dashboard before treating evidence upload as working.',
          }
    },
    negativeControl: {
      description: 'a project without the uellix-evidence bucket must fail B0-15',
      mutate: (o) => ({ ...o, storageBuckets: o.storageBuckets.filter((b) => b !== 'uellix-evidence') }),
    },
  },
  {
    id: 'B0-11-zero-production-data',
    requirement: 'Every probed table holds zero rows. The baseline creates schema, not tenants.',
    // count(*), NOT n_live_tup.
    //
    // Adversarial review A found this file contradicting its own rehearsal:
    // scripts/baseline-rehearsal-local.ts already refuses n_live_tup with the
    // comment "the statistics collector has not necessarily run on a database
    // created seconds ago, and an unanalysed table reports 0 whether or not it
    // holds rows". Handing the hosted operator the query the rehearsal rejects
    // fails OPEN in the dangerous direction: a restored production dump with
    // stale statistics reports zeros, and the check whose stated job is to
    // "distinguish a new staging project from a restored production dump"
    // certifies the dump.
    // Generate the UNION ALL from the expected table set and run it as one
    // statement, so the counts arrive together and none can be forgotten:
    //
    //   SELECT 'public.users' AS t, count(*) FROM public.users
    //   UNION ALL SELECT 'public.organizations', count(*) FROM public.organizations
    //   ... one arm per table the fifty units create ...
    //
    // `pnpm baseline:report` lists the table set. Do not substitute
    // pg_stat_user_tables.
    probeSql: `SELECT 'public.users' AS t, count(*) FROM public.users
UNION ALL SELECT 'public.organizations', count(*) FROM public.organizations
-- … one arm per table in the derived expectation; see the comment above.
ORDER BY 1;`,
    check(observed, expected) {
      // COVERAGE FIRST. Reviewer B's attack on the runner's probe set applies
      // here identically: a partially-restored production copy whose tenancy
      // tables are empty passes any check that only looks at the tables it was
      // handed. So the requirement is every table the corpus creates, and a
      // missing one is a failure rather than a smaller sample.
      const unmeasured = expected.tables.filter((t) => typeof observed.rowCounts[t] !== 'number')
      if (unmeasured.length > 0) {
        return {
          passed: false,
          detail: `${unmeasured.length} of ${expected.tables.length} baseline tables were not counted: ${unmeasured.slice(0, 6).join(', ')}${unmeasured.length > 6 ? ' …' : ''}. "Not measured" is not "empty", and a subset-restore of production would pass a partial probe.`,
        }
      }
      const populated = Object.entries(observed.rowCounts).filter(([, n]) => n !== 0)
      return populated.length === 0
        ? { passed: true, detail: `all ${expected.tables.length} baseline tables counted, all zero` }
        : { passed: false, detail: `${populated.map(([t, n]) => `${t}=${n}`).join(', ')}. 0018 is the baseline's only DML and it is a SELECT-driven backfill: on an empty database it writes nothing. Rows here did not come from the baseline.` }
    },
    negativeControl: {
      description: 'one row in public.organizations must fail B0-11',
      mutate: (o) => ({ ...o, rowCounts: { ...o.rowCounts, 'public.organizations': 1 } }),
    },
  },
  {
    id: 'B0-12-no-stella-surface',
    requirement:
      'No Stella object exists. public.stella_interactions is the LEDGER and is baseline — 0012 creates it — ' +
      'so its presence is required, not forbidden. What must be absent is the capability surface.',
    probeSql: `SELECT nspname FROM pg_namespace WHERE nspname IN ('uellix_stella','uellix_stella_ops','uellix_grounding','uellix_bootstrap');`,
    check(observed) {
      const STELLA_SCHEMAS = ['uellix_stella', 'uellix_stella_ops', 'uellix_grounding', 'uellix_bootstrap']
      const present = STELLA_SCHEMAS.filter((s) => observed.schemas.includes(s))
      if (present.length > 0) {
        return { passed: false, detail: `Stella capability schema(s) present before the bootstrap phase: ${present.join(', ')}` }
      }
      if (!observed.tables.includes('public.stella_interactions')) {
        return { passed: false, detail: 'public.stella_interactions is MISSING. It is baseline (0012), not Stella; stella_hosted_0001 alters its owner and would abort without it.' }
      }
      return { passed: true, detail: 'no Stella capability schema exists; the baseline ledger public.stella_interactions is present as 0012 leaves it' }
    },
    negativeControl: {
      description: 'uellix_stella existing must fail B0-12',
      mutate: (o) => ({ ...o, schemas: [...o.schemas, 'uellix_stella'] }),
    },
  },
  {
    id: 'B0-13-no-extensions-added',
    requirement:
      'The baseline installs no extension. Whatever the project has is what Supabase shipped, and a new ' +
      'one here means something outside the fifty units ran.',
    probeSql: `SELECT extname FROM pg_extension ORDER BY 1;`,
    check(observed) {
      // ALLOWLIST, not denylist.
      //
      // This was a five-name denylist — plpython3u, plperlu, file_fdw,
      // postgres_fdw, dblink — and adversarial review B showed why that is the
      // wrong shape for a check whose requirement is "the baseline installs no
      // extension". A denylist fails OPEN: `http`, `pg_net`, `pgjwt`, or a
      // private C extension are all outside the five names and all report
      // `passed: true`, including ones with genuine outbound-network capability.
      // Worse, the negative control only ever mutated with a name the check
      // already knew, so the gap could never surface.
      //
      // Inverting it makes the check fail CLOSED: anything unrecognised is a
      // finding. The cost is that a Supabase platform bump adding a stock
      // extension shows up here — which is the correct outcome for a checkpoint
      // whose job is "nothing changed that we did not expect", and a two-word
      // edit to fix.
      //
      // The list is what a stock managed Supabase project ships. It is NOT
      // derived from the corpus, because the corpus installs nothing:
      // BASELINE_GLOBAL_INVARIANTS.extensionStatements === 0 covers the SQL, and
      // this covers the live database, which is a different question.
      const STOCK_SUPABASE_EXTENSIONS = new Set([
        'plpgsql',
        'pgcrypto',
        'uuid-ossp',
        'pgjwt',
        'pg_graphql',
        'pg_stat_statements',
        'pgsodium',
        'supabase_vault',
        'pg_net',
      ])
      const unexpected = observed.extensions.filter((e) => !STOCK_SUPABASE_EXTENSIONS.has(e))
      return unexpected.length === 0
        ? {
            passed: true,
            detail: `${observed.extensions.length} extension(s), every one of them stock for a managed Supabase project; the fifty units install none`,
          }
        : {
            passed: false,
            detail:
              `extension(s) present that a stock managed project does not ship: ${unexpected.join(', ')}. ` +
              `The baseline installs none, so each of these arrived by some other route. Confirm what ` +
              `installed it before proceeding; if it is a new Supabase default, add it to the allowlist ` +
              `deliberately.`,
          }
    },
    negativeControl: {
      // Deliberately an extension the OLD denylist did not contain — that is the
      // gap this rewrite closes, so exercising it is the point.
      description: 'an unrecognised extension such as `http` must fail B0-13',
      mutate: (o) => ({ ...o, extensions: [...o.extensions, 'http'] }),
    },
  },
]

export interface PostconditionReport {
  readonly id: string
  readonly passed: boolean
  readonly detail: string
  readonly requirement: string
}

export function evaluateBaselinePostconditions(
  observed: BaselineObservation,
  expected: ExpectedBaselineState,
): readonly PostconditionReport[] {
  return BASELINE_POSTCONDITIONS.map((p) => {
    const result = p.check(observed, expected)
    return { id: p.id, passed: result.passed, detail: result.detail, requirement: p.requirement }
  })
}
