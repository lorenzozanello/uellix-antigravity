// scripts/eval-roles-offline.ts
// FABLE MOONSHOT WS6 / U3: offline evaluation gate for the non-advisor Stella
// roles (validator, composer, proxy_reviewer, evidence_reviewer,
// audit_assistant). Mirrors scripts/eval-offline.ts.
// Fully offline: no network, no DB, no provider, no env secrets — the only
// I/O is reading the committed audit fixtures (RK-27 fixture-grounded case).
// Exits non-zero on any failure.
//
// WIRING NOTE for the coordinator (WS6 must not edit package.json): add
//   "eval:roles": "tsx scripts/eval-roles-offline.ts"
// to the "scripts" block, right after "eval:offline".

import { OFFICIAL_ROLE_EVAL_CASES } from '../tests/eval/stella-roles/cases'
import { runRoleEvalHarness, validateRoleEvalCatalog } from '../tests/eval/stella-roles/harness'
import { extractAguaSeguraFixtures } from '../tests/eval/stella-roles/fixture-grounded'
import { VALIDATOR_OUTPUT_SCHEMA_VERSION } from '../lib/stella/schemas/validator-output'
import { COMPOSER_OUTPUT_SCHEMA_VERSION } from '../lib/stella/schemas/composer-output'
import { REVIEWER_OUTPUT_SCHEMA_VERSION } from '../lib/stella/schemas/reviewer-output'

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function check(name: string, run: () => string): void {
  try {
    results.push({ name, ok: true, detail: run() })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

// Versions declared in docs/20_STELLA_ROLE_CONTRACTS.md — the gate fails if
// the exported constants drift from the documented contract.
const DOCUMENTED_CONTRACT_VERSIONS = {
  validator: '1.0.0',
  composer: '1.0.0',
  reviewer: '1.0.0',
} as const

// ---------------------------------------------------------------------------
// Gate 1 — catalog structure (unique ids, per-role coverage, canaries present)
// ---------------------------------------------------------------------------
check('roles-catalog-structure', () => {
  validateRoleEvalCatalog(OFFICIAL_ROLE_EVAL_CASES)
  const byRole = new Map<string, number>()
  for (const item of OFFICIAL_ROLE_EVAL_CASES) {
    byRole.set(item.role, (byRole.get(item.role) ?? 0) + 1)
  }
  return `${OFFICIAL_ROLE_EVAL_CASES.length} cases — ${[...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(', ')}`
})

// ---------------------------------------------------------------------------
// Gate 2 — every case behaves as its expectation demands
// ---------------------------------------------------------------------------
const { summary, results: caseResults } = runRoleEvalHarness()

check('roles-all-cases-pass', () => {
  const failed = caseResults.filter((r) => !r.ok)
  assertCondition(
    failed.length === 0,
    `failing cases: ${failed.map((r) => `${r.caseId} → ${r.rejection ?? 'accepted'} (${r.rejectionDetail ?? ''})`).join(' | ')}`
  )
  assertCondition(summary.casesPassed === summary.totalCases, 'casesPassed must equal totalCases')
  assertCondition(summary.providerCalls === 0 && summary.geminiCalls === 0, 'expected zero provider calls')
  return `summary=${JSON.stringify(summary)}`
})

// ---------------------------------------------------------------------------
// Gate 3 — all canaries rejected (known-bad outputs MUST fail)
// ---------------------------------------------------------------------------
check('roles-canaries-all-rejected', () => {
  assertCondition(summary.canaryCases >= 5, `expected ≥ 5 canary cases, got ${summary.canaryCases}`)
  assertCondition(
    summary.canariesRejected === summary.canaryCases,
    `only ${summary.canariesRejected}/${summary.canaryCases} canaries were rejected`
  )
  const canaries = caseResults.filter((r) => r.expectation === 'reject')
  return canaries.map((r) => `${r.caseId}→${r.rejection}`).join(', ')
})

// ---------------------------------------------------------------------------
// Gate 4 — contract versions match docs/20_STELLA_ROLE_CONTRACTS.md
// ---------------------------------------------------------------------------
check('roles-contract-versions', () => {
  const actual = {
    validator: VALIDATOR_OUTPUT_SCHEMA_VERSION,
    composer: COMPOSER_OUTPUT_SCHEMA_VERSION,
    reviewer: REVIEWER_OUTPUT_SCHEMA_VERSION,
  }
  for (const [role, expected] of Object.entries(DOCUMENTED_CONTRACT_VERSIONS)) {
    assertCondition(
      actual[role as keyof typeof actual] === expected,
      `${role} schema version ${actual[role as keyof typeof actual]} differs from documented ${expected}`
    )
  }
  assertCondition(
    JSON.stringify(summary.contractVersions) === JSON.stringify(actual),
    'harness-reported versions differ from schema exports'
  )
  return `validator=${actual.validator} composer=${actual.composer} reviewer=${actual.reviewer}`
})

// ---------------------------------------------------------------------------
// Gate 5 — RK-27 fixture-grounded determinism
// ---------------------------------------------------------------------------
check('roles-fixture-grounded-deterministic', () => {
  const first = extractAguaSeguraFixtures()
  const second = extractAguaSeguraFixtures()
  assertCondition(JSON.stringify(first) === JSON.stringify(second), 'fixture extraction is not deterministic')
  assertCondition(first.householdRows > 0 && first.testimonioCount > 0, 'fixture extraction is empty')
  const fixtureCase = caseResults.find((r) => r.caseId === 'roles-evidence_reviewer-fixture-grounded')
  assertCondition(Boolean(fixtureCase?.ok), 'fixture-grounded case did not pass')
  return `households=${first.householdRows} testimonios=${first.testimonioCount} confidence=${first.lineaBaseConfidenceScore}`
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failed = 0
for (const result of results) {
  const status = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  console.log(`[eval:roles] ${status} ${result.name} — ${result.detail}`)
}
console.log(`[eval:roles] ${results.length - failed}/${results.length} gates passed`)
if (failed > 0) {
  console.error(`[eval:roles] FAILED: ${failed} gate(s) did not pass`)
  process.exit(1)
}
console.log(
  `[eval:roles] OK — ${summary.totalCases}/${summary.totalCases} role cases pass, ${summary.canariesRejected}/${summary.canaryCases} canaries rejected, contract versions consistent`
)
