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
  redactForHostedLog,
  verifyStagingTarget,
  type HostedTargetInput,
  type ProductionIdentifiers,
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
  // (1) IDENTITY FIRST, always. Every other check assumes we know which
  //     database we are talking about; running them first would mean reporting
  //     a package problem about a database we were never allowed to touch.
  const identity = verifyStagingTarget(request.target, request.production)
  if (!identity.ok) return fail(identity.code, identity.message)

  const log: string[] = [
    `target ${identity.projectRef} accepted on ${identity.signals.length} independent signals: ${identity.signals.join(', ')}`,
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
  const freshProvisioning = request.packages.includes('stella_hosted_0001_managed_role_bootstrap')
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
  if (request.packages.includes('stella_hosted_0001_managed_role_bootstrap')) {
    const missing = HOSTED_CHAIN.filter((n) => !willBePresent(n))
    if (missing.length > 0) {
      return fail(
        missing.some((n) => GROUNDING_UNIT.includes(n))
          ? 'HOSTED_GROUNDING_UNIT_INCOMPLETE'
          : 'HOSTED_TICKET_CHAIN_INCOMPLETE',
        `refused: this plan applies the bootstrap, which means the target has no Stella surface yet, ` +
          `but it stops short of the full chain — missing: ${missing.join(', ')}. A first provisioning ` +
          `applies all ten packages or none of them.`,
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
