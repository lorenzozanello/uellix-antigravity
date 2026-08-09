// db/hosted/bootstrap-postconditions.ts
//
// WHAT CLOSES S1, AND WHY THE PACKAGE'S OWN §6 IS NOT IT.
//
// `stella_hosted_0001` verifies itself before COMMIT, and that check earns its
// place: a failure rolls the package back rather than leaving half a role model
// behind. But it is the package auditing itself, inside the transaction that
// built the state, using the same assumptions. What closes S1 is an
// INDEPENDENT read of what is actually there afterwards.
//
// That is not a new doctrine invented here. §2.9 of
// docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md already settled
// it for the whole hosted plan: there is no journal, because "un journal dice
// qué se intentó y B0 dice qué hay". This module is that same shape applied one
// phase later — an artefact the operator fills from read-only queries, a pure
// evaluator over it, a status script, and a `:verify` that recomputes.
//
// ---------------------------------------------------------------------------
// ONE PROBE, TWO VERDICTS
// ---------------------------------------------------------------------------
// Exactly one fact differs between closing S1 and closing CHECKPOINT A1: the
// sentinel row. S1 requires it ABSENT — a bootstrap that minted its own
// sentinel would be certifying itself. A1 requires it PRESENT, because the
// chain has no other in-database statement of identity.
//
// Everything else is identical, so it is the SAME probe and the SAME checks,
// parameterised by `sentinelExpected`. A second probe for the second verdict
// would be the parallel implementation this repository keeps paying for — the
// defect found five times and named in db/hosted/checkpoint-b0.ts.

import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from './target-identity'

// ---------------------------------------------------------------------------
// THE EVIDENCE REGISTRY — two historical facts, not two versions of one
// ---------------------------------------------------------------------------
//
// The first version of this module had ONE observation path and ONE status
// path. The post-S2 measurement would have been written over the pre-S2 one,
// destroying the only proof that the bootstrap did not mint its own sentinel,
// and the diff would have read as a routine update of two files.
//
// `CLASS_C_SQL_EDITOR_EVIDENCE` already had the right shape — a ledger declared
// in code, whose own test says "never the newest file on disk". One thing here
// differs DELIBERATELY. Class-C resolves `ledger[ledger.length - 1]`, because a
// newer measurement supersedes an older one. These two never supersede each
// other: `pre-sentinel` proves the table was left empty, `post-sentinel` proves
// the operator filled it, and both stay true forever. So the selector is the
// declared PHASE, and recency is not a signal at all — not by date, not by
// position in the array, not by anything on disk. This module never reads the
// filesystem; a test asserts it cannot.

export type S1EvidencePhase = 'pre-sentinel' | 'post-sentinel'

export interface S1EvidenceEntry {
  /** The selector. The ONLY selector. */
  readonly phase: S1EvidencePhase
  /** Where the operator records the read-only observation. */
  readonly path: string
  /** Where the derived verdict is written, so a report can only quote it. */
  readonly statusPath: string
  /** ISO date the operator measured it. Documentation; never the selector. */
  readonly measuredOn: string
  /** The project this measurement describes. Checked against the target. */
  readonly projectRef: string
  readonly note: string
}

export const S1_EVIDENCE_REGISTRY: readonly S1EvidenceEntry[] = [
  {
    phase: 'pre-sentinel',
    path: 'artifacts/hosted-s1-observation.json',
    statusPath: 'artifacts/hosted-s1-status.json',
    measuredOn: '2026-08-09',
    projectRef: KNOWN_STAGING_PROJECT_REF,
    note:
      'Measured after S1 and BEFORE the human sentinel INSERT. Records ' +
      'sentinelRowCount=0, which is the only evidence that stella_hosted_0001 ' +
      'left the row for a person rather than certifying itself. NOT superseded ' +
      'by the post-sentinel measurement and never will be: the two answer ' +
      'different questions, and this one can only be taken once, before S2.',
  },
  {
    phase: 'post-sentinel',
    path: 'artifacts/hosted-s1-observation-post-sentinel.json',
    statusPath: 'artifacts/hosted-s1-status-post-sentinel.json',
    measuredOn: '2026-08-09',
    projectRef: KNOWN_STAGING_PROJECT_REF,
    note:
      'S3. Measured after the operator wrote the sentinel row. Its job is to ' +
      'show exactly one row AND that the other twelve postconditions are ' +
      'byte-for-byte what the pre-sentinel measurement recorded — S2 was one ' +
      'INSERT, and anything else that moved would mean it did more than that.',
  },
]

/**
 * The phase decides the expectation. It is not an argument anywhere, so
 * `phase=pre-sentinel` with `sentinelExpected=present` is unrepresentable
 * rather than merely discouraged.
 */
export const SENTINEL_EXPECTATION: Readonly<Record<S1EvidencePhase, SentinelExpectation>> = {
  'pre-sentinel': 'absent',
  'post-sentinel': 'present',
}

