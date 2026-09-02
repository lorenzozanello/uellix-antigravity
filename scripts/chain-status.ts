// scripts/chain-status.ts
// One PHASE_STELLA_CHAIN step's verdict, derived rather than asserted.
//
//   pnpm chain:status        --after=<package-id>   print it
//   pnpm chain:status:write  --after=<package-id>   write the status artefact
//   pnpm chain:status:verify --after=<package-id>   recompute and compare
//
// CONNECTS TO NOTHING, and RUNS NOTHING. It reads what the operator recorded
// after that package's write — the output of the SAME read-only probe A1 used,
// db/prepared/checkpoint-a1/corroboration.sql, plus the two connection facts no
// query can report — and runs the canonical gates over it.
//
// ---------------------------------------------------------------------------
// `--after` IS MANDATORY AND THERE IS NO DEFAULT
// ---------------------------------------------------------------------------
// Not "defaults to the latest package", not "infers from which artefacts exist",
// not "the newest file wins". Every one of those is a rule under which the tool
// picks a slot on the operator's behalf, and the slot IS the evidence: a
// measurement filed against the wrong step would compute its delta against the
// wrong predecessor and pass. The nine steps are nine permanent historical
// facts and the operator names the one they measured.
//
// PRECHAIN is deliberately not accepted here. It is CHECKPOINT A1 and it already
// carries its own verdict; `pnpm a1:status` is the command for it.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  chainStepForPackage,
  computeChainStatus,
  resolveChainStep,
  serializeChainStatus,
  verifyChainStatus,
} from '../db/hosted/chain-evidence'
import { WITNESSED_PACKAGES } from '../db/hosted/package-witnesses'
import { HOSTED_CHAIN } from '../db/hosted/hosted-package-manifest'
import { STORAGE_UNIT_TRANSITIONS, type StorageUnitState } from '../db/hosted/storage-policy-artifact'

const ROOT = path.resolve(import.meta.dirname, '..')
const BOUNDARY_STATUS = 'artifacts/hosted-storage-boundary-status.json'

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

function requestedPackage(): string {
  const flags = process.argv.filter((a) => a.startsWith('--after='))
  if (flags.length === 0) {
    console.error(
      '[chain] REFUSED: --after=<package-id> is mandatory and has no default.\n' +
        '  There is no "latest step" and nothing is inferred from which artefacts exist:\n' +
        '  a measurement filed against the wrong step computes its delta against the wrong\n' +
        '  predecessor and passes. Declared, in chain order:\n' +
        WITNESSED_PACKAGES.map((p, i) => `    --after=${p}   (POST_T${i + 1})`).join('\n') +
        '\n  For the state BEFORE the chain, that is CHECKPOINT A1: `pnpm a1:status`.',
    )
    process.exit(2)
  }
  if (flags.length > 1) {
    console.error(`[chain] REFUSED: --after given ${flags.length} times (${flags.join(' ')}).`)
    process.exit(2)
  }
  return flags[0]!.slice('--after='.length)
}

function stellaSources(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of HOSTED_CHAIN) {
    const sql = read(`db/prepared/${name}.sql`)
    if (sql !== null) out[name] = sql
  }
  return out
}

/** Unit 41's state, from the boundary status artefact. `null` means unmeasured. */
function storageUnitState(): StorageUnitState | null {
  const raw = read(BOUNDARY_STATUS)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state = parsed.unit41State
    return typeof state === 'string' && state in STORAGE_UNIT_TRANSITIONS ? (state as StorageUnitState) : null
  } catch {
    return null
  }
}

const requested = requestedPackage()
const step = chainStepForPackage(requested)
if (step === null) {
  console.error(
    `[chain] REFUSED: ${JSON.stringify(requested)} is not a chain package. Declared: ${WITNESSED_PACKAGES.join(', ')}.`,
  )
  process.exit(2)
}

const resolved = resolveChainStep(step)
if (!resolved.ok) {
  console.error(`[chain] REFUSED (${resolved.code}): ${resolved.detail}`)
  process.exit(1)
}
const entry = resolved.entry

const status = computeChainStatus({
  step,
  readArtefact: read,
  readBaselineSql: read,
  stellaSources: stellaSources(),
  storageUnitState: storageUnitState(),
})

const mode = process.argv[2] ?? 'report'

if (mode === 'report') {
  console.log(
    `[chain] ${String(status.step)} (${String(status.packageId)}) · ` +
      `observation=${status.observationPresent ? 'present' : 'ABSENT'} · ` +
      `stepVerified=${String(status.stepVerified)} · safeToStop=${String(status.safeToStop)}`,
  )
  if (status.disposition === 'TRANSIENT') {
    // `requiredNextPackage`, not `expectedNextPackage`: the second is null on
    // every refusal path, and an unmeasured transient step is exactly where an
    // operator needs the name rather than the word "null".
    console.log(`[chain]   *** TRANSIENT — ${String(status.requiredNextPackage)} REQUIRED NEXT ***`)
    console.log(`[chain]   ${String(status.transientReason)}`)
  }
  for (const a of status.authorizedNextActions as string[]) console.log(`[chain]   authorized next: ${a}`)
  for (const b of status.blockers as string[]) console.log(`[chain]   BLOCKER ${b}`)
  for (const w of status.warnings as string[]) console.log(`[chain]   warning ${w}`)
  process.exit(status.stepVerified === true ? 0 : 1)
} else if (mode === 'write') {
  if (status.observationPresent !== true) {
    console.error(
      `[chain] REFUSED: ${entry.observationPath} is absent, so there is nothing to derive a verdict from.`,
    )
    process.exit(1)
  }
  writeFileSync(path.join(ROOT, entry.statusPath), serializeChainStatus(status), 'utf8')
  console.log(
    `[chain] wrote ${entry.statusPath} — stepVerified=${String(status.stepVerified)} ` +
      `disposition=${String(status.disposition)}`,
  )
} else if (mode === 'verify') {
  const result = verifyChainStatus(read(entry.statusPath), serializeChainStatus(status), entry.statusPath)
  if (!result.ok) {
    console.error(`[chain] ${result.note}`)
    process.exit(1)
  }
  console.log(`[chain] ${result.present ? 'verification OK — ' : ''}${result.note}`)
} else {
  console.error('usage: tsx scripts/chain-status.ts <report|write|verify> --after=<package-id>')
  process.exit(2)
}
