// db/hosted/baseline-apply-authorization.ts
// TRAIN 5C1 — Phase 10. The one question this whole programme has been building
// toward: MAY the first hosted write be authorised?
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE MEANS, AND THE THING IT DOES NOT MEAN
// ---------------------------------------------------------------------------
// `hosted-baseline-apply-authorized` says: every precondition that can be
// established has been, so a human may now choose to run PHASE_BASELINE.
//
// It does NOT say `baselineApplied`. It does not say the baseline will succeed,
// and it is not itself the authorisation — Lorenzo is. It is the statement that
// nothing known is in the way.
//
// ---------------------------------------------------------------------------
// NO SELF-ASSERTED BOOLEANS
// ---------------------------------------------------------------------------
// The failure mode this module is designed against is the one adversarial review
// kept finding in Train 5C0: a check whose input is a value somebody typed to
// mean "yes". Three rules keep it out.
//
//   1. Anything derivable from the repository is DERIVED here, on every
//      evaluation, by doing the work — verifying the manifest, scanning the
//      corpus, driving the recovery table, running the postconditions against
//      their own negative controls.
//
//   2. Anything that can only be known by looking at the hosted project is an
//      ATTESTATION with provenance: who measured it, with which query, and when.
//      An attestation with no query recorded is refused, because "I checked" is
//      not evidence and this module cannot tell the difference between a probe
//      result and a hopeful default.
//
//   3. ABSENCE IS REFUSAL, everywhere, with no exception. Train 5B learned it
//      with `installedProbes` failing open; Train 5C0 learned it again with an
//      emptiness set that only looked at the tables it was handed. Not measured
//      is not satisfied.
//
// Every criterion carries an executable negative control, and the gate's own
// test drives each one against its own mutation. A criterion that ignored its
// input would pass its mutation and fail the suite.

import {
  BASELINE_UNITS,
  verifyBaselineManifest,
  verifyBaselineOrder,
  type BaselineUnit,
} from './baseline-manifest'
import { scanBaselineSql } from './baseline-scanner'
import {
  BASELINE_POSTCONDITIONS,
  deriveExpectedBaselineState,
  type BaselinePostcondition,
} from './baseline-postconditions'
import { decideRecovery as realDecideRecovery } from './baseline-recovery'
import {
  CLASS_C_PROBES,
  STELLA_FEATURE_FLAGS,
  deriveEmptinessProbes,
  type PrivilegeProbes,
} from './hosted-provisioning-runner'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  productionDenylistStatus,
  projectRefFromHost,
  type ProductionIdentifiers,
} from './target-identity'

/**
 * A fact about the hosted project, measured by a human, recorded with its query.
 *
 * `query` is not decoration. It is what separates "the operator ran the probe
 * §2.7 specifies" from "the operator ran something and reported a boolean", and
 * the two have different worth. A criterion below refuses an attestation whose
 * query does not match what the requirements document asks for.
 */
export interface OperatorAttestation<T> {
  readonly value: T
  /** The exact SQL (or the documented non-SQL procedure) that produced it. */
  readonly query: string
  /** Free-text provenance: who, where, when. Never a credential. */
  readonly measuredBy: string
}

export interface ApplyAuthorizationInputs {
  /* ---- Repository, derived on every evaluation ---- */
  readonly readBaselineSql: (file: string) => string | null
  readonly discoveredBaselineFiles: readonly string[]
  readonly production: ProductionIdentifiers
  /**
   * The unit list and the recovery function, injectable and defaulted.
   *
   * Not configurability — FALSIFIABILITY. Two criteria below reason over module
   * constants (`BASELINE_UNITS.managed`, and what `decideRecovery` answers), and
   * a criterion that reads a constant cannot be made to fail by any input, so it
   * passes its own negative control and is decorative by construction. The first
   * run of this file's negative-control sweep caught exactly that in exactly
   * these two. Injecting them is what turns "no class D units" and "recovery is
   * conservative" from assertions into measurements.
   */
  readonly units?: readonly BaselineUnit[]
  readonly decide?: typeof realDecideRecovery
  readonly postconditions?: readonly BaselinePostcondition[]

