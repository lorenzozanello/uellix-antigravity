// db/hosted/chain-evidence.ts
//
// EVIDENCE FOR PHASE_STELLA_CHAIN — ONE SLOT PER WRITE, AND NONE OF THEM SHARED.
//
// ---------------------------------------------------------------------------
// THE GAP THIS CLOSES, AND HOW IT WAS FOUND
// ---------------------------------------------------------------------------
// `A1_CORROBORATION_ARTEFACT` is a single fixed path. The chain has no journal
// wrappers — the fifty-one in `db/prepared/journal/` cover baseline units only —
// so the read-only corroboration probe re-run IS the evidence instrument after
// every chain write. Those two facts together mean that measuring after T1 would
// have written over `artifacts/hosted-a1-corroboration.json`, and that file is
// the ONLY proof that all nine packages were ABSENT before the chain began.
//
// That is the same defect `S1_EVIDENCE_REGISTRY` was written to close one phase
// earlier, arriving unfixed one phase later: a measurement that can be taken
// exactly once must not share a path with anything a process writes routinely.
// The diff would have read as a routine update.
//
// ---------------------------------------------------------------------------
// SELECTION IS BY DECLARED STEP. NEVER BY RECENCY.
// ---------------------------------------------------------------------------
// No glob, no mtime, no "newest artefact wins", no inference from which files
// happen to exist. `PRECHAIN` and `POST_T1..POST_T9` are ten permanent
// historical facts, none of which supersedes another: PRECHAIN proves the chain
// started from nothing, POST_T4 proves what stella_0013 changed and nothing
// else, and both stay true forever. Recency is not a signal here — not by date,
// not by array position, not by anything on disk.
//
// ---------------------------------------------------------------------------
// WHAT IS REUSED RATHER THAN RE-SPELLED
// ---------------------------------------------------------------------------
// Everything. The probe is `db/prepared/checkpoint-a1/corroboration.sql`
// UNCHANGED, the artefact contract is the one `parseA1Corroboration` already
// enforces, the facts come from `PACKAGE_WITNESSES`, the target from
// `verifyStagingTarget`, the plan from `planProvisioningPhase`, the reapply
// hazards from `PREPARED_PACKAGE_SUPERSESSIONS` and the recovery table from
// `decideRecovery`. This module contributes exactly two things nothing else
// knows: WHICH SLOT a measurement belongs in, and WHAT MUST HAVE CHANGED since
// the previous one.
//
// The probe file is deliberately NOT renamed to something phase-neutral even
// though it now serves ten steps. `artifacts/hosted-a1-corroboration.json` is
// committed and its `measuredBy` field names that exact path; renaming it would
// leave the historical record pointing at a file that does not exist.

import {
  A1_CORROBORATION_ARTEFACT,
  A1_OBSERVATION_SQL,
  A1_STATUS_ARTEFACT,
  JOURNAL_INSTALLED_STATUSES,
  collectSignals,
  parseA1Corroboration,
  type A1Corroboration,
  type A1Signal,
} from './checkpoint-a1'
import { decideRecovery, type FailureKind, type RecoveryDecision } from './baseline-recovery'
import { HOSTED_CHAIN, hostedManifestEntry } from './hosted-package-manifest'
import { PREPARED_PACKAGE_SUPERSESSIONS } from '../prepared-package-order'
import {
  WITNESSED_PACKAGES,
  classifyAllPackages,
  toStellaPackagesInstalled,
  type PackageState,
} from './package-witnesses'
import {
  STELLA_FEATURE_FLAGS,
  planProvisioningPhase,
  type ProvisioningPlan,
} from './hosted-provisioning-runner'
import { type StorageUnitState } from './storage-policy-artifact'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  redactForHostedLog,
  verifyStagingTarget,
  type ProductionIdentifiers,
} from './target-identity'

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

export type ChainStep = string

/** The step before the first write. Its evidence IS the A1 pair, untouched. */
export const PRECHAIN: ChainStep = 'PRECHAIN'

export const chainStepFor = (ordinal: number): ChainStep =>
  ordinal === 0 ? PRECHAIN : `POST_T${ordinal}`

export interface ChainEvidenceEntry {
  /** The selector. The ONLY selector. */
  readonly step: ChainStep
  /** 0 for PRECHAIN, n for the state after the n-th package committed. */
  readonly ordinal: number
  /** The package whose write this step evidences. `null` for PRECHAIN. */
  readonly packageId: string | null
  /** Where the operator records the read-only observation. */
  readonly observationPath: string
  /** Where the derived verdict is written, so a report can only quote it. */
  readonly statusPath: string
  /** The step this one is a delta FROM. `null` for PRECHAIN. */
  readonly previousStep: ChainStep | null
  /**
   * The packages that must be INSTALLED at this step, and by omission the ones
   * that must be ABSENT.
   *
   * DERIVED from the chain order, never written out. Nine hand-maintained maps
   * would be nine chances for one of them to disagree with `HOSTED_CHAIN`, and
   * the one that disagreed would be the one nobody re-read.
   */
  readonly expectedInstalled: readonly string[]
}

/**
 * Ten entries, built from `WITNESSED_PACKAGES` — which is itself derived from
 * `HOSTED_CHAIN`. There is no second list of nine ids anywhere in this file.
 */
