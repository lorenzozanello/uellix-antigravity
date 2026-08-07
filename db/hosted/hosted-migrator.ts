// db/hosted/hosted-migrator.ts
// TRAIN 5B — Phase 7. The hosted application surface, kept SEPARATE from
// db/migrator.ts on purpose.
//
// ---------------------------------------------------------------------------
// WHY A SEPARATE MODULE AND NOT A FLAG ON THE LOCAL ONE
// ---------------------------------------------------------------------------
// `db/migrator.ts` asks `db/safety/database-access.ts` for the
// `local_migration` capability, which accepts loopback and container targets
// only. Adding a "remote" mode to it would mean widening that capability, and
// the whole point of `DATABASE_TARGET_SAFETY.md` section 3.1 is that widening a
// capability to make one job convenient is how a boundary stops meaning
// anything. So the local tool keeps refusing every hosted target, forever, and
// this module exists beside it.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// A PLANNER. It is a pure function: no connection, no filesystem, no clock. It
// takes the target's identity, the packages to apply and the canonical sources,
// and returns either a refusal or an ordered plan whose every step carries the
// hashes an operator can verify. Executing the plan is a later unit and is NOT
// wired here — Phase 7 says "No conectes todavía el runner a remoto", and a
// module that cannot connect is a stronger guarantee than one that chooses not
// to.

import {
  HOSTED_CHAIN,
  hostedManifestEntry,
  sha256OfSql,
} from './hosted-package-manifest'
import { generateHostedPackage } from './generate-hosted-package'
import { packageOrderRefusal, supersessionsFor } from '../prepared-package-order'
import {
  productionDenylistStatus,
  redactForHostedLog,
  verifyStagingTarget,
  type HostedTargetInput,
  type ProductionIdentifiers,
  type SentinelPolicy,
} from './target-identity'

export type HostedApplyFailureCode =
  | 'HOSTED_PACKAGE_NOT_IN_CHAIN'
  | 'HOSTED_PACKAGE_OUT_OF_ORDER'
  | 'HOSTED_SOURCE_MISSING'
  | 'HOSTED_SOURCE_SHA_MISMATCH'
  | 'HOSTED_REWRITE_COUNT_MISMATCH'
  | 'HOSTED_APPLY_CONFIRMATION_REQUIRED'
  | 'HOSTED_APPLY_CONFIRMATION_MISMATCH'
  | 'HOSTED_GROUNDING_UNIT_INCOMPLETE'
  | 'HOSTED_TICKET_CHAIN_INCOMPLETE'
  | 'HOSTED_SENTINEL_BOUNDARY_CROSSED'
  | 'HOSTED_BOOTSTRAP_ONLY_PLAN_INVALID'
  | 'HOSTED_PRODUCTION_DENYLIST_EMPTY'
  | 'DB_MIGRATOR_PACKAGE_ORDER_VIOLATION'
  | string

export interface HostedApplyRequest {
  readonly target: HostedTargetInput
  readonly packages: readonly string[]
  readonly mode: 'dry-run' | 'apply'
  /** Required in `apply` mode. Exactly `hosted_apply:<project-ref>`. */
  readonly applyConfirmation?: string
  /**
   * Results of the READ-ONLY catalog probes, keyed by package name.
   * The caller runs them; this module never issues SQL.
   */
  readonly installedProbes: Readonly<Record<string, boolean>>
  /** Canonical SQL by package name. */
  readonly sources: Readonly<Record<string, string>>
  readonly production?: ProductionIdentifiers
  /**
   * PHASE_STELLA_BOOTSTRAP: this plan applies the bootstrap and STOPS, so that a
   * human can write the sentinel row before anything else runs.
   *
   * Set by `db/hosted/hosted-provisioning-runner.ts`, never by an operator
   * directly. When set, the plan must be EXACTLY the bootstrap — the flag
   * narrows what is permitted, it does not widen it.
   */
  readonly bootstrapOnly?: boolean
  /**
   * Set only by a caller that has MEASURED the target as empty. Required for an
   * apply-mode `bootstrapOnly` plan, because that is the one path where a write
   * happens with the sentinel deferred. See the refusal in `planHostedApply`.
   */
  readonly emptinessAttested?: boolean
}