  /* ---- Hosted facts, attested. null = NOT MEASURED = refused ---- */
  /** CHECKPOINT A0, the read-only pre-bootstrap inspection. */
  readonly checkpointA0: OperatorAttestation<{
    readonly result: 'PASS' | 'FAIL'
    readonly sessionWasReadOnly: boolean
    readonly projectIsNew: boolean
    readonly stellaSurfaceAbsent: boolean
    readonly writesPerformed: number
  }> | null
  /** The three class-C probes of §2.7. */
  readonly classCProbes: OperatorAttestation<PrivilegeProbes> | null
  /** The staging project ref, and the host it was derived from. Not secret. */
  readonly stagingIdentity: OperatorAttestation<{
    readonly declaredEnvironment: string
    readonly projectRef: string
    readonly connectionHost: string
  }> | null
  /** The nine flags, as configured for every deployment pointing at the target. */
  readonly featureFlags: OperatorAttestation<Readonly<Record<string, string | boolean | undefined>>> | null
}

export interface AuthorizationVerdict {
  readonly id: string
  readonly satisfied: boolean
  readonly detail: string
}

interface Criterion {
  readonly id: string
  readonly requirement: string
  evaluate: (inputs: ApplyAuthorizationInputs) => AuthorizationVerdict
  readonly negativeControl: {
    readonly description: string
    mutate: (satisfying: ApplyAuthorizationInputs) => ApplyAuthorizationInputs
  }
}

const yes = (id: string, detail: string): AuthorizationVerdict => ({ id, satisfied: true, detail })
const no = (id: string, detail: string): AuthorizationVerdict => ({ id, satisfied: false, detail })

/** Collapses whitespace so a reformatted query still matches its canonical form. */
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Provenance, required of EVERY attestation.
 *
 * The header's rule 2 said an attestation with no recorded query is refused, and
 * adversarial review found it implemented for exactly one of the four — so three
 * of them accepted `{ value: {...}, query: '', measuredBy: '' }`, which is
 * precisely the "hopeful default a script constructed from config" the rule
 * exists to distinguish from a measurement. One helper, applied to all four.
 */
function attested<T>(
  id: string,
  what: string,
  a: OperatorAttestation<T> | null,
): AuthorizationVerdict | null {
  if (!a) return no(id, `${what} — NOT MEASURED. Not measured is not satisfied.`)
  if (!a.query.trim()) return no(id, `${what} records no query. "I checked" is not evidence.`)
  if (!a.measuredBy.trim()) return no(id, `${what} records no provenance: nobody is named as having measured it.`)
  return null
}