export function buildChainEvidenceRegistry(
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): readonly ChainEvidenceEntry[] {
  const entries: ChainEvidenceEntry[] = [
    {
      step: PRECHAIN,
      ordinal: 0,
      packageId: null,
      // THE A1 PAIR, BY REFERENCE. Not a copy, not a new slot: the corroboration
      // the operator measured before the chain began already is this step's
      // evidence, and pointing at it is what makes PRECHAIN resolvable forever
      // without anything ever writing there again.
      observationPath: A1_CORROBORATION_ARTEFACT,
      statusPath: A1_STATUS_ARTEFACT,
      previousStep: null,
      expectedInstalled: [],
    },
  ]
  packageIds.forEach((packageId, index) => {
    const ordinal = index + 1
    entries.push({
      step: chainStepFor(ordinal),
      ordinal,
      packageId,
      observationPath: `artifacts/hosted-chain-t${ordinal}-observation.json`,
      statusPath: `artifacts/hosted-chain-t${ordinal}-status.json`,
      previousStep: chainStepFor(ordinal - 1),
      expectedInstalled: packageIds.slice(0, ordinal),
    })
  })
  return entries
}

export const CHAIN_EVIDENCE_REGISTRY: readonly ChainEvidenceEntry[] = buildChainEvidenceRegistry()

export type ChainRefusalCode =
  | 'CHAIN_REGISTRY_EMPTY'
  | 'CHAIN_REGISTRY_STEP_DUPLICATED'
  | 'CHAIN_REGISTRY_PATH_COLLISION'
  | 'CHAIN_REGISTRY_ORDINAL_BROKEN'
  | 'CHAIN_REGISTRY_PACKAGE_ORDER'
  | 'CHAIN_STEP_NOT_DECLARED'
  | 'CHAIN_STEP_IS_PRECHAIN'
  | 'CHAIN_OBSERVATION_ABSENT'
  | 'CHAIN_OBSERVATION_REFUSED'
  | 'CHAIN_PREVIOUS_EVIDENCE_MISSING'
  | 'CHAIN_PREVIOUS_EVIDENCE_REFUSED'
  | 'CHAIN_TARGET_REFUSED'
  | 'CHAIN_PARTIAL_STATE'
  | 'CHAIN_PREFIX_VIOLATION'
  | 'CHAIN_DELTA_NOT_SINGLETON'
  | 'CHAIN_DELTA_WRONG_PACKAGE'
  | 'CHAIN_DELTA_REGRESSION'
  | 'CHAIN_STORAGE_UNIT_UNMEASURED'

export interface ChainRefusal {
  readonly ok: false
  readonly code: ChainRefusalCode
  readonly detail: string
}

const refuse = (code: ChainRefusalCode, detail: string): ChainRefusal => ({
  ok: false,
  code,
  detail: redactForHostedLog(detail),
})

export type ChainStepResolution = { readonly ok: true; readonly entry: ChainEvidenceEntry } | ChainRefusal

/**
 * Picks the entry for a step, or refuses.
 *
 * The WHOLE registry is checked before any entry is used, exactly as
 * `resolveS1Evidence` does: a duplicated step or a shared path is a defect in
 * the map itself, and one discovered only by whichever lookup happened to hit it
 * is one that has already been trusted somewhere else.
 */
export function resolveChainStep(
  step: ChainStep,
  registry: readonly ChainEvidenceEntry[] = CHAIN_EVIDENCE_REGISTRY,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): ChainStepResolution {
  if (registry.length === 0) {
    return refuse(
      'CHAIN_REGISTRY_EMPTY',
      'no chain evidence is declared. Unmeasured is not satisfied, and undeclared is not measured.',
    )
  }

  for (const candidate of registry) {
    const same = registry.filter((e) => e.step === candidate.step)
    if (same.length > 1) {
      return refuse(
        'CHAIN_REGISTRY_STEP_DUPLICATED',
        `step ${candidate.step} is declared ${same.length} times. Two answers to one question is the divergence this registry exists to prevent.`,
      )
    }
  }

  for (const a of registry) {
    for (const b of registry) {
      if (a === b) continue
      // BOTH KINDS OF PATH, AND ACROSS KINDS. A status slot colliding with
      // another step's observation slot is the same defect wearing a different
      // hat: a later write destroys an earlier measurement.
      for (const [pa, la] of [
        [a.observationPath, `${a.step} observation`],
        [a.statusPath, `${a.step} status`],
      ] as const) {
        for (const [pb, lb] of [
          [b.observationPath, `${b.step} observation`],
          [b.statusPath, `${b.step} status`],
        ] as const) {
          if (pa === pb) {
            return refuse(
              'CHAIN_REGISTRY_PATH_COLLISION',
              `${la} and ${lb} both resolve to ${pa}. THAT SHARED PATH IS THE DEFECT THIS REGISTRY WAS WRITTEN TO CLOSE: the second measurement overwrites the first, and the diff reads as a routine update.`,
            )
          }
        }
      }
    }
  }

  // ORDINALS: 0..n with no gap, no repeat, and in order.
  const ordinals = registry.map((e) => e.ordinal)
  const expectedOrdinals = registry.map((_, i) => i)
  if (JSON.stringify(ordinals) !== JSON.stringify(expectedOrdinals)) {
    return refuse(
      'CHAIN_REGISTRY_ORDINAL_BROKEN',
      `ordinals are ${ordinals.join(',')}; a chain registry is 0..${registry.length - 1} in order. A gap or a repeat makes "the previous step" ambiguous, and the delta is computed against exactly that.`,
    )
  }

  // PACKAGE ORDER: the registry's packages ARE the chain, in the chain's order.
  const declaredPackages = registry.filter((e) => e.packageId !== null).map((e) => e.packageId as string)
  if (JSON.stringify(declaredPackages) !== JSON.stringify([...packageIds])) {
    return refuse(
      'CHAIN_REGISTRY_PACKAGE_ORDER',
      `the registry evidences ${declaredPackages.join(', ') || 'nothing'}; HOSTED_CHAIN is ${packageIds.join(', ')}. A registry in a different order would compute every delta against the wrong predecessor.`,
    )
  }

  const entry = registry.find((e) => e.step === step)
  if (entry === undefined) {
    return refuse(
      'CHAIN_STEP_NOT_DECLARED',
      `no entry declares step ${JSON.stringify(step)}. Declared: ${registry.map((e) => e.step).join(', ')}.`,
    )
  }
  return { ok: true, entry }
}