/**
 * The label a status artefact carries, and it is NOT the phase slug.
 *
 * `artifacts/hosted-s1-status.json` was committed at 90c2dff carrying
 * `"phase": "S1 (PHASE_STELLA_BOOTSTRAP)"`. Recording the slug instead would
 * have changed those bytes, and the instruction is explicit: the committed
 * evidence is not re-serialized to make new plumbing fit. So the label stays
 * what it was and the slug lives here, in the map, where the registry can use
 * it as a selector without touching history.
 *
 * The two labels differ, which is what makes a cross-wired status detectable:
 * a pre-sentinel verdict copied into the post-sentinel slot fails `:verify`
 * because the recomputation carries the other label and the other expectation.
 */
export const PHASE_LABEL: Readonly<Record<S1EvidencePhase, string>> = {
  'pre-sentinel': 'S1 (PHASE_STELLA_BOOTSTRAP)',
  'post-sentinel': 'CHECKPOINT A1',
}

export type S1EvidenceRefusalCode =
  | 'S1_REGISTRY_EMPTY'
  | 'S1_PHASE_NOT_DECLARED'
  | 'S1_PHASE_DUPLICATED'
  | 'S1_PATH_COLLISION'
  | 'S1_STATUS_PATH_COLLISION'
  | 'S1_ENTRY_PROJECT_REF_MISSING'
  | 'S1_ENTRY_PROJECT_REF_MALFORMED'
  | 'S1_PRODUCTION_REF'
  | 'S1_WRONG_TARGET'

export type S1EvidenceResolution =
  | {
      readonly ok: true
      readonly entry: S1EvidenceEntry
      readonly sentinelExpected: SentinelExpectation
    }
  | { readonly ok: false; readonly code: S1EvidenceRefusalCode; readonly detail: string }

/** A Supabase project ref: exactly twenty lowercase letters. */
const PROJECT_REF_SHAPE = /^[a-z]{20}$/

/**
 * Picks the artefact for a phase, or refuses.
 *
 * Integrity of the WHOLE registry is checked before any entry is used, because
 * a duplicated phase or a shared path is a defect in the map itself and would
 * otherwise be discovered only by whichever lookup happened to hit it.
 * Production is vetoed before the target match, so a production artefact is
 * refused as production rather than as "the wrong project".
 */
export function resolveS1Evidence(
  phase: S1EvidencePhase,
  registry: readonly S1EvidenceEntry[] = S1_EVIDENCE_REGISTRY,
  targetProjectRef: string = KNOWN_STAGING_PROJECT_REF,
  production = KNOWN_PRODUCTION_IDENTIFIERS,
): S1EvidenceResolution {
  if (registry.length === 0) {
    return {
      ok: false,
      code: 'S1_REGISTRY_EMPTY',
      detail: 'no S1 evidence is declared. Unmeasured is not satisfied, and undeclared is not measured.',
    }
  }

  for (const candidate of registry) {
    const samePhase = registry.filter((e) => e.phase === candidate.phase)
    if (samePhase.length > 1) {
      return {
        ok: false,
        code: 'S1_PHASE_DUPLICATED',
        detail: `phase ${candidate.phase} is declared ${samePhase.length} times. Two answers to one question is the divergence this registry exists to prevent.`,
      }
    }
  }

  for (const a of registry) {
    for (const b of registry) {
      if (a === b) continue
      if (a.path === b.path) {
        return {
          ok: false,
          code: 'S1_PATH_COLLISION',
          detail: `${a.phase} and ${b.phase} both record to ${a.path}. That shared path IS the defect this registry was written to close: the second measurement would overwrite the first.`,
        }
      }
      if (a.statusPath === b.statusPath) {
        return {
          ok: false,
          code: 'S1_STATUS_PATH_COLLISION',
          detail: `${a.phase} and ${b.phase} both write their verdict to ${a.statusPath}.`,
        }
      }
    }
  }

  const entry = registry.find((e) => e.phase === phase)
  if (entry === undefined) {
    return {
      ok: false,
      code: 'S1_PHASE_NOT_DECLARED',
      detail: `no entry declares phase ${phase}. Declared: ${list(registry.map((e) => e.phase))}.`,
    }
  }

  if (entry.projectRef === '') {
    return {
      ok: false,
      code: 'S1_ENTRY_PROJECT_REF_MISSING',
      detail: `the ${phase} entry does not say which project it describes.`,
    }
  }
  if (!PROJECT_REF_SHAPE.test(entry.projectRef)) {
    return {
      ok: false,
      code: 'S1_ENTRY_PROJECT_REF_MALFORMED',
      detail: `${entry.projectRef} is not a Supabase project ref (20 lowercase letters).`,
    }
  }
  if (
    production.projectRefs.includes(entry.projectRef) ||
    production.projectRefs.includes(targetProjectRef)
  ) {
    return {
      ok: false,
      code: 'S1_PRODUCTION_REF',
      detail: `${entry.projectRef} is a PRODUCTION project ref. This phase never runs there.`,
    }
  }
  if (entry.projectRef !== targetProjectRef) {
    return {
      ok: false,
      code: 'S1_WRONG_TARGET',
      detail: `the ${phase} entry describes ${entry.projectRef}, the question was asked about ${targetProjectRef}.`,
    }
  }

  return { ok: true, entry, sentinelExpected: SENTINEL_EXPECTATION[phase] }
}

/** The read-only SQL that produces the observation. Generated, byte-verified. */
export const S1_OBSERVATION_SQL = 'db/prepared/stella-bootstrap/observation.sql'
/** The ONE write of this phase, and the one a human must issue. Generated. */
export const S2_SENTINEL_SQL = 'db/prepared/stella-bootstrap/sentinel.sql'