export interface HostedApplyStep {
  readonly package: string
  readonly sourceFile: string
  readonly sourceSha256: string
  readonly generatedSha256: string
  readonly rewriteCounts: Readonly<Record<string, number>>
  /** The SQL to run. Present so the caller can write it out; never logged. */
  readonly sql: string
}

export type HostedApplyPlan =
  | {
      readonly ok: true
      readonly projectRef: string
      readonly writesPermitted: boolean
      readonly steps: readonly HostedApplyStep[]
      readonly log: readonly string[]
    }
  | { readonly ok: false; readonly code: HostedApplyFailureCode; readonly message: string }

const GROUNDING_UNIT = HOSTED_CHAIN.filter((n) => n.startsWith('grounding_'))
const TICKET_CHAIN = HOSTED_CHAIN.filter((n) => n.startsWith('stella_00'))

function fail(code: HostedApplyFailureCode, message: string): HostedApplyPlan {
  return { ok: false, code, message: redactForHostedLog(message) }
}

export function planHostedApply(request: HostedApplyRequest): HostedApplyPlan {
  const includesBootstrap = request.packages.includes('stella_hosted_0001_managed_role_bootstrap')

  // (0) THE SENTINEL BOUNDARY, decided before identity because it decides which
  //     identity question is even askable.
  //
  //     Train 5C0 found that Train 5B's planner could not plan a first
  //     provisioning at all: it demanded the in-database sentinel from every
  //     plan, and the bootstrap is the package that creates the sentinel's table.
  //     The knot is real and it is not a coding slip — the requirements document
  //     had the same contradiction between its §2 A5 and its §3.
  //
  //     The resolution has three parts, and the third is the one that keeps this
  //     from being a hole:
  //
  //       a. A DRY RUN may always defer the sentinel. Planning is not writing,
  //          and refusing to even describe the first provisioning is what made
  //          the defect invisible for a whole train.
  //       b. An APPLY that includes the bootstrap must be bootstrapOnly. You may
  //          write the bootstrap without a sentinel; you may not write anything
  //          ELSE without one.
  //       c. Which means no single apply can cross the boundary. The human
  //          INSERT sits between two invocations, where a human step belongs,
  //          rather than being a precondition of the package that makes it
  //          possible.
  if (request.bootstrapOnly) {
    const isExactlyBootstrap =
      request.packages.length === 1 && includesBootstrap
    if (!isExactlyBootstrap) {
      return fail(
        'HOSTED_BOOTSTRAP_ONLY_PLAN_INVALID',
        `refused: a bootstrap-only plan must be exactly [stella_hosted_0001_managed_role_bootstrap], ` +
          `got ${request.packages.length} package(s): ${request.packages.join(', ')}. The flag narrows ` +
          `what may run before the sentinel exists; it is not a way to carry extra packages past it.`,
      )
    }
    // THE WAIVER HAS A PRICE AND IT IS COLLECTED ON BOTH PATHS.
    //
    // Adversarial review A: "set by hosted-provisioning-runner.ts, never by an
    // operator directly" was a comment, not a check. A direct call with
    // `{bootstrapOnly: true, mode: 'apply'}` reached a two-signal APPLY of the
    // role/ownership bootstrap against any database the production veto did not
    // catch — and this module's own log said so out loud, that the compensating
    // control "is enforced by hosted-provisioning-runner.ts, not here".
    //
    // This planner cannot MEASURE emptiness — it opens no connection, and that
    // is deliberate. What it can do is refuse to proceed without the attestation
    // that somebody did, which turns the comment into a required argument.
    if (request.mode === 'apply' && request.emptinessAttested !== true) {
      return fail(
        'HOSTED_EMPTINESS_ATTESTATION_REQUIRED',
        `refused: applying the bootstrap with the sentinel deferred requires emptinessAttested: true. ` +
          `Two signals of identity are accepted here ONLY because a third fact stands in for the ` +
          `sentinel — the target holds zero rows in every table the baseline creates — and this planner ` +
          `cannot measure that itself. db/hosted/hosted-provisioning-runner.ts measures it and sets the ` +
          `flag; a caller setting it by hand is asserting the same thing under the same responsibility.`,
      )
    }
  } else if (includesBootstrap && request.mode === 'apply') {
    return fail(
      'HOSTED_SENTINEL_BOUNDARY_CROSSED',
      `refused: this plan applies the bootstrap AND ${request.packages.length - 1} further package(s) ` +
        `in one invocation. uellix_bootstrap.staging_sentinel does not exist until the bootstrap has ` +
        `run, and it is written by a human reading the project ref off the dashboard — a bootstrap ` +
        `that minted its own sentinel would be certifying itself. Apply the bootstrap alone ` +
        `(bootstrapOnly), have the operator write the row, then apply the chain against a target that ` +
        `can finally corroborate its own identity.`,
    )
  }

  const sentinelPolicy: SentinelPolicy =
    includesBootstrap && (request.mode === 'dry-run' || request.bootstrapOnly === true)
      ? 'deferred-until-bootstrap'
      : 'required'

  // (1) IDENTITY, and every other check assumes we know which database we are
  //     talking about; running them first would mean reporting a package problem
  //     about a database we were never allowed to touch.
  const identity = verifyStagingTarget(request.target, request.production, sentinelPolicy)
  if (!identity.ok) return fail(identity.code, identity.message)

  const log: string[] = [
    `target ${identity.projectRef} accepted on ${identity.signals.length} independent signals: ${identity.signals.join(', ')}`,
    ...(identity.sentinelDeferred
      ? [
          'sentinel DEFERRED: its table does not exist before the bootstrap. The compensating control ' +
            '(the target must be provably empty of Uellix rows) is enforced by hosted-provisioning-runner.ts, ' +
            'not here — this planner never connects and cannot measure emptiness.',
        ]
      : []),
    `mode ${request.mode}`,
  ]

  // (2) Membership and order. Out-of-chain is reported before order, because a
  //     package that has no place in the chain has no position to be out of.
  for (const name of request.packages) {
    if (!HOSTED_CHAIN.includes(name)) {
      return fail(
        'HOSTED_PACKAGE_NOT_IN_CHAIN',
        `refused: ${name} is not part of the managed-Supabase chain. Known members, in order: ${HOSTED_CHAIN.join(' -> ')}. ` +
          `stella_0004_role_separation is deliberately absent: on managed Supabase it is superseded by ` +
          `stella_hosted_0001_managed_role_bootstrap, not reused.`,
      )
    }
  }

  const positions = request.packages.map((n) => HOSTED_CHAIN.indexOf(n))
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] <= positions[i - 1]) {
      return fail(
        'HOSTED_PACKAGE_OUT_OF_ORDER',
        `refused: ${request.packages[i]} was presented after ${request.packages[i - 1]}, which is not chain order.`,
      )
    }
  }

  // (3) The supersession registry — the SAME one db/migrator.ts probes. Two
  //     runners, one set of rules; a hosted-only copy would be the second source
  //     of truth this design exists to avoid.
  //
  //     BEFORE completeness, and the order is a decision. Re-applying
  //     stella_0014 over stella_0015 is ALSO an incomplete chain, but "chain
  //     incomplete" is not why it is refused — it is refused because it would
  //     republish four project-blind SECURITY DEFINER signatures. An operator
  //     who reads the weaker reason first will try to satisfy it by adding more
  //     packages, which is exactly the wrong move.
  //     AN ABSENT PROBE IS NOT A "NO". Adversarial review A found this failing
  //     OPEN: `installedProbes[x] === true` treated a MISSING key as "not
  //     installed", so a runner that forgot to probe got a plan that re-applied
  //     a superseded package. That is the asymmetry the source check already
  //     avoids — a missing source is `HOSTED_SOURCE_MISSING`, never a skip — and
  //     there was no reason for the probe to behave differently.
  //
  //     The one legitimate exception is a FIRST provisioning: a plan that
  //     includes the bootstrap is applying to a database with no Stella surface
  //     at all, so "nothing is installed" is a fact, not an assumption.
  const freshProvisioning = includesBootstrap
  for (const name of request.packages) {
    for (const rule of supersessionsFor(name)) {
      const probe = request.installedProbes[rule.supersededBy]
      if (probe === undefined && !freshProvisioning) {
        return fail(
          'HOSTED_PROBE_MISSING',
          `refused: no probe result supplied for ${rule.supersededBy}, which supersedes ${name}. ` +
            `An unprobed successor is unknown, not absent — and re-applying ${name} over an installed ` +
            `${rule.supersededBy} would republish: ${rule.wouldRepublish.join(', ')}.`,
        )
      }
      const refusal = packageOrderRefusal(rule, probe === true)
      if (refusal) return fail('DB_MIGRATOR_PACKAGE_ORDER_VIOLATION', refusal)
    }
  }

  // (4) COMPLETENESS OF THE TWO UNITS.
  //
  //     Grounding: db/prepared/README.md's AVISO OPERATIVO is explicit that
  //     0002/0003/0004 apply as ONE unit, because re-applying 0003 without 0004
  //     silently reverts two security repairs and leaves every governed read
  //     returning the empty set. A plan that includes some of them and not the
  //     others is that failure waiting for an operator.
  //
  //     Tickets: stopping before 0018 leaves R6a (a ticket issued for one
  //     capability bound and charged by another) and R6b (ticketless consumption
  //     with a caller-chosen identity) OPEN — both MEASURED, one classified
  //     BLOCKER. A partial ticket chain is not a smaller deployment, it is a
  //     deployment of the defect.
  //
  //     A package already installed counts as present: this is about the END
  //     STATE, not about what this particular invocation does.
  const willBePresent = (name: string): boolean =>
    request.packages.includes(name) || request.installedProbes[name] === true

  // (4a) A FRESH PROVISIONING APPLIES THE WHOLE CHAIN.
  //
  //      Applying the bootstrap means this database has no Stella surface at
  //      all. Stopping partway would leave a staging environment whose feature
  //      flags name tables that do not exist — `STELLA_GROUNDED_QUERY_ENABLED`
  //      reads `evidence_chunks`, `STELLA_DECISIONS_PERSISTENCE_ENABLED` reads
  //      a table only G2 creates — and "the flag is false anyway" is a reason
  //      the environment is currently harmless, not a reason it is finished.
  //      Incremental applies (bootstrap already installed) are judged by the
  //      two unit rules below instead.
  //
  //      TRAIN 5C0 AMENDMENT. The rule as written was the other half of the
  //      sentinel circularity: "all ten or none" and "a human writes the sentinel
  //      between package one and package two" cannot both hold inside a single
  //      invocation. The CONCERN is still right — a staging environment whose
  //      flags name tables that do not exist is unfinished, not minimal — so the
  //      obligation is not dropped, it MOVES: it becomes an obligation on the
  //      phased SEQUENCE, enforced by hosted-provisioning-runner.ts, which will
  //      not report a provisioning complete until the chain reaches stella_0018.
  //
  //      Here that means: a bootstrap-only plan is exempt from completeness,
  //      because completeness is no longer this invocation's question to answer.
  if (includesBootstrap && !request.bootstrapOnly) {
    const missing = HOSTED_CHAIN.filter((n) => !willBePresent(n))
    if (missing.length > 0) {
      return fail(
        missing.some((n) => GROUNDING_UNIT.includes(n))
          ? 'HOSTED_GROUNDING_UNIT_INCOMPLETE'
          : 'HOSTED_TICKET_CHAIN_INCOMPLETE',
        `refused: this plan applies the bootstrap, which means the target has no Stella surface yet, ` +
          `but it stops short of the full chain — missing: ${missing.join(', ')}. A first provisioning ` +
          `applies all ten packages or none of them, EXCEPT via the phased runner, whose ` +
          `PHASE_STELLA_BOOTSTRAP step is bootstrapOnly and whose PHASE_STELLA_CHAIN step then ` +
          `completes the remaining nine.`,
      )
    }
  }

  const touchesGrounding = request.packages.some((n) => GROUNDING_UNIT.includes(n))
  if (touchesGrounding) {
    const missing = GROUNDING_UNIT.filter((n) => !willBePresent(n))
    if (missing.length > 0) {
      return fail(
        'HOSTED_GROUNDING_UNIT_INCOMPLETE',
        `refused: the grounding packages apply as one unit and ${missing.join(', ')} would be neither ` +
          `applied nor already installed. Re-applying grounding_0003 without grounding_0004 reverts two ` +
          `security repairs in silence: a missing GRANT raises, a missing POLICY does not.`,
      )
    }
  }

  const touchesTickets = request.packages.some((n) => TICKET_CHAIN.includes(n))
  if (touchesTickets) {
    const missing = TICKET_CHAIN.filter((n) => !willBePresent(n))
    if (missing.length > 0) {
      return fail(
        'HOSTED_TICKET_CHAIN_INCOMPLETE',
        `refused: the ticket chain must reach stella_0018; ${missing.join(', ')} would be neither applied ` +
          `nor already installed. Stopping earlier leaves R6a and R6b open, and both were measured, not inferred.`,
      )
    }
  }

  // (5) Generation, which is where source drift and rule drift both surface.
  const steps: HostedApplyStep[] = []
  for (const name of request.packages) {
    const entry = hostedManifestEntry(name)
    const source = request.sources[name]

    if (typeof source !== 'string') {
      return fail(
        'HOSTED_SOURCE_MISSING',
        `refused: no canonical source supplied for ${name} (db/prepared/${entry.sourceFile}). ` +
          `A missing source is a refusal, never a skipped package.`,
      )
    }

    let generated
    try {
      generated = generateHostedPackage(entry, source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = message.startsWith('HOSTED_') ? message.split(':')[0] : 'HOSTED_GENERATION_FAILED'
      return fail(code, message)
    }

    steps.push({
      package: name,
      sourceFile: entry.sourceFile,
      sourceSha256: sha256OfSql(source),
      generatedSha256: generated.generatedSha256,
      rewriteCounts: generated.counts,
      sql: generated.sql,
    })

    log.push(
      `step ${steps.length}: ${name} source=${sha256OfSql(source).slice(0, 12)} ` +
        `generated=${generated.generatedSha256.slice(0, 12)} rewrites=${JSON.stringify(generated.counts)}`,
    )
  }

  // (6) The apply gate, LAST, and separate from every other check.
  //
  //     Deliberately not folded into the target verification: a valid target is
  //     a statement about WHERE, and this is a statement about WHETHER. Making
  //     one imply the other is how "I only wanted to look" becomes a write.
  let writesPermitted = false
  if (request.mode === 'apply') {
    // Same refusal as the phased runner, for the same reason: this planner is
    // the OTHER path to `writesPermitted: true`, and a guard installed on one
    // of two doors is a guard on neither. See the long note in
    // hosted-provisioning-runner.ts's `finish()`.
    const denylist = productionDenylistStatus(request.production)
    if (!denylist.loaded) {
      return fail('HOSTED_PRODUCTION_DENYLIST_EMPTY', `refused: ${denylist.detail}`)
    }
    if (!request.applyConfirmation) {
      return fail(
        'HOSTED_APPLY_CONFIRMATION_REQUIRED',
        `refused: apply mode requires an explicit confirmation of the form hosted_apply:<project-ref>. ` +
          `A valid staging target is not by itself permission to write to it.`,
      )
    }
    const expected = `hosted_apply:${identity.projectRef}`
    if (request.applyConfirmation !== expected) {
      return fail(
        'HOSTED_APPLY_CONFIRMATION_MISMATCH',
        `refused: the confirmation does not match this target. A token minted for one project does not ` +
          `confirm another.`,
      )
    }
    writesPermitted = true
    log.push('writes PERMITTED by explicit confirmation')
  } else {
    log.push('writes NOT permitted: dry run')
  }

  return {
    ok: true,
    projectRef: identity.projectRef,
    writesPermitted,
    steps,
    log: log.map(redactForHostedLog),
  }
}