/** `--after=<package-id>` -> the step that records the state after that write. */
export function chainStepForPackage(
  packageId: string,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): ChainStep | null {
  const index = packageIds.indexOf(packageId)
  return index === -1 ? null : chainStepFor(index + 1)
}

/* -------------------------------------------------------------------------- */
/* Operative units — where stopping between two writes is not a resting place  */
/* -------------------------------------------------------------------------- */
//
// `db/prepared/README.md` §AVISO OPERATIVO measures why: re-applying
// grounding_0003 alone silently reverts BOTH of grounding_0004's security
// repairs. Its §5 re-grants SELECT on public.evidence_chunks to `authenticated`
// and its §6 re-creates the select policy WITHOUT `uellix_cap_grounding`, after
// which every governed read returns the EMPTY SET in silence — chunks_in_scope
// answers zero rows, finalize_document_ingestion calls every ingestion
// incomplete, register_document_version pins every document at ordinal 1. No
// self-verification catches it, by construction: grounding_0003 §9 asserts ITS
// final state, which is exactly the one it just produced.
//
// So the three grounding packages are ONE OPERATIVE UNIT and the middle of it is
// not a place to stand. This must produce neither of the two opposite errors:
//
//   A. normalising "T2 applied, T3 absent" as fine, which invites an operator to
//      stop there and leaves the surface open;
//   B. calling it corruption, which would make it impossible to evidence the
//      legitimate write that happened before T3 ran — and evidencing each write
//      individually is the entire point of this registry.
//
// The resolution is a DISPOSITION beside the verdict. The write is VERIFIED and
// the state is TRANSIENT, and the only authorised next action is the next member
// of the unit.

export interface OperativeUnit {
  readonly id: string
  /** Members in chain order. Declared, then anchored to the manifest by a test. */
  readonly members: readonly string[]
  /** Why stopping inside it is unsafe. Shown on every transient status. */
  readonly hazard: string
}

export const OPERATIVE_UNITS: readonly OperativeUnit[] = [
  {
    id: 'grounding-unit',
    members: [
      'grounding_0002_document_versions',
      'grounding_0003_evidence_chunks',
      'grounding_0004_runtime_attestation',
    ],
    hazard:
      'grounding_0002 -> 0003 -> 0004 is applied as ONE unit. grounding_0003 standing without ' +
      'grounding_0004 re-grants SELECT on public.evidence_chunks to authenticated and leaves the ' +
      'select policy without uellix_cap_grounding, so INT-CAP-002 is open AND every governed read ' +
      'returns the empty set in silence. Nothing raises; a missing GRANT throws, a missing POLICY ' +
      'says nothing. See db/prepared/README.md, AVISO OPERATIVO.',
  },
]

export type Disposition = 'STABLE' | 'TRANSIENT'

export interface StepDisposition {
  readonly disposition: Disposition
  /** False for every non-final member of an operative unit. */
  readonly safeToStop: boolean
  readonly transientReason: string | null
  /** The ONLY package that may be applied next while transient. */
  readonly requiredNextPackage: string | null
}

/**
 * Derived from the declared units, never from nine hand-written cases.
 *
 * A step is TRANSIENT when its package is a member of an operative unit and is
 * not that unit's LAST member. The requirement then names exactly the next
 * member, so a status cannot authorise anything else.
 */
export function dispositionFor(
  packageId: string | null,
  units: readonly OperativeUnit[] = OPERATIVE_UNITS,
): StepDisposition {
  const STABLE: StepDisposition = {
    disposition: 'STABLE',
    safeToStop: true,
    transientReason: null,
    requiredNextPackage: null,
  }
  if (packageId === null) return STABLE
  for (const unit of units) {
    const index = unit.members.indexOf(packageId)
    if (index === -1 || index === unit.members.length - 1) continue
    return {
      disposition: 'TRANSIENT',
      safeToStop: false,
      transientReason: unit.hazard,
      requiredNextPackage: unit.members[index + 1]!,
    }
  }
  return STABLE
}