/**
 * The two literals §3 of STELLA_STAGING_PROVISIONING_REQUIREMENTS.md fixes.
 *
 * They live here rather than in the file so the runbook, the generated SQL and
 * any future reader of the row agree by construction. `project_ref` is NOT
 * here: it is the one value the operator supplies, read from the dashboard,
 * and hardcoding it would let this repository write an identity claim on its
 * own.
 */
export const SENTINEL_BOOTSTRAP_VERSION = 'stella_hosted_0001'
export const SENTINEL_OWNER_SEPARATION =
  'auditable-obstacle: RR-02 applies, postgres retains ADMIN OPTION over uellix_owner'

/** The five roles, in the order the package creates them. */
export const BOOTSTRAP_ROLES = [
  'uellix_owner',
  'uellix_migrator',
  'uellix_app',
  'uellix_writer',
  'uellix_auditor',
] as const

/** The three functions, with the EXECUTE holders the contract allows each. */
export const BOOTSTRAP_FUNCTIONS = [
  {
    signature: 'public.uellix_auth_uid()',
    securityDefiner: true,
    grantees: ['uellix_app'],
  },
  {
    signature: 'uellix_bootstrap.assert_hosted_capabilities(text)',
    securityDefiner: false,
    grantees: ['uellix_migrator'],
  },
  {
    signature: 'uellix_bootstrap.hosted_capability_report()',
    securityDefiner: false,
    grantees: ['uellix_migrator', 'uellix_auditor'],
  },
] as const

export interface ObservedRole {
  readonly name: string
  readonly canLogin: boolean
  readonly isSuper: boolean
  readonly bypassRls: boolean
  readonly createRole: boolean
  readonly createDb: boolean
  readonly replication: boolean
}

export interface ObservedMembership {
  readonly role: string
  readonly member: string
  readonly inheritOption: boolean
  readonly setOption: boolean
}

export interface ObservedFunction {
  readonly signature: string
  readonly owner: string
  readonly securityDefiner: boolean
  readonly config: readonly string[]
  /** EVERY EXECUTE holder, owner included, PUBLIC spelled 'PUBLIC'. */
  readonly executeGrantees: readonly string[]
}

export interface ObservedSchemaGrant {
  readonly grantee: string
  readonly usage: boolean
  readonly create: boolean
}

export interface S1Observation {
  readonly targetProjectRef: string
  /** Owner of schema uellix_bootstrap, or null when the schema is absent. */
  readonly bootstrapSchemaOwner: string | null
  readonly roles: readonly ObservedRole[]
  readonly memberships: readonly ObservedMembership[]
  readonly appReachesOwner: boolean
  readonly appReachesMigrator: boolean
  readonly ledgerOwner: string | null
  readonly functions: readonly ObservedFunction[]
  readonly schemaPublicGrants: readonly ObservedSchemaGrant[]
  readonly sentinelTablePresent: boolean
  readonly sentinelRowCount: number
}

export type SentinelExpectation = 'absent' | 'present'

export interface BootstrapCheck {
  readonly id: string
  readonly title: string
  readonly evaluate: (
    o: S1Observation,
    sentinelExpected: SentinelExpectation,
  ) => { readonly passed: boolean; readonly detail: string }
}

const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : [...xs].sort().join(', '))

const fnFor = (o: S1Observation, signature: string): ObservedFunction | undefined =>
  o.functions.find((f) => f.signature === signature)

/**
 * PostgreSQL stores `SET search_path = ''` in proconfig as `search_path=""` —
 * it QUOTES the empty value. The package records this as a measured defect
 * (grounding_0002 lines 1087-1093): checking only the bare spelling made the
 * whole chain inapplicable while every offline test stayed green. Both forms.
 */
const hasEmptySearchPath = (config: readonly string[]): boolean =>
  config.includes('search_path=') || config.includes('search_path=""')

