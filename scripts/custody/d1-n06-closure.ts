// scripts/custody/d1-n06-closure.ts
//
// DAG NODE N06, EVALUATED RATHER THAN DECLARED.
//
// N06's exit condition: "The entry EXISTS and contains all seven pre-mint
// fields. The mint date is absent and is expected to be, because the mint has
// not occurred." Its HARD predecessors come from the graph. This module derives
// the field list from the root clause that defines it, reads the values from
// the custody inventory instance, re-derives N09 from N08, re-checks N31's
// bounds, and refuses anything that looks like a secret. The closure record is
// written from its output and a control compares the two, so a hand-edited
// verdict goes red.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPlannedRemoval, computeValidUntilUtc } from './d1-n09-valid-until'
import { hardPredecessorsOf } from './d1-dag-validate'
import { checkInventorySurfaces, checkOperatorCredentialSection } from './d1-delivery-matrix'

const CAPABILITY_AUTHORITY = 'docs/ops/release/FIBDB053_D1_AUDITOR_CAPABILITY_PROVISIONING_AUTHORITY_v1.0.0.json'
export const CUSTODY_INVENTORY = 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'

/** Root-clause phrase -> inventory field. An unknown phrase is a failure, not a skip. */
export const N06_FIELD_MAP: Readonly<Record<string, string>> = {
  'the capability name': 'capability_name',
  'the role': 'role',
  'the target project ref': 'target_project_ref',
  'the human custodian': 'human_custodian',
  'every process or environment that will hold it': 'processes_or_environments',
  'the mint date': 'mint_date',
  'the expiry if OD-3 sets one': 'expiry_exact_utc',
  'the planned removal date': 'planned_removal_date',
}

/** The one field N06's exit condition expects ABSENT before the mint. */
export const POST_MINT_FIELD = 'mint_date'

export interface N06Field {
  readonly phrase: string
  readonly field: string
  readonly preMint: boolean
}

/** Parse `The entry records: a, b, ... and h.` out of the SSL-06 binding requirement. */
export function deriveN06Fields(rootClause: string): N06Field[] {
  const m = /The entry records: (.*?)\. Where/.exec(rootClause)
  if (m === null) throw new Error('The SSL-06 binding requirement no longer has the expected "The entry records:" sentence.')
  const phrases = m[1]!.split(/, (?:and )?/).map((x) => x.trim())
  return phrases.map((phrase) => {
    const field = N06_FIELD_MAP[phrase]
    if (field === undefined) throw new Error(`Unmapped N06 field phrase: "${phrase}". Fail closed.`)
    return { phrase, field, preMint: field !== POST_MINT_FIELD }
  })
}

export function readRootClause(repoRoot: string): string {
  const cap = JSON.parse(readFileSync(join(repoRoot, CAPABILITY_AUTHORITY), 'utf8')) as {
    SECRET_CUSTODY_CONTRACT: { SSL_06_ADJUDICATION: { CONSEQUENT_BINDING_REQUIREMENT: string } }
  }
  return cap.SECRET_CUSTODY_CONTRACT.SSL_06_ADJUDICATION.CONSEQUENT_BINDING_REQUIREMENT
}

export type NodeState = 'SATISFIED' | 'NOT_SATISFIED'

export interface N06Evaluation {
  readonly fields: ReadonlyArray<N06Field & { readonly present: boolean }>
  readonly preMintHoles: readonly string[]
  readonly postMintFieldUnexpectedlyPresent: boolean
  readonly expiryMatchesN09: boolean
  readonly removalWithinBounds: boolean
  readonly secretFindings: readonly string[]
  /** processes_or_environments against the production topology (d1-delivery-matrix). */
  readonly topologyReasons: readonly string[]
  readonly hardPredecessors: readonly string[]
  readonly unsatisfiedPredecessors: readonly string[]
  readonly status: 'SATISFIED' | 'NOT_SATISFIED'
  readonly reasons: readonly string[]
}