/* -------------------------------------------------------------------------- */
/* Reapply hazards — read from the executable contract, not restated           */
/* -------------------------------------------------------------------------- */

/**
 * What re-applying already-installed packages would republish, given the state.
 *
 * SOURCED FROM `PREPARED_PACKAGE_SUPERSESSIONS`, which is the migrator's own
 * table and already carries the probe, the reason and the exact objects. A
 * second table here would be a second spelling of a refusal that already exists,
 * and the migrator would keep whichever one it happened to consult.
 *
 * These are WARNINGS on a status, never decisions. The registry contributes
 * facts; the migrator refuses.
 */
export function reapplyHazards(installed: readonly string[]): readonly string[] {
  const present = new Set(installed)
  return PREPARED_PACKAGE_SUPERSESSIONS.filter(
    (rule) => present.has(rule.packageName) && present.has(rule.supersededBy),
  ).map(
    (rule) =>
      `${rule.packageName} must NOT be re-applied: ${rule.supersededBy} is installed and supersedes it. ` +
      `Re-application would republish ${rule.wouldRepublish.join(', ')}.`,
  )
}

/* -------------------------------------------------------------------------- */
/* Evaluating one step                                                         */
/* -------------------------------------------------------------------------- */

export interface ChainDelta {
  readonly previousStep: ChainStep
  readonly previousObservation: string
  /** Packages that went ABSENT -> INSTALLED. Exactly one is the contract. */
  readonly newlyInstalled: readonly string[]
  /** Packages that went INSTALLED -> ABSENT. Any at all is a refusal. */
  readonly regressed: readonly string[]
  /** Packages whose state is unchanged. */
  readonly unchanged: number
}

export interface ChainStepVerdict {
  readonly step: ChainStep
  readonly ordinal: number
  readonly packageId: string | null
  readonly observationArtefact: string
  readonly statusArtefact: string
  readonly observationPresent: boolean
  readonly refusal: ChainRefusal | null
  readonly signals: readonly A1Signal[]
  readonly targetVerification: {
    readonly ok: boolean
    readonly code: string | null
    readonly projectRef: string | null
    readonly signals: readonly string[]
  } | null
  readonly sentinelProjectRef: string | null
  readonly flags: { readonly evaluated: number; readonly enabled: readonly string[] } | null
  readonly expectedInstalled: readonly string[]
  readonly packageStates: Readonly<Record<string, PackageState>>
  readonly partialPackages: readonly string[]
  readonly delta: ChainDelta | null
  readonly disposition: Disposition
  readonly safeToStop: boolean
  readonly transientReason: string | null
  /**
   * The one package that may follow a TRANSIENT step, `null` when STABLE.
   *
   * Carried SEPARATELY from `authorizedNextActions` because the disposition is
   * known from the registry alone and survives every refusal, while the
   * authorised actions are only computable once the step verifies. A report that
   * read the requirement out of the actions printed "TRANSIENT — null REQUIRED
   * NEXT" on the one path where an operator most needs the name: the step that
   * has not been measured yet.
   */
  readonly requiredNextPackage: string | null
  readonly authorizedNextActions: readonly string[]
  readonly lastSuccessfullyInstalledPackage: string | null
  readonly expectedNextPackage: string | null
  readonly resumable: boolean
  readonly reapplyWarnings: readonly string[]
  readonly chainPlan: {
    readonly ok: boolean
    readonly code: string | null
    readonly stepCount: number
    readonly steps: readonly string[]
    readonly writesPermitted: boolean
    readonly sequenceComplete: boolean
    readonly nextAction: string | null
  } | null
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
  /** The write landed exactly as the contract requires. NOT "you may stop". */
  readonly stepVerified: boolean
}

export interface ChainStepEvaluationInputs {
  readonly step: ChainStep
  /** Reads a repo-relative artefact path. Injectable so tests never touch artifacts/**. */
  readonly readArtefact: (repoRelativePath: string) => string | null
  readonly readBaselineSql: (file: string) => string | null
  readonly stellaSources: Readonly<Record<string, string>>
  readonly storageUnitState: StorageUnitState | null
  readonly registry?: readonly ChainEvidenceEntry[]
  readonly packageIds?: readonly string[]
  readonly units?: readonly OperativeUnit[]
  readonly production?: ProductionIdentifiers
  readonly expectedProjectRef?: string
}

const EMPTY = {
  signals: [] as readonly A1Signal[],
  targetVerification: null,
  sentinelProjectRef: null,
  flags: null,
  packageStates: {} as Readonly<Record<string, PackageState>>,
  partialPackages: [] as readonly string[],
  delta: null,
  chainPlan: null,
  warnings: [] as readonly string[],
  stepVerified: false,
}