export const BOOTSTRAP_POSTCONDITIONS: readonly BootstrapCheck[] = [
  {
    id: 'S1-01',
    title: 'schema uellix_bootstrap exists and is owned by uellix_owner',
    evaluate: (o) =>
      o.bootstrapSchemaOwner === 'uellix_owner'
        ? { passed: true, detail: 'owned by uellix_owner' }
        : {
            passed: false,
            detail:
              o.bootstrapSchemaOwner === null
                ? 'schema uellix_bootstrap is ABSENT — S1 did not commit'
                : `schema uellix_bootstrap is owned by ${o.bootstrapSchemaOwner}, not uellix_owner`,
          },
  },
  {
    id: 'S1-02',
    title: 'exactly the five roles exist',
    evaluate: (o) => {
      const found = o.roles.map((r) => r.name)
      const missing = BOOTSTRAP_ROLES.filter((r) => !found.includes(r))
      const extra = found.filter((r) => !BOOTSTRAP_ROLES.includes(r as (typeof BOOTSTRAP_ROLES)[number]))
      return missing.length === 0 && extra.length === 0
        ? { passed: true, detail: `5 roles: ${list(found)}` }
        : { passed: false, detail: `missing: ${list(missing)}; unexpected: ${list(extra)}` }
    },
  },
  {
    id: 'S1-03',
    title: 'no role this package created holds a dangerous attribute',
    evaluate: (o) => {
      // Written over the ATTRIBUTES rather than over a list of names, so a role
      // altered by hand afterwards is caught by the same query.
      const bad = o.roles
        .filter((r) => r.isSuper || r.bypassRls || r.createRole || r.createDb || r.replication)
        .map((r) => r.name)
      return bad.length === 0
        ? { passed: true, detail: 'none is SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION' }
        : { passed: false, detail: `dangerous attribute on: ${list(bad)}` }
    },
  },
  {
    id: 'S1-04',
    title: 'the membership graph is exactly the contract',
    evaluate: (o) => {
      const problems: string[] = []
      const owner = o.memberships.find((m) => m.role === 'uellix_owner' && m.member === 'uellix_migrator')
      if (owner === undefined) problems.push('uellix_migrator is not a member of uellix_owner')
      else {
        if (!owner.setOption) problems.push('migrator -> owner lacks SET; seven chain packages open an owner window')
        if (owner.inheritOption)
          problems.push('migrator -> owner INHERITS; every migrator statement would be an owner statement')
      }
      const writer = o.memberships.find((m) => m.role === 'uellix_writer' && m.member === 'uellix_app')
      if (writer === undefined) problems.push('uellix_app is not a member of uellix_writer')
      else {
        if (!writer.inheritOption) problems.push('app -> writer lacks INHERIT; the runtime could not write')
        if (writer.setOption) problems.push('app -> writer holds SET; the runtime could shed its own identity')
      }
      return problems.length === 0
        ? { passed: true, detail: 'migrator->owner SET/NOINHERIT, app->writer INHERIT/NOSET' }
        : { passed: false, detail: problems.join('; ') }
    },
  },
  {
    id: 'S1-05',
    title: 'the runtime cannot reach the owner or the migrator BY ANY PATH',
    evaluate: (o) => {
      // Asked as reachability rather than as "is there a grant": a future path
      // through a third role is exactly what a membership list would miss.
      const problems: string[] = []
      if (o.appReachesOwner) problems.push('uellix_app can reach uellix_owner')
      if (o.appReachesMigrator) problems.push('uellix_app can reach uellix_migrator')
      return problems.length === 0
        ? { passed: true, detail: 'uellix_app reaches neither' }
        : { passed: false, detail: problems.join('; ') }
    },
  },
  {
    id: 'S1-06',
    title: 'public.stella_interactions is owned by uellix_owner',
    evaluate: (o) =>
      o.ledgerOwner === 'uellix_owner'
        ? { passed: true, detail: 'owned by uellix_owner' }
        : {
            passed: false,
            detail: `ledger owner is ${o.ledgerOwner ?? 'ABSENT'} — stella_0013 opens an owner window over it and stella_0017 sweeps every non-excluded writer`,
          },
  },
  {
    id: 'S1-07',
    title: 'all three bootstrap functions exist, with their exact signatures',
    evaluate: (o) => {
      const missing = BOOTSTRAP_FUNCTIONS.filter((f) => fnFor(o, f.signature) === undefined).map(
        (f) => f.signature,
      )
      return missing.length === 0
        ? { passed: true, detail: '3 functions present' }
        : { passed: false, detail: `absent: ${list(missing)}` }
    },
  },
  {
    id: 'S1-08',
    title: 'every bootstrap function is owned by one and the same installer',
    evaluate: (o) => {
      // The ACL check below exempts the owner, because an owner always holds
      // EXECUTE. That exemption is only safe if the owner is known.
      const owners = [...new Set(o.functions.map((f) => f.owner))]
      if (owners.length !== 1) {
        return { passed: false, detail: `functions have ${owners.length} distinct owners: ${list(owners)}` }
      }
      const stray = BOOTSTRAP_ROLES.includes(owners[0] as (typeof BOOTSTRAP_ROLES)[number])
      return stray
        ? {
            passed: false,
            detail: `functions are owned by ${owners[0]}, a role this package created — the installer must own them`,
          }
        : { passed: true, detail: `all owned by ${owners[0]}` }
    },
  },
  {
    id: 'S1-09',
    title: 'the shim is SECURITY DEFINER, the other two are not, and all pin an empty search_path',
    evaluate: (o) => {
      const problems: string[] = []
      for (const expected of BOOTSTRAP_FUNCTIONS) {
        const actual = fnFor(o, expected.signature)
        if (actual === undefined) continue // S1-07 owns absence
        if (actual.securityDefiner !== expected.securityDefiner) {
          problems.push(
            `${expected.signature} is ${actual.securityDefiner ? '' : 'not '}SECURITY DEFINER and should ${expected.securityDefiner ? '' : 'not '}be`,
          )
        }
        if (!hasEmptySearchPath(actual.config)) {
          problems.push(`${expected.signature} does not pin an empty search_path (${list(actual.config)})`)
        }
      }
      return problems.length === 0
        ? { passed: true, detail: 'definer/invoker as contracted, empty search_path on all three' }
        : { passed: false, detail: problems.join('; ') }
    },
  },
  {
    id: 'S1-10',
    title: 'the effective EXECUTE acl is exactly the contract on every function',
    evaluate: (o) => {
      // S1-DEFECT-002. Stated as an EQUALITY, not as an absence list: a
      // principal nobody has thought of is caught by the same comparison that
      // catches anon, and a contract grantee that silently lost EXECUTE is
      // caught too.
      const problems: string[] = []
      for (const expected of BOOTSTRAP_FUNCTIONS) {
        const actual = fnFor(o, expected.signature)
        if (actual === undefined) continue
        const held = actual.executeGrantees.filter((g) => g !== actual.owner)
        const unexpected = held.filter((g) => !expected.grantees.includes(g as never))
        const absent = expected.grantees.filter((g) => !held.includes(g))
        if (unexpected.length > 0) problems.push(`${expected.signature}: unexpected EXECUTE for ${list(unexpected)}`)
        if (absent.length > 0) problems.push(`${expected.signature}: contract grantee(s) ${list(absent)} hold none`)
      }
      return problems.length === 0
        ? { passed: true, detail: 'no PUBLIC, anon, authenticated or service_role; contract grantees intact' }
        : { passed: false, detail: problems.join('; ') }
    },
  },
  {
    id: 'S1-11',
    title: 'on schema public, only uellix_owner holds CREATE, and all five hold USAGE',
    evaluate: (o) => {
      const problems: string[] = []
      for (const role of BOOTSTRAP_ROLES) {
        const g = o.schemaPublicGrants.find((x) => x.grantee === role)
        if (g === undefined) {
          problems.push(`${role} holds nothing on schema public`)
          continue
        }
        if (!g.usage) problems.push(`${role} lacks USAGE on schema public`)
        const shouldCreate = role === 'uellix_owner'
        if (g.create !== shouldCreate) {
          problems.push(
            shouldCreate
              ? 'uellix_owner lacks CREATE on schema public — five chain packages create tables there in an owner window'
              : `${role} holds CREATE on schema public; only the owner may create structure`,
          )
        }
      }
      return problems.length === 0
        ? { passed: true, detail: 'USAGE x5, CREATE only for uellix_owner' }
        : { passed: false, detail: problems.join('; ') }
    },
  },
  {
    id: 'S1-12',
    title: 'the staging sentinel TABLE exists',
    evaluate: (o) =>
      o.sentinelTablePresent
        ? { passed: true, detail: 'present' }
        : { passed: false, detail: 'uellix_bootstrap.staging_sentinel is absent; the chain has nowhere to read identity from' },
  },
  {
    id: 'S1-13',
    title: 'the sentinel ROW is where this phase requires it to be',
    evaluate: (o, sentinelExpected) => {
      if (sentinelExpected === 'absent') {
        return o.sentinelRowCount === 0
          ? { passed: true, detail: 'empty, awaiting the human INSERT (§3)' }
          : {
              passed: false,
              detail: `${o.sentinelRowCount} row(s) already present. S1 must not mint its own sentinel — a bootstrap that certifies itself proves nothing`,
            }
      }
      return o.sentinelRowCount === 1
        ? { passed: true, detail: 'exactly one row, written by the operator' }
        : {
            passed: false,
            detail:
              o.sentinelRowCount === 0
                ? 'no sentinel row. CHECKPOINT A1 cannot pass before the operator writes it (§3)'
                : `${o.sentinelRowCount} rows — the singleton CHECK should have made this impossible`,
          }
    },
  },
]

