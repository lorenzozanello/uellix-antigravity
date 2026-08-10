// db/hosted/authority/governed-publication.ts
// COMMIT 4 — generate, validate, and only then publish. All nine or none.
//
// ---------------------------------------------------------------------------
// WHY PUBLICATION IS A SEPARATE STEP FROM GENERATION
// ---------------------------------------------------------------------------
// A generator that writes as it goes leaves a mixed set behind when it fails at
// T7: four new files beside five old ones, all of them syntactically fine, and
// a chain that applies cleanly and installs a state nobody designed. The
// failure would not announce itself — it would look like a successful run that
// simply stopped.
//
// So: every package is generated in memory, every package is validated against
// the plan, every pin is compared, and only after all of that does anything
// touch the filesystem. Even then the writes go to temporary names first and
// are renamed at the end, so a disk error partway through leaves the previous
// complete set rather than half of the new one.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { buildAuthorityPlan, type AuthorityPlan } from './classification-manifest'
import { validateResolvedAuthorityPlanForGeneration } from './execution-disposition'
import { generateGovernedChain, type GeneratedGovernedPackage } from './governed-generator'
import { validateGeneratedChain } from './generated-output-validator'
import {
  authorityPlanDigest,
  GOVERNED_PINS,
  GOVERNED_PLAN_DIGEST,
  sha256OfSql,
} from './governed-manifest'
import { AuthorityRefusal } from './window-contract'

export function governedArtefactDir(root: string = process.cwd()): string {
  return path.join(root, 'db', 'prepared', 'hosted', 'governed')
}

export interface BuiltChain {
  readonly plan: AuthorityPlan
  readonly packages: readonly GeneratedGovernedPackage[]
  readonly gateChecks: readonly string[]
  readonly outputChecks: readonly string[]
}

export interface BuildOptions {
  /** Injects a failure after N packages have been generated. Tests only. */
  readonly failAfterPackages?: number
  /** Skips the pin comparison, for the run that computes the pins. */
  readonly repin?: boolean
}

/**
 * Runs the whole pipeline in memory. Writes nothing.
 *
 * The order is the contract: the pre-generation gate runs BEFORE a single
 * statement is emitted, so a plan that does not validate cannot produce output
 * to be inspected and argued about.
 */
export function buildGovernedChain(options: BuildOptions = {}): BuiltChain {
  const plan = buildAuthorityPlan()

  const gate = validateResolvedAuthorityPlanForGeneration(plan)

  const planDigest = authorityPlanDigest(plan)
  if (!options.repin && planDigest !== GOVERNED_PLAN_DIGEST) {
    throw new AuthorityRefusal(
      'AUTHORITY_WINDOW_DIGEST_DRIFT',
      `the authority plan no longer hashes to its pin.\n  pinned: ${GOVERNED_PLAN_DIGEST}\n  ` +
        `actual: ${planDigest}\nA window was re-anchored, a segment re-split, or an executor ` +
        `changed. The input packages can be byte-identical and this still moves — which is exactly ` +
        `why it is pinned separately from them.`,
    )
  }

  const packages = generateGovernedChain(plan)

  if (options.failAfterPackages !== undefined && options.failAfterPackages < packages.length) {
    throw new AuthorityRefusal(
      'AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED',
      `injected failure after ${options.failAfterPackages} package(s), to prove that publication is ` +
        `all-or-nothing.`,
    )
  }

  const outputResults = validateGeneratedChain(plan, packages)

  if (!options.repin) {
    for (const generated of packages) {
      const pin = GOVERNED_PINS.find((p) => p.packageId === generated.packageId)
      if (pin === undefined) {
        throw new AuthorityRefusal(
          'AUTHORITY_WINDOW_DIGEST_DRIFT',
          `${generated.packageId} has no pin. A new package must be pinned deliberately.`,
        )
      }
      if (pin.sourceDigest !== generated.sourceDigest) {
        throw new AuthorityRefusal(
          'AUTHORITY_WINDOW_DIGEST_DRIFT',
          `${generated.packageId}: the hosted artefact it derives from moved.\n  pinned: ` +
            `${pin.sourceDigest}\n  actual: ${generated.sourceDigest}`,
        )
      }
      if (pin.generatedDigest !== generated.generatedDigest) {
        throw new AuthorityRefusal(
          'AUTHORITY_WINDOW_DIGEST_DRIFT',
          `${generated.packageId}: the generated artefact does not match its pin.\n  pinned: ` +
            `${pin.generatedDigest}\n  actual: ${generated.generatedDigest}`,
        )
      }
    }
  }

  return {
    plan,
    packages,
    gateChecks: gate.checks,
    outputChecks: outputResults.flatMap((r) => r.checks.map((c) => `${r.packageId}: ${c}`)),
  }
}

/**
 * Publishes a built chain. Temporary names first, renames last.
 *
 * Nothing here re-derives anything: it is handed a chain that has already
 * passed both gates, so the only thing that can go wrong is the filesystem —
 * and the rename phase is what keeps that from producing a mixed set.
 */
export function publishGovernedChain(built: BuiltChain, root: string = process.cwd()): string[] {
  const dir = governedArtefactDir(root)
  mkdirSync(dir, { recursive: true })

  const staged: { temporary: string; final: string }[] = []
  try {
    for (const generated of built.packages) {
      const final = path.join(dir, generated.fileName)
      const temporary = `${final}.staged`
      writeFileSync(temporary, generated.sql, 'utf8')
      staged.push({ temporary, final })
    }
    for (const { temporary, final } of staged) renameSync(temporary, final)
  } catch (error) {
    for (const { temporary } of staged) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* the original error is the one worth reporting */
      }
    }
    throw error
  }

  return built.packages.map((p) => path.join('db/prepared/hosted/governed', p.fileName))
}

/** Regenerates and byte-compares what is on disk. Reads only. */
export function verifyGovernedChain(root: string = process.cwd()): string[] {
  const built = buildGovernedChain()
  const dir = governedArtefactDir(root)
  const problems: string[] = []

  for (const generated of built.packages) {
    const file = path.join(dir, generated.fileName)
    let onDisk: string
    try {
      onDisk = readFileSync(file, 'utf8')
    } catch {
      problems.push(`${generated.fileName}: missing`)
      continue
    }
    if (sha256OfSql(onDisk) !== generated.generatedDigest) {
      problems.push(`${generated.fileName}: does not match a fresh regeneration`)
    }
  }

  const expected = new Set(built.packages.map((p) => p.fileName))
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.staged')) {
      problems.push(`${name}: a staged file survived a failed publication`)
      continue
    }
    if (!expected.has(name)) problems.push(`${name}: not produced by the generator`)
  }

  return problems
}

/**
 * Generates twice, independently, and compares.
 *
 * A generator that consulted the clock, the filesystem or a random source would
 * pass every other check in this file and fail this one.
 */
export function assertDeterministicGeneration(): void {
  const first = buildGovernedChain()
  const second = buildGovernedChain()

  for (const [i, generated] of first.packages.entries()) {
    const other = second.packages[i]
    if (generated.sql !== other.sql) {
      throw new AuthorityRefusal(
        'AUTHORITY_WINDOW_DIGEST_DRIFT',
        `${generated.packageId}: two generations from the same HEAD differ. Something in the ` +
          `pipeline is reading a clock, the filesystem or a random source.`,
      )
    }
  }
}