/** Patterns a custody inventory must never contain (SSL-08, OF-DAG-6). */
const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['connection string', /postgres(?:ql)?:\/\//i],
  ['URL userinfo', /\/\/[^\s/'"]+:[^\s/'"]+@/],
  ['password hash', /SCRAM-SHA-256\$|md5[0-9a-f]{32}/i],
  ['provider token', /\bsb_secret_|\bsbp_|\beyJ[A-Za-z0-9_-]{10,}/],
]

export function evaluateN06(params: {
  readonly rootClause: string
  readonly entry: Readonly<Record<string, unknown>>
  readonly plannedFinalWitnessUtc: string | null
  readonly predecessorStates: Readonly<Record<string, NodeState>>
  readonly hardPredecessors: readonly string[]
  /**
   * Why processes_or_environments does not match the derived production
   * topology, if it does not. Present only when the caller derived it; the
   * repository evaluation always does (OF-PM-4: the surfaces changed when the
   * post-mint path was built, so an inventory listing the old ones is not
   * "every process or environment that will hold it").
   */
  readonly topologyReasons?: readonly string[]
}): N06Evaluation {
  const reasons: string[] = []
  const fields = deriveN06Fields(params.rootClause).map((f) => {
    const v = params.entry[f.field]
    const present = v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== ''
    return { ...f, present }
  })
  if (fields.length !== 8) reasons.push(`Root clause yields ${fields.length} fields, not eight.`)
  const preMintHoles = fields.filter((f) => f.preMint && !f.present).map((f) => f.field)
  for (const h of preMintHoles) reasons.push(`Pre-mint field ${h} is a hole.`)
  const postMintFieldUnexpectedlyPresent = fields.some((f) => !f.preMint && f.present)
  if (postMintFieldUnexpectedlyPresent) reasons.push('mint_date is present before the mint.')

  let expiryMatchesN09 = false
  let removalWithinBounds = false
  if (params.plannedFinalWitnessUtc === null) {
    reasons.push('No N08 planned FINAL WITNESS instant; N09 cannot be re-derived.')
  } else {
    const expected = computeValidUntilUtc(params.plannedFinalWitnessUtc)
    expiryMatchesN09 = params.entry.expiry_exact_utc === expected
    if (!expiryMatchesN09) reasons.push(`expiry_exact_utc is not N09's derivation (${expected}).`)
    const removal = params.entry.planned_removal_date
    if (typeof removal === 'string') {
      try {
        removalWithinBounds = checkPlannedRemoval({ plannedFinalWitnessUtc: params.plannedFinalWitnessUtc, plannedRemovalUtc: removal }).ok
      } catch (e) {
        removalWithinBounds = false
        reasons.push(`planned_removal_date is not an exact UTC instant: ${(e as Error).message}`)
      }
      if (!removalWithinBounds) reasons.push('planned_removal_date is outside [N08, N09 expiry].')
    }
  }

  const text = JSON.stringify(params.entry)
  const secretFindings = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name)
  for (const f of secretFindings) reasons.push(`The entry contains a ${f}.`)

  const topologyReasons = params.topologyReasons ?? []
  reasons.push(...topologyReasons)

  const unsatisfiedPredecessors = params.hardPredecessors.filter((p) => params.predecessorStates[p] !== 'SATISFIED')
  for (const p of unsatisfiedPredecessors) reasons.push(`HARD predecessor ${p} is not SATISFIED.`)
  if (params.hardPredecessors.length === 0) reasons.push('No HARD predecessors were derived; refusing to evaluate over an empty set.')

  return {
    fields,
    preMintHoles,
    postMintFieldUnexpectedlyPresent,
    expiryMatchesN09,
    removalWithinBounds,
    secretFindings,
    topologyReasons,
    hardPredecessors: params.hardPredecessors,
    unsatisfiedPredecessors,
    status: reasons.length === 0 ? 'SATISFIED' : 'NOT_SATISFIED',
    reasons,
  }
}

/** Evaluate against the repository as it stands, with the predecessor states a record declares. */
export function evaluateN06InRepo(
  repoRoot: string,
  plannedFinalWitnessUtc: string | null,
  predecessorStates: Readonly<Record<string, NodeState>>
): N06Evaluation {
  const inv = JSON.parse(readFileSync(join(repoRoot, CUSTODY_INVENTORY), 'utf8')) as { entries: Array<Record<string, unknown>>; operator_credential?: unknown }
  if (inv.entries.length !== 1) throw new Error(`The custody inventory holds ${inv.entries.length} entries; exactly one is required.`)
  const entry = inv.entries[0]!
  return evaluateN06({
    rootClause: readRootClause(repoRoot),
    entry,
    plannedFinalWitnessUtc,
    predecessorStates,
    hardPredecessors: hardPredecessorsOf('N06'),
    // AC-6: the operator credential's holders are inventoried too (their own section; not the auditor entry).
    topologyReasons: [...checkInventorySurfaces(repoRoot, entry.processes_or_environments), ...checkOperatorCredentialSection(inv.operator_credential)],
  })
}