export interface BootstrapVerdict {
  readonly passed: boolean
  /** Recorded on the verdict so a status artefact cannot hide which one it is. */
  readonly phase: S1EvidencePhase
  readonly sentinelExpected: SentinelExpectation
  readonly checks: readonly { readonly id: string; readonly title: string; readonly passed: boolean; readonly detail: string }[]
}

/**
 * Takes a PHASE, never an expectation.
 *
 * The expectation used to be an option, which meant a caller could ask for the
 * pre-sentinel phase while expecting a row — the exact cross-wiring that would
 * make a post-S2 measurement pass as pre-S2 evidence. Deriving it from the
 * phase puts the semantics in one place and makes the illegal combination
 * impossible to write rather than merely wrong.
 */
export function evaluateBootstrapPostconditions(
  observation: S1Observation,
  phase: S1EvidencePhase,
): BootstrapVerdict {
  const sentinelExpected = SENTINEL_EXPECTATION[phase]
  const checks = BOOTSTRAP_POSTCONDITIONS.map((c) => ({
    id: c.id,
    title: c.title,
    ...c.evaluate(observation, sentinelExpected),
  }))
  return {
    passed: checks.every((c) => c.passed),
    phase,
    sentinelExpected,
    checks,
  }
}

// ---------------------------------------------------------------------------
// Parsing the artefact, fail-closed
// ---------------------------------------------------------------------------

export type S1RefusalCode =
  | 'S1_OBSERVATION_ABSENT'
  | 'S1_OBSERVATION_MALFORMED'
  | 'S1_OBSERVATION_PROJECT_REF_MISSING'
  | 'S1_OBSERVATION_PRODUCTION_REF'
  | 'S1_OBSERVATION_PROJECT_REF_MISMATCH'
  | 'S1_OBSERVATION_INCOMPLETE'
  | 'S1_OBSERVATION_CARRIES_SECRET'