/** Measured states for one artefact, or a refusal. Never a status's opinion. */
function statesFromObservation(
  raw: string | null,
  expectedProjectRef: string,
  production: ProductionIdentifiers,
):
  | { readonly ok: true; readonly corroboration: A1Corroboration; readonly states: Record<string, PackageState> }
  | { readonly ok: false; readonly code: string; readonly detail: string } {
  const parsed = parseA1Corroboration(raw, expectedProjectRef, production)
  if (!parsed.ok) return { ok: false, code: parsed.code, detail: parsed.detail }
  const observed = Object.fromEntries(
    parsed.corroboration.observation.packageObservations.flatMap((p) => Object.entries(p.witnesses)),
  )
  const classified = classifyAllPackages(observed)
  if (!classified.ok) return { ok: false, code: classified.code, detail: classified.detail }
  return {
    ok: true,
    corroboration: parsed.corroboration,
    states: Object.fromEntries(classified.classifications.map((c) => [c.packageId, c.state])),
  }
}

/**
 * One step, end to end.
 *
 * ORDER IS THE CONTRACT, and it is the same order CHECKPOINT A1 uses: the
 * registry before any path is read; the observation before it is trusted; the
 * TARGET before the packages, because a correct package inventory of the wrong
 * database is worse than none; the prefix before the delta; and the plan LAST,
 * computed by the real runner.
 *
 * THE TARGET IS RE-CORROBORATED HERE, PER STEP, from THIS step's artefact. A1's
 * signal 1 proves which connection took the A1 measurement and nothing about a
 * write that happened afterwards; reusing it would be exactly the aliasing this
 * whole design exists to prevent.
 */