export const APPLY_AUTHORIZATION_CRITERIA: readonly Criterion[] = [
  /* ------------------------------------------------------------------ */
  {
    id: 'checkpoint-a0-pass',
    requirement:
      'CHECKPOINT A0 ran read-only against the target and returned PASS, with zero writes.',
    evaluate(inputs) {
      const id = 'checkpoint-a0-pass'
      const missing = attested(id, 'CHECKPOINT A0', inputs.checkpointA0)
      if (missing) return missing
      const a = inputs.checkpointA0!
      if (a.value.result !== 'PASS') return no(id, `A0 returned ${a.value.result}.`)
      if (!a.value.sessionWasReadOnly) {
        return no(id, 'A0 was not run in a read-only session, so it cannot testify that it changed nothing.')
      }
      if (a.value.writesPerformed !== 0) {
        return no(id, `A0 reports ${a.value.writesPerformed} write(s). A0 that wrote is not A0.`)
      }
      if (!a.value.projectIsNew || !a.value.stellaSurfaceAbsent) {
        return no(id, `A0 did not confirm a new project free of Stella surface (new=${a.value.projectIsNew}, stellaAbsent=${a.value.stellaSurfaceAbsent}).`)
      }
      return yes(id, `A0 PASS, read-only, zero writes, new project, no Stella surface — attested by ${a.measuredBy}`)
    },
    negativeControl: {
      description: 'an A0 that performed a single write must fail',
      mutate: (i) => ({
        ...i,
        checkpointA0: i.checkpointA0 && {
          ...i.checkpointA0,
          value: { ...i.checkpointA0.value, writesPerformed: 1 },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'production-denylist-loaded',
    requirement:
      'KNOWN_PRODUCTION_IDENTIFIERS.projectRefs contains at least one well-formed production ref.',
    evaluate(inputs) {
      const id = 'production-denylist-loaded'
      const status = productionDenylistStatus(inputs.production)
      return status.loaded ? yes(id, status.detail) : no(id, status.detail)
    },
    negativeControl: {
      description: 'an empty production project-ref list must fail',
      mutate: (i) => ({ ...i, production: { ...i.production, projectRefs: [] } }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'target-identity-corroborated',
    requirement:
      'The declared environment is staging, the host derives the SAME project ref, and neither is on the production denylist.',
    evaluate(inputs) {
      const id = 'target-identity-corroborated'
      const missing = attested(id, 'the staging identity', inputs.stagingIdentity)
      if (missing) return missing
      const { declaredEnvironment, projectRef, connectionHost } = inputs.stagingIdentity!.value
      if (declaredEnvironment !== 'staging') {
        return no(id, `declared environment is not exactly 'staging'.`)
      }
      const derived = projectRefFromHost(connectionHost)
      if (derived === null) {
        return no(id, 'no project ref can be derived from the host, so the connection cannot corroborate the declaration. A direct db.<ref>.supabase.co host is required.')
      }
      if (derived !== projectRef) {
        return no(id, `the host names ${derived}, the declaration names ${projectRef}. One is wrong and this gate will not guess which.`)
      }
      const host = connectionHost.trim().toLowerCase()
      if (inputs.production.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        return no(id, 'the connection host matches a known production host.')
      }
      if (inputs.production.projectRefs.includes(projectRef)) {
        return no(id, 'the project ref is on the production denylist.')
      }
      return yes(id, `staging target ${projectRef} corroborated by its own host, and vetoed by nothing`)
    },
    negativeControl: {
      description: 'a host naming a different project than the declaration must fail',
      mutate: (i) => ({
        ...i,
        stagingIdentity: i.stagingIdentity && {
          ...i.stagingIdentity,
          value: { ...i.stagingIdentity.value, connectionHost: 'db.zzzzzzzzzzzzzzzzzzzz.supabase.co' },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'class-c-probes-affirmative',
    requirement:
      'All three §2.7 probes were run and returned true: auth.users TRIGGER privilege, storage.objects ownership, uellix-evidence bucket.',
    evaluate(inputs) {
      const id = 'class-c-probes-affirmative'
      const missing = attested(id, 'the three class-C probes', inputs.classCProbes)
      if (missing) return missing
      const a = inputs.classCProbes!

      // THE QUERY MUST BE THE ONE §2.7 SPECIFIES, VERBATIM.
      //
      // This used to check that the attestation CONTAINED a marker substring —
      // `has_table_privilege`, `pg_has_role`, `storage.buckets` — and adversarial
      // review showed that is theatre twice over. A forgery passes:
      // `-- has_table_privilege pg_has_role storage.buckets`. And so does the
      // honest mistake the check exists for: `SELECT
      // has_table_privilege(current_user, 'public.users', 'SELECT')` contains the
      // marker, names the wrong table AND the wrong privilege, and answers a
      // question nobody asked.
      //
      // The canonical strings already existed in `CLASS_C_PROBES`. Requiring them
      // verbatim (whitespace-normalized, case-insensitive) costs nothing and
      // closes both.
      const recorded = normalizeSql(a.query)
      const notQuoted = CLASS_C_PROBES.filter(([, , sql]) => !recorded.includes(normalizeSql(sql)))
      if (notQuoted.length > 0) {
        return no(
          id,
          `the attestation does not quote the §2.7 query for: ${notQuoted.map(([k]) => k).join(', ')}. ` +
            `Expected verbatim: ${notQuoted.map(([, , sql]) => `\`${sql}\``).join(' ; ')}. A different query answers a different question.`,
        )
      }
      const unmeasured = CLASS_C_PROBES.filter(([k]) => a.value[k] === null || a.value[k] === undefined)
      if (unmeasured.length > 0) {
        return no(id, `not measured: ${unmeasured.map(([k]) => k).join(', ')}.`)
      }
      const denied = CLASS_C_PROBES.filter(([k]) => a.value[k] === false)
      if (denied.length > 0) {
        return no(id, `the platform denies: ${denied.map(([k]) => k).join(', ')}. The affected unit needs an adaptation before ANY of the fifty are applied.`)
      }
      return yes(id, `all three class-C probes affirmative, each quoting its §2.7 query — attested by ${a.measuredBy}`)
    },
    negativeControl: {
      // Mutates the QUERY, not the boolean. Adversarial review pointed out that
      // flipping `ownsStorageObjects` to false exercises the value branch and
      // leaves the query branch — the one that was bypassable — never driven by
      // the sweep. This drives the branch that failed.
      //
      // The value branch is covered too, by an explicit test in
      // tests/hosted/baseline-apply-authorization.test.ts.
      description: 'an attestation whose query answers a DIFFERENT question must fail',
      mutate: (i) => ({
        ...i,
        classCProbes: i.classCProbes && {
          ...i.classCProbes,
          // Right function, wrong table, wrong privilege — the honest mistake.
          query:
            "SELECT has_table_privilege(current_user, 'public.users', 'SELECT'); " +
            "SELECT pg_has_role(current_user, 'postgres', 'USAGE'); " +
            'SELECT count(*) FROM storage.buckets;',
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'manifest-hashes-and-order',
    requirement:
      'The 50-unit manifest verifies against the corpus: hashes, derived scan, equivalences, order and orphans.',
    evaluate(inputs) {
      const id = 'manifest-hashes-and-order'
      const problems = verifyBaselineManifest(
        inputs.readBaselineSql,
        scanBaselineSql,
        inputs.discoveredBaselineFiles,
      )
      if (problems.length > 0) {
        const kinds = [...new Set(problems.map((p) => p.kind))]
        return no(id, `${problems.length} problem(s) of ${kinds.length} kind(s): ${kinds.join(', ')}. First: ${problems[0].unit} — ${problems[0].detail.slice(0, 140)}`)
      }
      // Order is checked a second time, against a deliberately broken copy, so
      // "the order is fine" rests on the checker having been seen to work.
      const reordered = [...BASELINE_UNITS]
      const p = reordered.findIndex((u) => u.id === '008_marketing_leads_rls.sql')
      const t = reordered.findIndex((u) => u.id === '0035_phase5_marketing_leads.sql')
      const [moved] = reordered.splice(p, 1)
      reordered.splice(t, 0, moved)
      if (verifyBaselineOrder(reordered).length === 0) {
        return no(id, 'the order checker accepted a chain with policy 008 hoisted above the migration that creates its table. A verifier that cannot fail is not evidence the order is right.')
      }
      return yes(id, `all ${BASELINE_UNITS.length} units match their pinned hash and security-surface digest; the order checker was observed refusing a mutation`)
    },
    negativeControl: {
      description: 'one drifted unit must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'db/migrations/0031_rls_core.sql'
            ? `${i.readBaselineSql(f) ?? ''}\n-- drift\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'no-class-d-units',
    requirement: 'No unit is classified must-not-run-on-new-staging.',
    evaluate(inputs) {
      const id = 'no-class-d-units'
      const units = inputs.units ?? BASELINE_UNITS
      if (units.length === 0) return no(id, 'no units supplied, so "no class D" is vacuous.')
      const d = units.filter((u) => u.managed === 'D-must-not-run-on-new-staging')
      return d.length === 0
        ? yes(id, `none of the ${units.length} units is class D`)
        : no(id, `class D present: ${d.map((u) => u.id).join(', ')}. A unit that must not run on a new staging project is in the plan.`)
    },
    negativeControl: {
      description: 'a unit classified must-not-run-on-new-staging must fail',
      mutate: (i) => ({
        ...i,
        units: BASELINE_UNITS.map((u, index) =>
          index === 0 ? { ...u, managed: 'D-must-not-run-on-new-staging' as const } : u,
        ),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'zero-production-data',
    requirement:
      'The corpus writes zero rows to an empty database, and A0 confirmed the target holds no Stella surface.',
    evaluate(inputs) {
      const id = 'zero-production-data'
      // Measured from the corpus, not asserted: every DML statement must derive
      // its rows by SELECT. A single VALUES list would mean the baseline itself
      // seeds data into a project that is supposed to receive schema only.
      let literals = 0
      let dmlUnits = 0
      for (const unit of BASELINE_UNITS) {
        const sql = inputs.readBaselineSql(unit.file)
        if (sql === null) return no(id, `cannot read ${unit.file}, so the DML claim cannot be re-derived.`)
        const facts = scanBaselineSql(sql)
        if (facts.dmlStatements.length > 0) dmlUnits += 1
        literals += facts.literalRowSources.length
      }
      if (literals > 0) {
        return no(id, `${literals} DML statement(s) now insert literal rows. The baseline would seed data into a new project.`)
      }
      const a = inputs.checkpointA0
      if (!a || !a.value.stellaSurfaceAbsent) {
        return no(id, 'A0 did not confirm the target is free of Stella surface, so "empty" rests on nothing.')
      }
      const probed = deriveEmptinessProbes(inputs.readBaselineSql).length
      return yes(id, `${dmlUnits} unit carries DML, 0 statements draw from a literal VALUES list, and the ${probed}-table emptiness set is derived from the corpus rather than hand-listed`)
    },
    negativeControl: {
      description: 'a unit that gains a literal VALUES insert must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'db/migrations/0000_quick_husk.sql'
            ? `${i.readBaselineSql(f) ?? ''}\nINSERT INTO organizations (name, slug) VALUES ('Real', 'real');\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'no-service-role-widening',
    requirement:
      'Exactly one unit names service_role as a grantee, and it is the known one (0033).',
    evaluate(inputs) {
      const id = 'no-service-role-widening'
      const granters: string[] = []
      for (const unit of BASELINE_UNITS) {
        const sql = inputs.readBaselineSql(unit.file)
        if (sql === null) return no(id, `cannot read ${unit.file}.`)
        if (scanBaselineSql(sql).grantsToServiceRole) granters.push(unit.id)
      }
      return granters.length === 1 && granters[0] === '0033_public_api_grants.sql'
        ? yes(id, 'only 0033 grants to service_role, as recorded; §4.4 forbids provisioning the key that would make it usable')
        : no(id, `service_role grantees are now: ${granters.join(', ') || 'none'} — expected exactly 0033_public_api_grants.sql`)
    },
    negativeControl: {
      description: 'a second unit granting to service_role must fail',
      mutate: (i) => ({
        ...i,
        readBaselineSql: (f) =>
          f === 'db/migrations/0012_stella_interactions.sql'
            ? `${i.readBaselineSql(f) ?? ''}\nGRANT ALL ON public.stella_interactions TO service_role;\n`
            : i.readBaselineSql(f),
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'feature-flags-false',
    requirement: 'All nine STELLA_* flags are false in every environment pointing at the target.',
    evaluate(inputs) {
      const id = 'feature-flags-false'
      const missing = attested(id, 'the flag inventory', inputs.featureFlags)
      if (missing) return missing
      const a = inputs.featureFlags!
      const OFF = new Set(['false', '0', 'no', 'off', ''])
      const live = STELLA_FEATURE_FLAGS.filter((name) => {
        const raw = a.value[name]
        if (raw === undefined || raw === null) return false
        return typeof raw === 'boolean' ? raw : !OFF.has(raw.trim().toLowerCase())
      })
      return live.length === 0
        ? yes(id, `all ${STELLA_FEATURE_FLAGS.length} flags false or unset — attested by ${a.measuredBy}`)
        : no(id, `not false: ${live.join(', ')}. Applying the chain is not enabling it, and it stays that way.`)
    },
    negativeControl: {
      description: 'one flag left true must fail',
      mutate: (i) => ({
        ...i,
        featureFlags: i.featureFlags && {
          ...i.featureFlags,
          value: { ...i.featureFlags.value, STELLA_ENABLED: 'true' },
        },
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'postconditions-ready',
    requirement:
      'Every CHECKPOINT B0 postcondition fails against its own executable negative control.',
    evaluate(inputs) {
      const id = 'postconditions-ready'
      const expected = deriveExpectedBaselineState(inputs.readBaselineSql)
      if (expected.tables.length === 0) {
        return no(id, 'the expected baseline state derived to nothing, so the postconditions have no bar to measure against.')
      }
      const conforming = {
        schemas: ['public', 'auth', 'storage'],
        tables: [...expected.tables],
        columns: {
          'public.users': ['id', 'email', 'is_super_admin'],
          'public.stella_interactions': ['id', 'organization_id'],
          'public.project_investments': ['id', 'funder_id', 'amount_usd'],
          'public.financial_proxies': ['id', 'value_usd'],
          'public.marketing_leads': ['id', 'email'],
        },
        constraints: [
          'approved_proxy_check',
          'project_investments_contribution_type_check',
          'project_investments_in_kind_notes_check',
          'organizations_slug_unique',
          'users_email_unique',
        ],
        functions: [...expected.functions],
        triggers: [...expected.triggers],
        rlsEnabledTables: [...expected.rlsEnabledTables],
        policies: [...expected.policies],
        roles: ['postgres', 'anon', 'authenticated', 'service_role'],
        grants: [],
        rowCounts: Object.fromEntries(expected.tables.map((t) => [t, 0])),
        extensions: ['pgcrypto'],
        storageBuckets: ['uellix-evidence'],
        environmentSecretNames: [],
      }
      const postconditions = inputs.postconditions ?? BASELINE_POSTCONDITIONS
      const survivors = postconditions.filter(
        (p) => p.check(p.negativeControl.mutate(conforming), expected).passed,
      ).map((p) => p.id)

      return survivors.length === 0
        ? yes(id, `all ${postconditions.length} postconditions were observed failing their own negative control`)
        : no(id, `postcondition(s) that pass their own mutation, i.e. that do not read their input: ${survivors.join(', ')}`)
    },
    negativeControl: {
      // Drives the SURVIVORS branch, not the early return.
      //
      // The previous control blanked the corpus, which tripped the "derived to
      // nothing" guard at the top and left the survivors filter — the actual
      // work of this criterion — never exercised. An inverted predicate there
      // would have passed the sweep. Injecting one decorative postcondition is
      // what makes "the postconditions are not decorative" a measurement.
      description: 'one postcondition that always returns passed:true must fail',
      mutate: (i) => ({
        ...i,
        postconditions: [
          ...BASELINE_POSTCONDITIONS,
          {
            id: 'B0-XX-decorative',
            requirement: 'a check that ignores its input',
            probeSql: 'SELECT 1;',
            check: () => ({ passed: true, detail: 'always' }),
            negativeControl: { description: 'none', mutate: (o) => o },
          },
        ],
      }),
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: 'recovery-plan-conservative',
    requirement:
      'A mid-baseline failure answers DESTROY_AND_REPROVISION, and a non-atomic apply halts.',
    evaluate(inputs) {
      const id = 'recovery-plan-conservative'
      const decideRecovery = inputs.decide ?? realDecideRecovery
      const mid = decideRecovery({
        phase: 'PHASE_BASELINE',
        failedUnit: '0031_rls_core.sql',
        failureKind: 'statement-error',
        singleTransaction: true,
        manualWritesOccurred: false,
        holdsIrreplaceableData: false,
      })
      const nonAtomic = decideRecovery({
        phase: 'PHASE_BASELINE',
        failedUnit: '0031_rls_core.sql',
        failureKind: 'statement-error',
        singleTransaction: false,
        manualWritesOccurred: false,
        holdsIrreplaceableData: false,
      })
      const indeterminate = decideRecovery({
        phase: 'PHASE_BASELINE',
        failedUnit: '0005_daffy_dreaming_celestial.sql',
        failureKind: 'indeterminate',
        singleTransaction: true,
        manualWritesOccurred: false,
        holdsIrreplaceableData: false,
      })

      const problems: string[] = []
      if (mid.strategy !== 'DESTROY_AND_REPROVISION') problems.push(`mid-baseline answers ${mid.strategy}`)
      if (nonAtomic.strategy !== 'HALT_AND_ESCALATE') problems.push(`non-atomic answers ${nonAtomic.strategy}`)
      if (indeterminate.strategy !== 'DESTROY_AND_REPROVISION') problems.push(`indeterminate answers ${indeterminate.strategy}`)

      return problems.length === 0
        ? yes(id, 'the recovery table answers the three dangerous situations conservatively, and was driven to prove it')
        : no(id, `recovery table regressed: ${problems.join('; ')}`)
    },
    negativeControl: {
      // A permissive recovery table. If the criterion returned true against
      // THIS, it would not be reading the strategies at all — which is what the
      // first run of the negative-control sweep found it doing.
      description: 'a recovery table that answers RETRY_UNIT to everything must fail',
      mutate: (i) => ({
        ...i,
        decide: () => ({
          strategy: 'RETRY_UNIT' as const,
          rationale: 'permissive stub',
          steps: ['retry'],
          revisitIf: [],
        }),
      }),
    },
  },
]

export interface ApplyAuthorizationReport {
  readonly criteria: readonly AuthorizationVerdict[]
  /**
   * TRUE only when every criterion is satisfied. Even then it authorises a
   * HUMAN to run PHASE_BASELINE; it does not run anything and it is not consent.
   */
  readonly applyAuthorized: boolean
  /** ALWAYS false. Nothing here applies anything. */
  readonly baselineApplied: false
  /** ALWAYS false. */
  readonly stagingApplied: false
  /** ALWAYS false. */
  readonly hostedReady: false
  /** ALWAYS false. */
  readonly providerReady: false
  readonly blocking: readonly string[]
}

export function evaluateApplyAuthorization(
  inputs: ApplyAuthorizationInputs,
): ApplyAuthorizationReport {
  const criteria = APPLY_AUTHORIZATION_CRITERIA.map((c) => c.evaluate(inputs))
  const blocking = criteria.filter((c) => !c.satisfied)

  return {
    criteria,
    applyAuthorized: blocking.length === 0,
    baselineApplied: false,
    stagingApplied: false,
    hostedReady: false,
    providerReady: false,
    blocking: blocking.map((c) => `${c.id}: ${c.detail}`),
  }
}

/** The default production identifiers, re-exported so callers need one import. */
export { KNOWN_PRODUCTION_IDENTIFIERS }