export type S1ParseResult =
  | { readonly ok: true; readonly observation: S1Observation }
  | { readonly ok: false; readonly code: S1RefusalCode; readonly detail: string }

const REQUIRED_FIELDS = [
  'targetProjectRef',
  'bootstrapSchemaOwner',
  'roles',
  'memberships',
  'appReachesOwner',
  'appReachesMigrator',
  'ledgerOwner',
  'functions',
  'schemaPublicGrants',
  'sentinelTablePresent',
  'sentinelRowCount',
] as const

/**
 * JWTs, connection strings with userinfo, Supabase keys, long base64 blobs.
 * A project ref is public in every URL the project serves; a token is not, and
 * an artefact is a file that gets committed.
 */
const SECRET_SHAPED =
  /(^eyJ[A-Za-z0-9_-]{10,})|(:\/\/[^\s/]*:[^\s@]*@)|(^sb[a-z]*_[A-Za-z0-9]{16,})|([A-Za-z0-9+/]{40,}={0,2}$)/

function carriesSecret(value: unknown): string | null {
  if (typeof value === 'string') return SECRET_SHAPED.test(value) ? value.slice(0, 12) : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = carriesSecret(item)
      if (found !== null) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = carriesSecret(item)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * `sourcePath` is required, not defaulted. The refusal message names the file
 * the operator must produce, and the whole point of the registry is that there
 * is more than one — a hardcoded path here is how S3 would end up being told
 * to overwrite the pre-sentinel evidence.
 */
export function parseS1Observation(
  raw: string | null,
  targetProjectRef: string,
  sourcePath: string,
): S1ParseResult {
  if (raw === null || raw.trim() === '') {
    return {
      ok: false,
      code: 'S1_OBSERVATION_ABSENT',
      detail: `${sourcePath} is absent. Unmeasured is not satisfied: run ${S1_OBSERVATION_SQL} against the target and record its output THERE — not over another phase's artefact.`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'S1_OBSERVATION_MALFORMED', detail: 'the artefact is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'S1_OBSERVATION_MALFORMED', detail: 'the artefact is not a JSON object' }
  }
  const o = parsed as Record<string, unknown>

  if (typeof o.targetProjectRef !== 'string' || o.targetProjectRef === '') {
    return {
      ok: false,
      code: 'S1_OBSERVATION_PROJECT_REF_MISSING',
      detail: 'the observation does not say which database it describes',
    }
  }
  if (
    KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(o.targetProjectRef) ||
    KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.includes(targetProjectRef)
  ) {
    return {
      ok: false,
      code: 'S1_OBSERVATION_PRODUCTION_REF',
      detail: `${o.targetProjectRef} is a PRODUCTION project ref. This phase never runs there.`,
    }
  }
  if (o.targetProjectRef !== targetProjectRef) {
    return {
      ok: false,
      code: 'S1_OBSERVATION_PROJECT_REF_MISMATCH',
      detail: `the artefact describes ${o.targetProjectRef}, the verdict was asked about ${targetProjectRef}`,
    }
  }

  const secret = carriesSecret(o)
  if (secret !== null) {
    return {
      ok: false,
      code: 'S1_OBSERVATION_CARRIES_SECRET',
      detail: `a value shaped like a credential is present (starts "${secret}…"). Observations record catalogue facts, never secrets.`,
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => !(f in o))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'S1_OBSERVATION_INCOMPLETE',
      detail: `missing field(s): ${list(missing)}. A partial observation cannot produce a verdict.`,
    }
  }
  return { ok: true, observation: o as unknown as S1Observation }
}

// ---------------------------------------------------------------------------
// The read-only SQL, generated so the probe and the contract cannot drift
// ---------------------------------------------------------------------------

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

export function buildBootstrapObservationSql(): string {
  const roleList = BOOTSTRAP_ROLES.map(lit).join(', ')
  const fnList = BOOTSTRAP_FUNCTIONS.map((f) => lit(f.signature)).join(',\n      ')

  return `-- ============================================================================
-- GENERATED — DO NOT EDIT. PHASE_STELLA_BOOTSTRAP postconditions.
-- Regenerate with \`pnpm s1:observation:generate\`; \`pnpm s1:observation:verify\`
-- compares bytes.
--
-- READ ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Runs inside a READ ONLY
-- transaction and rolls back.
--
--   & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f ${S1_OBSERVATION_SQL}
--
-- WHY THIS EXISTS SEPARATELY FROM THE PACKAGE'S OWN §6. stella_hosted_0001
-- verifies itself before COMMIT, which is worth having — a failure rolls it
-- back. But it is the package auditing itself from inside the transaction that
-- built the state. This reads what is actually there afterwards, which is the
-- same doctrine §2.9 of the provisioning runbook states for the whole hosted
-- plan: no journal, because a journal says what was attempted and a measurement
-- says what is.
--
-- THE SAME PROBE CLOSES S1 AND CHECKPOINT A1. Exactly one fact differs — the
-- sentinel ROW, absent for S1 and present for A1 — so the row COUNT is reported
-- and the verdict is parameterised in code rather than duplicated here.
-- ============================================================================
\\if :{?uellix_project_ref}
\\else
\\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\\echo 'An unattributed observation could describe any database, including production.'
\\quit
\\endif

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'targetProjectRef', :'uellix_project_ref',
  'measuredBy', 'operator, psql session pooler, inside a READ ONLY transaction, from ${S1_OBSERVATION_SQL}',
  'note', 'Project refs are not secret. No credential, connection string or user data is recorded here. Every value below was measured by this query.',

  'bootstrapSchemaOwner', (
    SELECT pg_catalog.pg_get_userbyid(n.nspowner)
    FROM pg_catalog.pg_namespace n WHERE n.nspname = 'uellix_bootstrap'),

  'roles', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name', r.rolname, 'canLogin', r.rolcanlogin, 'isSuper', r.rolsuper,
      'bypassRls', r.rolbypassrls, 'createRole', r.rolcreaterole,
      'createDb', r.rolcreatedb, 'replication', r.rolreplication
    ) ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roleList})),

  'memberships', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'role', gr.rolname, 'member', mr.rolname,
      'inheritOption', m.inherit_option, 'setOption', m.set_option
    ) ORDER BY gr.rolname, mr.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles gr ON gr.oid = m.roleid
    JOIN pg_catalog.pg_roles mr ON mr.oid = m.member
    WHERE gr.rolname IN (${roleList}) AND mr.rolname IN (${roleList})),

  -- Reachability, not the grant list: a future path through a third role is
  -- exactly what reading pg_auth_members would miss.
  'appReachesOwner', pg_catalog.pg_has_role('uellix_app', 'uellix_owner', 'MEMBER'),
  'appReachesMigrator', pg_catalog.pg_has_role('uellix_app', 'uellix_migrator', 'MEMBER'),

  'ledgerOwner', (
    SELECT pg_catalog.pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'stella_interactions'),

  -- EFFECTIVE acl. A NULL proacl carries the DEFAULT acl, and for functions
  -- that default grants EXECUTE to PUBLIC: exploding a NULL would read the
  -- widest possible state as "nobody holds anything" (S1-DEFECT-002).
  'functions', (
    SELECT coalesce(jsonb_agg(f ORDER BY f->>'signature'), '[]'::jsonb) FROM (
      -- regprocedure, NOT pg_get_function_identity_arguments. The latter KEEPS
      -- the parameter names — it renders assert_hosted_capabilities as
      -- \`(p_package text)\` — so the contract and the probe never matched and
      -- the function reported as ABSENT against a database where it existed.
      -- Measured; no textual test could have seen it, because the fixtures used
      -- the contract's spelling on both sides.
      --
      -- regprocedure emits bare types, and with an empty search_path it always
      -- qualifies the schema. It is also the spelling the package itself uses
      -- in to_regprocedure(), so there is one form of a signature here.
      SELECT jsonb_build_object(
        'signature', p.oid::regprocedure::text,
        'owner', pg_catalog.pg_get_userbyid(p.proowner),
        'securityDefiner', p.prosecdef,
        'config', to_jsonb(coalesce(p.proconfig, ARRAY[]::text[])),
        'executeGrantees', (
          SELECT coalesce(jsonb_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                                  ELSE a.grantee::regrole::text END), '[]'::jsonb)
          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.privilege_type = 'EXECUTE')
      ) AS f
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid::regprocedure::text IN (
      ${fnList})
    ) AS fns),

  'schemaPublicGrants', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee', r.rolname,
      'usage', pg_catalog.has_schema_privilege(r.rolname, 'public', 'USAGE'),
      'create', pg_catalog.has_schema_privilege(r.rolname, 'public', 'CREATE')
    ) ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roleList})),

  'sentinelTablePresent', (
    SELECT count(*) > 0 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'uellix_bootstrap' AND c.relname = 'staging_sentinel'),

  -- The COUNT and nothing else. Selecting the row would put a project ref in
  -- two artefacts and invite them to disagree; the row's own CHECK constraints
  -- already govern its content.
  'sentinelRowCount', (
    SELECT CASE WHEN to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN 0
                ELSE (SELECT count(*) FROM uellix_bootstrap.staging_sentinel) END)
));

ROLLBACK;
`
}

// ---------------------------------------------------------------------------
// S2 — the sentinel INSERT. The one write of this phase, and a human boundary.
// ---------------------------------------------------------------------------
//
// `planProvisioningPhase` REFUSES `sentinelWriteRequested`, in code, with its
// own test. This file does not weaken that: it is a template a person runs, and
// the identity it writes is a PARAMETER. The repository never learns to claim
// "this database is staging" by itself — it can only help someone say it, and
// say it the same way twice.
//
// Generated for the same reason the probes are: §3 of the provisioning runbook
// fixes two literals, and a row hand-typed from a document is a row that drifts
// from the document by one character.

export function buildSentinelInsertSql(): string {
  const productionRefs = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs.map((r) => `'${r}'`).join(', ')

  return `-- ============================================================================
-- GENERATED — DO NOT EDIT. S2, the staging sentinel row.
-- Regenerate with \`pnpm s2:sentinel:generate\`; \`pnpm s2:sentinel:verify\`
-- compares bytes.
--
-- THIS IS THE ONE WRITE OF PHASE_STELLA_BOOTSTRAP, AND IT IS A HUMAN ACT.
-- stella_hosted_0001 creates the table and leaves it empty on purpose: a
-- bootstrap that minted its own sentinel would be certifying itself.
-- \`planProvisioningPhase\` refuses to write this row, in code, with its own
-- test. This file is a template a PERSON runs; the identity is a parameter, so
-- the repository can help someone make the claim but can never make it alone.
--
--   & \$Psql -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f ${S2_SENTINEL_SQL}
--
-- NO \`-1\`, deliberately, and this is the one place in the programme where that
-- flag is wrong. This file opens and closes its own transaction so the
-- postcondition runs BEFORE the COMMIT. Adding -1 nests them and psql emits
-- three spurious warnings — "there is already a transaction in progress" twice
-- and "there is no transaction in progress" once — on a run that succeeded.
-- Measured. An operator who has just crossed a human boundary should not have
-- to decide whether warnings on the one write of the phase are benign.
--
-- The ref is the one you read from the Supabase dashboard. It is not a secret:
-- a project ref is public in every URL the project serves.
-- ============================================================================
\\if :{?uellix_project_ref}
\\else
\\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\\echo 'The sentinel states which database this is. It cannot be written blind.'
\\quit
\\endif

BEGIN;
SET LOCAL search_path = '';

-- The ref reaches the guards through a transaction-local setting rather than
-- through :'uellix_project_ref' directly, and that is not style. psql's lexer
-- knows about dollar-quoting and does NOT substitute variables inside a
-- \$\$ ... \$\$ body, so the literal text ":'uellix_project_ref'" would reach the
-- server and fail as syntax. Measured, not assumed: the first draft of this
-- file did exactly that.
SELECT pg_catalog.set_config('uellix.sentinel_project_ref', :'uellix_project_ref', true);

DO \$\$
DECLARE
  v_ref text := pg_catalog.current_setting('uellix.sentinel_project_ref');
BEGIN
  -- (1) PRODUCTION DENY, by name, before anything is written.
  IF v_ref IN (${productionRefs}) THEN
    RAISE EXCEPTION 'S2 REFUSED: % is a PRODUCTION project ref. The sentinel declares a database to be staging; writing it there would make production claim to be staging to every gate that reads it.', v_ref;
  END IF;

  -- (2) The shape the table's own CHECK enforces, refused here first so the
  --     message names the problem instead of quoting a constraint.
  IF v_ref !~ '^[a-z]{20}\$' THEN
    RAISE EXCEPTION 'S2 REFUSED: % is not a Supabase project ref (20 lowercase letters).', v_ref;
  END IF;

  -- (3) S1 must have happened. Without the table there is nothing to write to,
  --     and with a row there is already an identity this would duplicate.
  IF to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN
    RAISE EXCEPTION 'S2 REFUSED: uellix_bootstrap.staging_sentinel does not exist. Apply stella_hosted_0001 first (S1).';
  END IF;

  IF (SELECT count(*) FROM uellix_bootstrap.staging_sentinel) <> 0 THEN
    RAISE EXCEPTION 'S2 REFUSED: the sentinel already has a row. This is a ONE-SHOT act by construction — the singleton CHECK admits exactly one, and re-declaring an identity is not a thing that should be easy.';
  END IF;
END \$\$;

INSERT INTO uellix_bootstrap.staging_sentinel
  (environment, project_ref, bootstrap_version, owner_separation)
VALUES
  ('staging', :'uellix_project_ref', '${SENTINEL_BOOTSTRAP_VERSION}',
   '${SENTINEL_OWNER_SEPARATION}');

-- Postcondition, INSIDE the transaction that wrote it. A row that fails this
-- is rolled back rather than left for CHECKPOINT A1 to discover.
DO \$\$
DECLARE
  v_count int;
  v_row   record;
  v_ref   text := pg_catalog.current_setting('uellix.sentinel_project_ref');
BEGIN
  SELECT count(*) INTO v_count FROM uellix_bootstrap.staging_sentinel;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'S2 FAILED: % row(s) after the insert; the sentinel is a singleton.', v_count;
  END IF;

  SELECT * INTO v_row FROM uellix_bootstrap.staging_sentinel;

  IF v_row.environment <> 'staging' THEN
    RAISE EXCEPTION 'S2 FAILED: environment is %, not staging.', v_row.environment;
  END IF;

  IF v_row.project_ref <> v_ref THEN
    RAISE EXCEPTION 'S2 FAILED: the row says % and you declared %.', v_row.project_ref, v_ref;
  END IF;

  IF v_row.bootstrap_version <> '${SENTINEL_BOOTSTRAP_VERSION}' THEN
    RAISE EXCEPTION 'S2 FAILED: bootstrap_version is %, expected ${SENTINEL_BOOTSTRAP_VERSION}.', v_row.bootstrap_version;
  END IF;

  IF position('RR-02' in v_row.owner_separation) = 0 THEN
    RAISE EXCEPTION 'S2 FAILED: owner_separation does not record RR-02. The residual risk is a live property of this database, and an operator reading the sentinel must see it without finding the package.';
  END IF;

  RAISE NOTICE 'S2: sentinel written — environment=staging, project_ref=%, bootstrap_version=%, RR-02 recorded, provisioned_at=%. CHECKPOINT A1 is next, and it is read-only.', v_row.project_ref, v_row.bootstrap_version, v_row.provisioned_at;
END \$\$;

COMMIT;
`
}