export function evaluateChainStep(inputs: ChainStepEvaluationInputs): ChainStepVerdict {
  const registry = inputs.registry ?? CHAIN_EVIDENCE_REGISTRY
  const packageIds = inputs.packageIds ?? WITNESSED_PACKAGES
  const units = inputs.units ?? OPERATIVE_UNITS
  const production = inputs.production ?? KNOWN_PRODUCTION_IDENTIFIERS
  const expectedProjectRef = inputs.expectedProjectRef ?? KNOWN_STAGING_PROJECT_REF

  const base = {
    ...EMPTY,
    step: inputs.step,
    ordinal: -1,
    packageId: null as string | null,
    observationArtefact: '(unresolved)',
    statusArtefact: '(unresolved)',
    observationPresent: false,
    expectedInstalled: [] as readonly string[],
    disposition: 'STABLE' as Disposition,
    safeToStop: false,
    transientReason: null as string | null,
    requiredNextPackage: null as string | null,
    authorizedNextActions: [] as readonly string[],
    lastSuccessfullyInstalledPackage: null as string | null,
    expectedNextPackage: null as string | null,
    resumable: false,
    reapplyWarnings: [] as readonly string[],
  }

  const resolved = resolveChainStep(inputs.step, registry, packageIds)
  if (!resolved.ok) {
    return { ...base, refusal: resolved, blockers: [`${resolved.code}: ${resolved.detail}`] }
  }
  const entry = resolved.entry

  if (entry.packageId === null) {
    // PRECHAIN's verdict is CHECKPOINT A1's, and it already has one. Producing a
    // second verdict over the same artefact is how two numbers about one fact
    // start to disagree.
    const r = refuse(
      'CHAIN_STEP_IS_PRECHAIN',
      `${PRECHAIN} is CHECKPOINT A1 and it already carries its own verdict at ${A1_STATUS_ARTEFACT}. Use \`pnpm a1:status\`. This registry resolves the step so every delta can be computed against it; it does not re-judge it.`,
    )
    return {
      ...base,
      ordinal: entry.ordinal,
      observationArtefact: entry.observationPath,
      statusArtefact: entry.statusPath,
      refusal: r,
      blockers: [`${r.code}: ${r.detail}`],
    }
  }

  const disposition = dispositionFor(entry.packageId, units)
  const shaped = {
    ...base,
    ordinal: entry.ordinal,
    packageId: entry.packageId,
    observationArtefact: entry.observationPath,
    statusArtefact: entry.statusPath,
    expectedInstalled: entry.expectedInstalled,
    disposition: disposition.disposition,
    safeToStop: disposition.safeToStop,
    transientReason: disposition.transientReason,
    requiredNextPackage: disposition.requiredNextPackage,
  }

  /* (1) THIS step's observation. */
  const raw = inputs.readArtefact(entry.observationPath)
  if (raw === null || raw.trim() === '') {
    const r = refuse(
      'CHAIN_OBSERVATION_ABSENT',
      `${entry.observationPath} is absent. Run ${A1_OBSERVATION_SQL} read-only against the target and record its output THERE — not over another step's artefact, which is a different historical fact that cannot be re-measured.`,
    )
    return { ...shaped, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }
  const here = statesFromObservation(raw, expectedProjectRef, production)
  if (!here.ok) {
    const r = refuse('CHAIN_OBSERVATION_REFUSED', `${entry.observationPath}: ${here.code} — ${here.detail}`)
    return { ...shaped, observationPresent: true, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }
  const c = here.corroboration
  const signals = collectSignals(c)
  const withObs = { ...shaped, observationPresent: true, signals, packageStates: here.states }

  /* (2) THE TARGET, from THIS step's own three signals. */
  const identity = verifyStagingTarget(
    {
      declaredEnvironment: c.declaredEnvironment,
      declaredProjectRef: c.declaredProjectRef,
      connectionHost: c.connection.connectionHost,
      poolerUser: c.connection.poolerUser,
      connectionPort: c.connection.connectionPort,
      sentinel: {
        environment: c.observation.sentinelObservation.environment ?? '',
        projectRef: c.observation.sentinelObservation.projectRef ?? '',
      },
    },
    production,
    'required',
    expectedProjectRef,
  )
  const targetVerification = identity.ok
    ? { ok: true, code: null, projectRef: identity.projectRef, signals: identity.signals }
    : { ok: false, code: identity.code, projectRef: null, signals: [] as readonly string[] }
  const sentinelProjectRef = c.observation.sentinelObservation.projectRef ?? null

  if (!identity.ok) {
    const r = refuse('CHAIN_TARGET_REFUSED', `${identity.code}: ${identity.message}`)
    return { ...withObs, targetVerification, sentinelProjectRef, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }

  const flags = { evaluated: STELLA_FEATURE_FLAGS.length, enabled: enabledFlagNames(c.featureFlags) }
  const withTarget = { ...withObs, targetVerification, sentinelProjectRef, flags }

  /* (3) NO PARTIALS, ANYWHERE. */
  const partialPackages = packageIds.filter((p) => here.states[p] === 'PARTIAL_OR_INCONSISTENT')
  if (partialPackages.length > 0) {
    const r = refuse(
      'CHAIN_PARTIAL_STATE',
      `${partialPackages.join(', ')} measured PARTIAL_OR_INCONSISTENT. A half-installed package is not an absent one and it is not an installed one; there is no state of the chain in which it is a thing to continue from.`,
    )
    return { ...withTarget, partialPackages, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }

  /* (4) THE PREFIX, derived from the chain order. */
  const shouldBeInstalled = new Set(entry.expectedInstalled)
  const missing = entry.expectedInstalled.filter((p) => here.states[p] !== 'INSTALLED')
  const unexpected = packageIds.filter((p) => !shouldBeInstalled.has(p) && here.states[p] !== 'ABSENT')
  if (missing.length > 0 || unexpected.length > 0) {
    const r = refuse(
      'CHAIN_PREFIX_VIOLATION',
      `${entry.step} requires exactly ${entry.expectedInstalled.length} installed package(s), in chain order. ` +
        `not installed but must be: ${missing.join(', ') || 'none'}; installed but must not be: ${unexpected.join(', ') || 'none'}. ` +
        `A package ahead of its turn means a write happened that this evidence does not account for.`,
    )
    return { ...withTarget, partialPackages, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }

  /* (5) THE DELTA, measurement against measurement. */
  const previousEntry = registry.find((e) => e.step === entry.previousStep)
  if (previousEntry === undefined) {
    const r = refuse(
      'CHAIN_PREVIOUS_EVIDENCE_MISSING',
      `${entry.step} declares its predecessor as ${String(entry.previousStep)} and the registry has no such step.`,
    )
    return { ...withTarget, partialPackages, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }
  const previousRaw = inputs.readArtefact(previousEntry.observationPath)
  if (previousRaw === null || previousRaw.trim() === '') {
    const r = refuse(
      'CHAIN_PREVIOUS_EVIDENCE_MISSING',
      `${previousEntry.observationPath} is absent, so there is nothing to compute this step's delta against. ` +
        `A snapshot with the right prefix is not proof that ONE write produced it — the prefix would look identical after two.`,
    )
    return { ...withTarget, partialPackages, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }
  const before = statesFromObservation(previousRaw, expectedProjectRef, production)
  if (!before.ok) {
    const r = refuse(
      'CHAIN_PREVIOUS_EVIDENCE_REFUSED',
      `${previousEntry.observationPath}: ${before.code} — ${before.detail}`,
    )
    return { ...withTarget, partialPackages, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }

  const newlyInstalled = packageIds.filter(
    (p) => before.states[p] === 'ABSENT' && here.states[p] === 'INSTALLED',
  )
  const regressed = packageIds.filter(
    (p) => before.states[p] === 'INSTALLED' && here.states[p] !== 'INSTALLED',
  )
  const unchanged = packageIds.filter((p) => before.states[p] === here.states[p]).length
  const delta: ChainDelta = {
    previousStep: previousEntry.step,
    previousObservation: previousEntry.observationPath,
    newlyInstalled,
    regressed,
    unchanged,
  }
  const withDelta = { ...withTarget, partialPackages, delta }

  if (regressed.length > 0) {
    const r = refuse(
      'CHAIN_DELTA_REGRESSION',
      `${regressed.join(', ')} was INSTALLED at ${previousEntry.step} and is not now. A chain package does not un-apply itself; something ran against this database that no evidence accounts for.`,
    )
    return { ...withDelta, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }
  // EXACTLY ONE. Not "at least one": two packages between measurements means one
  // of the two writes has no evidence of its own, which is the whole thing this
  // registry is for.
  if (newlyInstalled.length !== 1) {
    const r = refuse(
      'CHAIN_DELTA_NOT_SINGLETON',
      `${newlyInstalled.length} package(s) went ABSENT -> INSTALLED between ${previousEntry.step} and ${entry.step}` +
        (newlyInstalled.length > 0 ? ` (${newlyInstalled.join(', ')})` : '') +
        `. EXACTLY ONE is the contract: measure after every write, because two writes sharing one measurement leave the first with no evidence that can ever be produced again.`,
    )
    return { ...withDelta, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }
  if (newlyInstalled[0] !== entry.packageId) {
    const r = refuse(
      'CHAIN_DELTA_WRONG_PACKAGE',
      `${entry.step} evidences ${entry.packageId} and the delta shows ${newlyInstalled[0]} was installed instead.`,
    )
    return { ...withDelta, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }

  /* (6) UNIT 41 — unmeasured is refused, like every other probe. */
  if (inputs.storageUnitState === null) {
    const r = refuse(
      'CHAIN_STORAGE_UNIT_UNMEASURED',
      'unit 41 has two halves applied through two channels and its state comes from artifacts/hosted-storage-boundary-status.json. Absent means unknown, and the runner treats unknown as not installed rather than as done.',
    )
    return { ...withDelta, refusal: r, blockers: [`${r.code}: ${r.detail}`] }
  }

  /* (7) REPLAN, by the real runner, over the state just measured. */
  const installedMap = toStellaPackagesInstalled(
    packageIds.map((p) => ({
      packageId: p,
      state: here.states[p]!,
      presentWitnesses: [],
      missingWitnesses: [],
      violatedRequiredAbsences: [],
    })),
  )
  const plan: ProvisioningPlan | null = installedMap.ok
    ? planProvisioningPhase({
        phase: 'PHASE_STELLA_CHAIN',
        // READ-ONLY BY CONSTRUCTION. A step's evidence never authorises a write.
        mode: 'dry-run',
        target: {
          declaredEnvironment: c.declaredEnvironment,
          declaredProjectRef: c.declaredProjectRef,
          connectionHost: c.connection.connectionHost,
          poolerUser: c.connection.poolerUser,
          connectionPort: c.connection.connectionPort,
          sentinel: {
            environment: c.observation.sentinelObservation.environment ?? '',
            projectRef: c.observation.sentinelObservation.projectRef ?? '',
          },
        },
        state: {
          baselineUnitsInstalled: c.observation.baselineJournal.units
            .filter((u) => JOURNAL_INSTALLED_STATUSES.includes(u.status))
            .map((u) => u.packageId),
          bootstrapSchemaPresent: c.observation.bootstrapSchemaPresent,
          sentinel: {
            environment: c.observation.sentinelObservation.environment ?? '',
            projectRef: c.observation.sentinelObservation.projectRef ?? '',
          },
          stellaPackagesInstalled: {
            ...installedMap.stellaPackagesInstalled,
            stella_hosted_0001_managed_role_bootstrap: true,
          },
          businessRowCounts: null,
          storageUnitState: inputs.storageUnitState,
        },
        featureFlags: c.featureFlags,
        readBaselineSql: inputs.readBaselineSql,
        stellaSources: inputs.stellaSources,
        production,
      })
    : null

  const chainPlan =
    plan === null
      ? null
      : plan.ok
        ? {
            ok: true,
            code: null,
            stepCount: plan.steps.length,
            steps: plan.steps.map((s) => s.id),
            writesPermitted: plan.writesPermitted,
            sequenceComplete: plan.sequenceComplete,
            nextAction: plan.nextAction,
          }
        : {
            ok: false,
            code: String(plan.code),
            stepCount: 0,
            steps: [] as string[],
            writesPermitted: false,
            sequenceComplete: false,
            nextAction: null,
          }

  const blockers: string[] = []
  if (plan === null) blockers.push(`${installedMap.ok ? '' : installedMap.code}: the plan could not be computed`)
  else if (!plan.ok) blockers.push(`${String(plan.code)}: ${plan.message}`)

  /* (8) WHAT MAY HAPPEN NEXT. */
  const remaining = packageIds.slice(entry.ordinal)
  const expectedNextPackage = remaining[0] ?? null
  const authorizedNextActions =
    disposition.requiredNextPackage !== null
      ? [`apply ${disposition.requiredNextPackage}`]
      : expectedNextPackage !== null
        ? [`apply ${expectedNextPackage}`]
        : ['PHASE_STELLA_CHAIN is complete; run CHECKPOINT C']

  const warnings = [...reapplyHazards(entry.expectedInstalled)]
  if (!disposition.safeToStop) {
    warnings.unshift(
      `TRANSIENT — ${disposition.requiredNextPackage} REQUIRED NEXT. ${disposition.transientReason}`,
    )
  }

  return {
    ...withDelta,
    refusal: null,
    chainPlan,
    authorizedNextActions,
    lastSuccessfullyInstalledPackage: entry.packageId,
    expectedNextPackage,
    // RESUMABLE means the runner produced a plan from this exact state, which is
    // a stronger claim than "nothing looks wrong".
    resumable: chainPlan?.ok === true,
    reapplyWarnings: reapplyHazards(entry.expectedInstalled),
    blockers,
    warnings,
    stepVerified: blockers.length === 0,
  }
}

function enabledFlagNames(flags: Readonly<Record<string, string | boolean>>): string[] {
  const OFF = new Set(['false', '0', 'no', 'off', ''])
  return STELLA_FEATURE_FLAGS.filter((name) => {
    const raw = flags[name]
    if (raw === undefined || raw === null) return false
    if (typeof raw === 'boolean') return raw
    return !OFF.has(raw.trim().toLowerCase())
  })
}

/* -------------------------------------------------------------------------- */
/* Recovery — the existing table, driven, never re-written                     */
/* -------------------------------------------------------------------------- */

export interface ChainRecoveryQuestion {
  /** The package whose apply failed. */
  readonly failedPackage: string
  readonly failureKind: FailureKind
  /** Did it run under `psql -1`? False makes every answer HALT_AND_ESCALATE. */
  readonly singleTransaction: boolean
  readonly manualWritesOccurred?: boolean
  readonly holdsIrreplaceableData?: boolean
}

/**
 * Delegates to `decideRecovery`. There is deliberately no second rule table.
 *
 * The one thing added is the operative-unit constraint: if the failure happened
 * inside the grounding unit, whatever strategy comes back, the FIRST thing the
 * operator may do is finish the unit — the transient state is not a place to
 * pause while somebody decides.
 */
export function chainRecovery(
  question: ChainRecoveryQuestion,
  units: readonly OperativeUnit[] = OPERATIVE_UNITS,
): RecoveryDecision & { readonly unitConstraint: string | null } {
  const decision = decideRecovery({
    phase: 'PHASE_STELLA_CHAIN',
    failedUnit: question.failedPackage,
    failureKind: question.failureKind,
    singleTransaction: question.singleTransaction,
    manualWritesOccurred: question.manualWritesOccurred ?? false,
    holdsIrreplaceableData: question.holdsIrreplaceableData ?? false,
  })
  const unit = units.find((u) => u.members.includes(question.failedPackage))
  const index = unit?.members.indexOf(question.failedPackage) ?? -1
  const unitConstraint =
    unit !== undefined && index !== -1 && index < unit.members.length - 1
      ? `${question.failedPackage} is inside the ${unit.id}. Whatever this strategy resolves to, the database must not be left with ` +
        `${unit.members[index]} applied and ${unit.members[index + 1]} absent. ${unit.hazard}`
      : null
  return { ...decision, unitConstraint }
}

/* -------------------------------------------------------------------------- */
/* The status artefact                                                         */
/* -------------------------------------------------------------------------- */

export function computeChainStatus(inputs: ChainStepEvaluationInputs): Record<string, unknown> {
  const v = evaluateChainStep(inputs)
  return {
    generatedBy: 'pnpm chain:status:write --after=<package-id> — do not hand-edit; derived from the observation',
    step: v.step,
    ordinal: v.ordinal,
    packageId: v.packageId,
    observationArtefact: v.observationArtefact,
    observationPresent: v.observationPresent,
    signals: v.signals,
    targetVerification: v.targetVerification,
    sentinelProjectRef: v.sentinelProjectRef,
    flags: v.flags,
    expectedInstalled: v.expectedInstalled,
    packageStates: v.packageStates,
    partialPackages: v.partialPackages,
    delta: v.delta,
    disposition: v.disposition,
    safeToStop: v.safeToStop,
    transientReason: v.transientReason,
    requiredNextPackage: v.requiredNextPackage,
    authorizedNextActions: v.authorizedNextActions,
    lastSuccessfullyInstalledPackage: v.lastSuccessfullyInstalledPackage,
    expectedNextPackage: v.expectedNextPackage,
    resumable: v.resumable,
    reapplyWarnings: v.reapplyWarnings,
    chainPlan: v.chainPlan,
    blockers: v.blockers,
    warnings: v.warnings,
    // THE ONE VALUE A REPORT MAY QUOTE, AND IT IS NOT "DONE". It says the write
    // this step evidences landed exactly as the contract requires. `safeToStop`
    // is the separate question, and for a transient step the answer is no.
    stepVerified: v.stepVerified,
  }
}

export const serializeChainStatus = (status: Record<string, unknown>): string =>
  `${JSON.stringify(status, null, 2)}\n`

export type ChainStatusVerification =
  | { readonly ok: true; readonly present: boolean; readonly note: string }
  | { readonly ok: false; readonly present: true; readonly note: string }

export function verifyChainStatus(
  onDisk: string | null,
  expected: string,
  statusPath: string,
): ChainStatusVerification {
  if (onDisk === null) {
    return { ok: true, present: false, note: `${statusPath} not present yet — nothing to verify` }
  }
  if (onDisk.replace(/\r\n?/g, '\n') !== expected) {
    return {
      ok: false,
      present: true,
      note:
        `${statusPath} DIVERGED from what the contract computes today. Either the observation changed, ` +
        `or the status was edited. A status a document quotes and nothing recomputes is a number that ` +
        `will eventually be wrong in the direction that flatters the author.`,
    }
  }
  return { ok: true, present: true, note: 'the recorded verdict is what the contract computes over the recorded observation' }
}

/** The chain, for a reader: nine ids and their manifest order. Derived. */
export const CHAIN_PACKAGE_ORDER: readonly string[] = WITNESSED_PACKAGES
export const CHAIN_MANIFEST_ORDER: readonly string[] = HOSTED_CHAIN
export { hostedManifestEntry }
