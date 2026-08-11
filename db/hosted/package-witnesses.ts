// db/hosted/package-witnesses.ts
//
// WHICH CHAIN PACKAGES ARE INSTALLED, MEASURED RATHER THAN ASSUMED.
//
// `planProvisioningPhase` refuses a chain plan without this: "an unprobed
// successor is unknown, not absent", because re-applying stella_0014 over an
// installed stella_0015 would republish four project-blind signatures. UNKNOWN
// IS NOT FALSE, and nothing here converts it.
//
// ---------------------------------------------------------------------------
// WHY NOT `expectedObjects`
// ---------------------------------------------------------------------------
// The manifest's `expectedObjects` is prose for a human reviewer, not a
// catalogue inventory. Measured: its entries begin with `three`, `both`, `two`,
// `RLS`, `six`, `the`, `fourth`, `SQLSTATE` — `"SQLSTATE U0112"` names no
// object at all, `"the four project-blind signatures DROPPED"` is an ABSENCE,
// and `"the three-argument bind now raises U0106"` is a behaviour. It also
// contains at least one error: it says `uellix_stella.operation_tickets` where
// stella_0014 L274 creates `uellix_stella_ops.operation_tickets`. A parser over
// that would fail silently in the one gate that authorises the chain.
//
// So the witnesses are declared here and anchored to the canonical SQL, with
// every signature transcribed from the source line that creates or drops it.
//
// ---------------------------------------------------------------------------
// WHAT MAKES A WITNESS SAFE
// ---------------------------------------------------------------------------
// Two properties, both learned from near-misses in review:
//
//   * IT MUST SURVIVE ITS SUCCESSORS. stella_0014 creates
//     `bind_operation_ticket(bpchar, bpchar)` — and stella_0015 DROPS it. A
//     witness like that would flip a correctly-installed T5 to ABSENT the
//     moment T6 landed. T5 is witnessed by its schema, role, table and the two
//     functions nothing later touches.
//
//   * IT MUST NAME A VERSION, NOT A FUNCTION. `settle_reserved_quota` exists
//     in stella_0016 with 5 arguments and in stella_0017 with 10; stella_0017
//     re-creates the 5-argument one too. A witness by NAME would report T8
//     installed as soon as T7 was. Arity is the discriminator, so every
//     function witness carries a full signature.
//
// stella_0016 is the case that makes the second rule concrete in the other
// direction: it redefines the BODIES of `bind`/`complete` at the same 3-argument
// signatures stella_0015 created, and introduces no new signature of its own.
// Those two therefore cannot witness it at all, and it is identified by
// `stella_capacity`, `consume_stella_capacity` and the 5-argument settle.

import { HOSTED_CHAIN } from './hosted-package-manifest'

export type WitnessKind =
  | 'role'
  | 'schema'
  | 'regclass'
  | 'regprocedure'
  | 'column'
  | 'constraint'
  | 'routine-body'

export interface Witness {
  readonly kind: WitnessKind
  /**
   * What the probe resolves. For `regprocedure` and `routine-body` this is a
   * FULL signature — `schema.name(argtype, …)` — because arity is what
   * separates the versions. For `column` and `constraint`,
   * `qualified.table.name`.
   */
  readonly identifier: string
  /**
   * `routine-body` ONLY: a bare identifier the routine's DEFINITION must
   * contain, once comments are stripped.
   *
   * ---------------------------------------------------------------------
   * WHY A SEVENTH KIND EXISTS AT ALL
   * ---------------------------------------------------------------------
   * Every other witness answers "does this OBJECT exist", and that was enough
   * while every superseding package introduced one. grounding_0005 introduces
   * nothing: it replaces the BODY of a function grounding_0002 already created,
   * at the same signature, with the same owner, the same ACL and the same
   * return type. There is no object whose presence distinguishes "the repair
   * ran" from "the repair did not", and a `regprocedure` witness on that
   * signature would be refused by the anchoring gate for exactly the right
   * reason — an EARLIER package creates it, so the witness would report the
   * successor installed as soon as its predecessor was.
   *
   * So the discriminator is the body. That is weaker than a catalogue entry and
   * is stated as weaker: it measures a fragment of a definition rather than the
   * existence of a thing. It is also the only form in which the question is
   * askable, and the repository already models it twice — `mustCall` in
   * db/prepared-package-order.ts, and stella_0016's own §7 reading
   * pg_get_functiondef of the function it just published.
   *
   * COMMENTS ARE STRIPPED BEFORE THE SEARCH. `pg_get_functiondef` returns the
   * source verbatim, and grounding_0002's registrar explains its own train-2
   * repair by naming the tokens involved. Searching raw text would find the
   * fragment in a sentence describing it — F-08C, in a place where a false
   * positive means a package is reported INSTALLED when it is not.
   */
  readonly bodyContains?: string
}

export interface PackageWitnesses {
  readonly requiredPresentWhenInstalled: readonly Witness[]
  /**
   * Objects that must be GONE for the package to count as installed.
   *
   * NEVER the definition of ABSENT. A package is absent when none of its
   * POSITIVE witnesses is present; these only distinguish INSTALLED from
   * INCONSISTENT. Reading absence from here would classify a database where
   * nothing has run as "installed", since the old signatures are missing there
   * too.
   */
  readonly requiredAbsentWhenInstalled: readonly Witness[]
  /** Why these identify THIS version and not its neighbour. */
  readonly discriminates: string
}

const fn = (identifier: string): Witness => ({ kind: 'regprocedure', identifier })

export const PACKAGE_WITNESSES: Readonly<Record<string, PackageWitnesses>> = {
  grounding_0002_document_versions: {
    requiredPresentWhenInstalled: [
      { kind: 'schema', identifier: 'uellix_grounding' },
      { kind: 'role', identifier: 'uellix_cap_grounding' },
      { kind: 'regclass', identifier: 'public.evidence_document_versions' },
      fn('uellix_grounding.claim_active_document_version(uuid)'),
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      'objects exclusive to grounding_0002; grounding_0003 and 0004 create neither the schema, the role nor this table.',
  },
  grounding_0003_evidence_chunks: {
    requiredPresentWhenInstalled: [
      { kind: 'regclass', identifier: 'public.evidence_chunks' },
      fn('uellix_grounding.insert_evidence_chunks(uuid,jsonb)'),
      fn('uellix_grounding.finalize_document_ingestion(uuid,integer)'),
      fn('uellix_grounding.chunks_in_scope(uuid,uuid,uuid)'),
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      'grounding_0004 re-creates none of these three signatures; it adds chunks_in_scope_attested beside chunks_in_scope.',
  },
  grounding_0004_runtime_attestation: {
    requiredPresentWhenInstalled: [
      fn('uellix_grounding.chunks_in_scope_attested(uuid,uuid,uuid)'),
      { kind: 'constraint', identifier: 'public.evidence_chunks.evidence_chunks_content_hash_derivation_check' },
      { kind: 'constraint', identifier: 'public.evidence_chunks.evidence_chunks_span_length_check' },
      { kind: 'constraint', identifier: 'public.evidence_chunks.evidence_chunks_chunk_id_derivation_check' },
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      '`_attested` exists only in grounding_0004. Keeping it separate from 0003 is what lets "0003 installed, 0004 absent" be VISIBLE rather than normalised into a clean chain — that state is the dangerous one the runner must see.',
  },
  stella_0013_grounded_query_quota: {
    requiredPresentWhenInstalled: [
      { kind: 'schema', identifier: 'uellix_stella' },
      { kind: 'role', identifier: 'uellix_cap_stella_quota' },
      { kind: 'column', identifier: 'public.stella_interactions.idempotency_key' },
      fn('uellix_stella.consume_stella_quota(uuid,uuid,character varying,character)'),
    ],
    requiredAbsentWhenInstalled: [],
    discriminates: 'consume_stella_quota is created here and redefined by no later package.',
  },
  stella_0014_operation_tickets: {
    requiredPresentWhenInstalled: [
      { kind: 'schema', identifier: 'uellix_stella_ops' },
      { kind: 'role', identifier: 'uellix_cap_stella_ticket' },
      { kind: 'regclass', identifier: 'uellix_stella_ops.operation_tickets' },
      // `(integer)`, NOT `()`. stella_0014 L1221 creates it as
      // `expire_operation_tickets(p_max integer DEFAULT 1000)`, and a DEFAULT
      // does not remove the parameter — `oid::regprocedure::text` renders the
      // FULL signature, so the catalogue spells this `(integer)` and never `()`.
      //
      // MEASURED, not reasoned about: the first version of this entry said `()`,
      // which is a witness that can never be present. A correctly installed T5
      // would have reported three positives of four — PARTIAL_OR_INCONSISTENT —
      // and A1 refuses on partial, so the chain would have been unplannable
      // forever for a reason no offline test could see. Every fixture used the
      // registry's own spelling on both sides of the comparison; only anchoring
      // the signature to the line that creates it exposes this class of defect.
      fn('uellix_stella_ops.expire_operation_tickets(integer)'),
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      'DELIBERATELY NOT bind/complete: stella_0015 DROPS the two-argument versions this package creates, and witnessing by them would flip a correctly installed T5 to ABSENT the moment T6 landed. These four survive every successor.',
  },
  stella_0015_project_bound_operation_tickets: {
    requiredPresentWhenInstalled: [
      fn('uellix_stella_ops.bind_operation_ticket(character,uuid,character)'),
      fn('uellix_stella_ops.complete_operation_ticket(character,uuid,character)'),
      fn('uellix_stella_ops.abort_operation_ticket(character,uuid,character varying)'),
      fn('uellix_stella_ops.inspect_operation_ticket(character,uuid)'),
    ],
    requiredAbsentWhenInstalled: [
      fn('uellix_stella_ops.bind_operation_ticket(character,character)'),
      fn('uellix_stella_ops.complete_operation_ticket(character,character)'),
      fn('uellix_stella_ops.abort_operation_ticket(character,character varying)'),
      fn('uellix_stella_ops.inspect_operation_ticket(character)'),
    ],
    discriminates:
      'arity, not name. stella_0015 L650-653 DROPS the four project-blind signatures, so old-and-new coexisting here is INCONSISTENT — unlike stella_0018, where coexistence is the designed end state.',
  },
  stella_0016_reserved_quota_semantics: {
    requiredPresentWhenInstalled: [
      fn('uellix_stella.stella_capacity(uuid,character)'),
      fn('uellix_stella.consume_stella_capacity(uuid,uuid,character varying,character)'),
      fn('uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character)'),
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      'bind/complete CANNOT witness this package: it redefines their BODIES at the same 3-argument signatures stella_0015 created and introduces no new signature. stella_capacity is exclusive to it, and the 5-argument settle survives stella_0017 because that package re-creates it (L557).',
  },
  stella_0017_governed_stella_consumption: {
    requiredPresentWhenInstalled: [
      fn(
        'uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character,character varying,character,character varying,integer,jsonb)',
      ),
      fn(
        'uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb)',
      ),
      { kind: 'constraint', identifier: 'public.stella_interactions.stella_interactions_governed_identity_check' },
    ],
    discriminates:
      'TEN arguments, not five. stella_0016 creates settle_reserved_quota with five and stella_0017 re-creates that one too, so a witness by name would report this package installed as soon as its predecessor was. complete goes 2 -> 3 -> 3 -> 7 across T5, T6, T7, T8.',
    requiredAbsentWhenInstalled: [],
  },
  stella_0018_category_bound_operation_tickets: {
    requiredPresentWhenInstalled: [
      fn('uellix_stella_ops.bind_operation_ticket(character,uuid,character,character varying)'),
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      'the fourth argument p_expected_category. COEXISTENCE IS CORRECT HERE: stella_0018 L339 deliberately re-creates the three-argument bind so it raises U0106 unconditionally, so both signatures standing is the designed end state — not the inconsistency it would be for stella_0015.',
  },
  grounding_0005_claim_advisory_lock: {
    requiredPresentWhenInstalled: [
      {
        kind: 'routine-body',
        identifier: 'uellix_grounding.claim_active_document_version(uuid)',
        bodyContains: 'pg_advisory_xact_lock',
      },
    ],
    requiredAbsentWhenInstalled: [],
    discriminates:
      'THE BODY, because there is nothing else. This package creates no role, schema, table, ' +
      'column, constraint or new signature; it replaces claim_active_document_version in place, ' +
      'preserving owner, ACL, SECURITY DEFINER, search_path and return type. Everything a ' +
      'catalogue-shaped witness can see is IDENTICAL before and after — which is precisely why ' +
      're-applying grounding_0002 over it is invisible to every other check in this registry, and ' +
      'why db/prepared-package-order.ts had to refuse that re-application on the same evidence. ' +
      'grounding_0002 creates this signature with a row lock and takes pg_advisory_xact_lock only ' +
      'in its SIBLING register_document_version, so the fragment scoped to THIS routine cannot ' +
      'fire before this package ran.',
  },
}

/** The nine, derived from HOSTED_CHAIN so there is no parallel list of ids. */
export const WITNESSED_PACKAGES: readonly string[] = HOSTED_CHAIN.filter(
  (n) => n !== 'stella_hosted_0001_managed_role_bootstrap',
)

export type PackageState = 'ABSENT' | 'INSTALLED' | 'PARTIAL_OR_INCONSISTENT'

export interface PackageClassification {
  readonly packageId: string
  readonly state: PackageState
  readonly presentWitnesses: readonly string[]
  readonly missingWitnesses: readonly string[]
  readonly violatedRequiredAbsences: readonly string[]
}

/** A witness as the probe reports it: identifier -> present. */
export type ObservedWitnesses = Readonly<Record<string, boolean>>

export type WitnessRefusalCode =
  | 'WITNESS_PACKAGE_UNKNOWN'
  | 'WITNESS_REGISTRY_INCOMPLETE'
  | 'WITNESS_OBSERVATION_MISSING'

export type ClassificationResult =
  | { readonly ok: true; readonly classification: PackageClassification }
  | { readonly ok: false; readonly code: WitnessRefusalCode; readonly detail: string }

/**
 * The key an observation is reported under.
 *
 * The `bodyContains` fragment is part of it, not a detail hidden behind the
 * signature: two body witnesses on one routine are a legitimate thing to want
 * (a package that must both ADD one call and be distinguishable from one that
 * did not), and a key that collapsed them would silently answer the second with
 * the first's measurement.
 */
const key = (w: Witness): string =>
  w.kind === 'routine-body' ? `${w.kind}:${w.identifier}:${w.bodyContains}` : `${w.kind}:${w.identifier}`

/**
 * Classifies ONE package.
 *
 * ABSENT is derived from the POSITIVE witnesses alone. Deriving it from
 * `requiredAbsentWhenInstalled` would call a virgin database "installed",
 * because the old signatures are missing there too.
 */
export function classifyPackage(
  packageId: string,
  observed: ObservedWitnesses,
  /**
   * Injectable for the reason `verifyStagingTarget` takes its denylist as a
   * parameter: a rule a test cannot vary is a rule nothing proves. The mutation
   * suite substitutes a corrupted registry here — a package with its successor's
   * witnesses, a signature stripped of its arity, a required absence deleted —
   * and asserts that the anchoring gates catch each one.
   */
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
): ClassificationResult {
  const entry = registry[packageId]
  if (entry === undefined) {
    return {
      ok: false,
      code: 'WITNESS_PACKAGE_UNKNOWN',
      detail: `${packageId} has no declared witnesses. An unwitnessed package cannot be measured, and unmeasured is not absent.`,
    }
  }

  const all = [...entry.requiredPresentWhenInstalled, ...entry.requiredAbsentWhenInstalled]
  const unobserved = all.filter((w) => observed[key(w)] === undefined).map(key)
  if (unobserved.length > 0) {
    return {
      ok: false,
      code: 'WITNESS_OBSERVATION_MISSING',
      detail: `${packageId}: ${unobserved.length} witness(es) were not measured: ${unobserved.slice(0, 4).join(', ')}. A witness nobody looked for is unknown, and unknown is not false.`,
    }
  }

  const present = entry.requiredPresentWhenInstalled.filter((w) => observed[key(w)] === true).map(key)
  const missing = entry.requiredPresentWhenInstalled.filter((w) => observed[key(w)] !== true).map(key)
  const violated = entry.requiredAbsentWhenInstalled.filter((w) => observed[key(w)] === true).map(key)

  let state: PackageState
  if (present.length === 0) {
    state = 'ABSENT'
  } else if (missing.length === 0 && violated.length === 0) {
    state = 'INSTALLED'
  } else {
    state = 'PARTIAL_OR_INCONSISTENT'
  }

  return {
    ok: true,
    classification: {
      packageId,
      state,
      presentWitnesses: present,
      missingWitnesses: missing,
      violatedRequiredAbsences: violated,
    },
  }
}

export type ClassifyAllResult =
  | { readonly ok: true; readonly classifications: readonly PackageClassification[] }
  | { readonly ok: false; readonly code: WitnessRefusalCode; readonly detail: string }

export function classifyAllPackages(
  observed: ObservedWitnesses,
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): ClassifyAllResult {
  const declared = Object.keys(registry)

  // TWO DIFFERENT QUESTIONS, and they were one until M-8.
  //
  //   missing   every package being CLASSIFIED must be in the registry, or the
  //             classifier would be asked about something it cannot measure.
  //   extra     every registry entry must name a package the CHAIN declares —
  //             an entry for a package that does not exist witnesses nothing.
  //
  // `extra` is checked against the CHAIN and not against `packageIds`, because
  // `packageIds` may legitimately be a historical prefix: an operator's
  // corroboration measured the chain as it stood when the probe ran, and the
  // chain has grown since. Comparing the registry against that prefix would
  // report grounding_0005 as "unexpected" — an entry the chain plainly declares
  // — and the honest reading of an older observation would be impossible.
  //
  // With the default `packageIds` (the whole chain) the two are identical, so
  // nothing about the ordinary path is loosened.
  const missingFromRegistry = packageIds.filter((p) => !declared.includes(p))
  const extra = declared.filter((p) => !WITNESSED_PACKAGES.includes(p))
  if (missingFromRegistry.length > 0 || extra.length > 0) {
    return {
      ok: false,
      code: 'WITNESS_REGISTRY_INCOMPLETE',
      detail: `registry does not match HOSTED_CHAIN. missing: ${missingFromRegistry.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}.`,
    }
  }

  const out: PackageClassification[] = []
  for (const p of packageIds) {
    const r = classifyPackage(p, observed, registry)
    if (!r.ok) return r
    out.push(r.classification)
  }
  return { ok: true, classifications: out }
}

export type InstalledMapResult =
  | { readonly ok: true; readonly stellaPackagesInstalled: Readonly<Record<string, boolean>> }
  | { readonly ok: false; readonly code: 'WITNESS_PARTIAL_STATE'; readonly detail: string }

/**
 * The ONLY route from measurement to the runner's input.
 *
 * There is deliberately no branch that turns PARTIAL_OR_INCONSISTENT into
 * `false`. A half-installed package is not an absent one, and a plan built on
 * that reading would re-apply a package over its own partial state.
 */
export function toStellaPackagesInstalled(
  classifications: readonly PackageClassification[],
): InstalledMapResult {
  const partial = classifications.filter((c) => c.state === 'PARTIAL_OR_INCONSISTENT')
  if (partial.length > 0) {
    return {
      ok: false,
      code: 'WITNESS_PARTIAL_STATE',
      detail: partial
        .map(
          (c) =>
            `${c.packageId}: present [${c.presentWitnesses.join(', ')}]; missing [${c.missingWitnesses.join(', ')}]` +
            (c.violatedRequiredAbsences.length > 0
              ? `; still present but must be gone [${c.violatedRequiredAbsences.join(', ')}]`
              : ''),
        )
        .join(' | '),
    }
  }
  return {
    ok: true,
    stellaPackagesInstalled: Object.fromEntries(
      classifications.map((c) => [c.packageId, c.state === 'INSTALLED']),
    ),
  }
}

/** Every witness the probe must resolve, deduplicated. */
export function allWitnesses(
  registry: Readonly<Record<string, PackageWitnesses>> = PACKAGE_WITNESSES,
  packageIds: readonly string[] = WITNESSED_PACKAGES,
): readonly Witness[] {
  const seen = new Map<string, Witness>()
  for (const p of packageIds) {
    const e = registry[p]
    if (e === undefined) continue
    for (const w of [...e.requiredPresentWhenInstalled, ...e.requiredAbsentWhenInstalled]) {
      seen.set(key(w), w)
    }
  }
  return [...seen.values()]
}

export const witnessKey = key
