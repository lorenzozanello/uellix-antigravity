// scripts/authority-plan-report.ts
// COMMIT 3 — the operator-facing report of the resolved authority plan.
//
// Prints what a reviewer has to check by eye and what no test can show them:
// which statements each recovered window actually resolved onto, where the
// historical count and this parser's stronger count differ, the exact
// segmentation of the four multi-role windows, and the statements that fall
// outside every window.
//
// It computes; it writes nothing and touches no database.

import {
  buildAuthorityPlan,
  partitionHostedStatements,
  RECOVERED_CHAIN_PACKAGE_IDS,
} from '@/db/hosted/authority/classification-manifest'
import { FORWARD_PACKAGE_IDS } from '@/db/hosted/authority/forward-boundaries'
import { RECOVERED_TOTALS, RECOVERED_WINDOWS } from '@/db/hosted/authority/recovered-boundaries'
import { FORWARD_TOTALS, FORWARD_WINDOWS } from '@/db/hosted/authority/forward-boundaries'
import { validateResolvedAuthorityPlanForGeneration } from '@/db/hosted/authority/execution-disposition'

const plan = buildAuthorityPlan()
const partition = partitionHostedStatements(plan)

/**
 * Counted PER PROVENANCE, and printed that way.
 *
 * A single measured-against-declared line would have read as a two-window drift
 * the moment M-8's forward package landed — which is the failure mode a report
 * has: it trains the reviewer to expect a mismatch, and then the real one is
 * invisible. Recovered and authored are different KINDS of claim, so they get
 * different lines and each is compared against its own declared total.
 */
const bySource = (source: string, c: string): number =>
  plan.windows.filter((w) => w.authoritySource === source && w.authorityClass === c).length

const recovered = (c: string): number => bySource('ORIGINAL_STATEFUL_PARTITION', c)
const authored = (c: string): number => bySource('AUTHORED_FORWARD_REMEDIATION', c)
const recoveredTotal = plan.windows.filter((w) => w.authoritySource === 'ORIGINAL_STATEFUL_PARTITION').length
const authoredTotal = plan.windows.length - recoveredTotal

console.log('=== CLASSIFICATION WINDOWS ===')
console.log('  RECOVERED (A_FINAL stateful partition, transferred verbatim — evidence)')
console.log(
  `    OWNER=${recovered('OWNER')}/${RECOVERED_TOTALS.owner} ` +
    `CAPABILITY=${recovered('CAPABILITY')}/${RECOVERED_TOTALS.capability} ` +
    `OWNER_TRANSFER=${recovered('OWNER_TRANSFER')}/${RECOVERED_TOTALS.transfer} ` +
    `TOTAL=${recoveredTotal}/${RECOVERED_WINDOWS.length}`,
)
console.log('  AUTHORED (forward remediation, boundaries chosen — a decision, not a measurement)')
console.log(
  `    OWNER=${authored('OWNER')}/${FORWARD_TOTALS.owner} ` +
    `CAPABILITY=${authored('CAPABILITY')}/${FORWARD_TOTALS.capability} ` +
    `OWNER_TRANSFER=${authored('OWNER_TRANSFER')}/${FORWARD_TOTALS.transfer} ` +
    `TOTAL=${authoredTotal}/${FORWARD_WINDOWS.length}`,
)
console.log(`  PLAN TOTAL=${plan.windows.length}`)

console.log('\n=== OWNER_AUTHORITY_STATEMENTS vs OWNER_WINDOW_EXECUTABLE_STATEMENTS ===')
console.log('  OWNER_AUTHORITY_STATEMENTS         = 167  (recovered A_FINAL canon)')
console.log('  OWNER_WINDOW_EXECUTABLE_STATEMENTS = 177  (every executable statement, THE PIN)')
console.log('  These are two different quantities. Conflating them is what produced two')
console.log('  wrong explanations already.')
const mismatches = plan.windows.filter(
  (w) => w.historicalStatementCount !== w.structuralStatementCount,
)
if (mismatches.length === 0) console.log('  all 51 agree')
let deltaTotal = 0
let doInsideTotal = 0
let doAnchorTotal = 0
for (const w of mismatches) {
  const dos = w.members.filter((m) => m.identity.statementClass === 'do-block')
  const first = w.members[0].statement.index
  const last = w.members[w.members.length - 1].statement.index
  const doAsAnchor = dos.filter(
    (m) => m.statement.index === first || m.statement.index === last,
  ).length
  const delta = w.structuralStatementCount - w.historicalStatementCount
  deltaTotal += delta
  doInsideTotal += dos.length
  doAnchorTotal += doAsAnchor
  console.log(
    `  ${w.packageId}/${w.windowId} historical=${w.historicalStatementCount} ` +
      `structural=${w.structuralStatementCount} delta=${delta} ` +
      `doInside=${dos.length} doAsAnchor=${doAsAnchor} doEligible=${dos.length - doAsAnchor}`,
  )
}
const doEligible = doInsideTotal - doAnchorTotal
console.log(`  TOTAL delta=${deltaTotal}  DO inside=${doInsideTotal}  DO that are anchors=${doAnchorTotal}`)
console.log(`  => DO additions <= ${doEligible};  non-DO additions >= ${deltaTotal - doEligible}`)
console.log('')
console.log('  ATTRIBUTION HISTORY — two explanations have already been wrong:')
console.log('    Commit 3   "delta = ten DO blocks"   FALSE.')
console.log('    Commit 3.1 "six DO + four non-DO"    UNPROVEN; the anchor bound above')
console.log('               shows the split cannot be that way round.')
console.log('  NOT DETERMINED: the canon that produced the historical integers')
console.log('  (rerun-canon.mjs / afinal-canon.mjs) is not in this repository. An exhaustive')
console.log('  search over 27 statement properties and every union of up to three found ZERO')
console.log('  rules reproducing (2,5,2,1) once anchors are excluded. Category C is')
console.log('  eliminated: the canonical spans measure 35/40/7/22, identical to hosted.')
console.log('  The ten statements are not named here because naming them would be a fit.')

console.log('\n=== PARTITION (hosted) ===')
// SCOPED TO THE RECOVERED CHAIN. The integers on the right were measured over
// the A_FINAL partition, which covered T1..T9; comparing a ten-package
// partition against them would print a permanent mismatch and teach the
// reviewer to ignore this line.
const c = partitionHostedStatements(plan, RECOVERED_CHAIN_PACKAGE_IDS).counts
console.log(`  RECOVERED CHAIN (${RECOVERED_CHAIN_PACKAGE_IDS.join(', ')})`)
console.log(
  `    INSTALLER=${c.installer}/${RECOVERED_TOTALS.installerStatements} ` +
    `OWNER=${c.owner}/${RECOVERED_TOTALS.ownerStatements} ` +
    `CAPABILITY=${c.capability}/${RECOVERED_TOTALS.capabilityStatements} ` +
    `TRANSFER=${c.ownerTransfer}/${RECOVERED_TOTALS.transferStatements} ` +
    `MANAGED=${c.managedRewrite}/${RECOVERED_TOTALS.managedRewriteStatements} ` +
    `BOOKKEEPING=${c.bookkeeping}/${RECOVERED_TOTALS.bookkeepingStatements}`,
)
console.log(
  `    governed+bookkeeping=${c.installer + c.owner + c.capability + c.ownerTransfer + c.managedRewrite + c.bookkeeping}/${RECOVERED_TOTALS.hostedStatements}  EXCLUDED=${c.excluded}  file total=${c.total}`,
)

if (FORWARD_PACKAGE_IDS.length > 0) {
  const f = partitionHostedStatements(plan, FORWARD_PACKAGE_IDS).counts
  console.log(`  FORWARD, AUTHORED (${FORWARD_PACKAGE_IDS.join(', ')}) — no historical figure exists`)
  console.log(
    `    INSTALLER=${f.installer} OWNER=${f.owner} CAPABILITY=${f.capability} ` +
      `TRANSFER=${f.ownerTransfer} MANAGED=${f.managedRewrite} BOOKKEEPING=${f.bookkeeping}`,
  )
  console.log(`    EXCLUDED=${f.excluded}  file total=${f.total}`)
}

const whole = partition.counts
console.log(`  WHOLE PLAN: file total=${whole.total}  EXCLUDED=${whole.excluded}`)

console.log('\n=== INSTALLER statements (outside every window) ===')
for (const row of partition.installerStatements) {
  console.log(`  ${row.packageId}[${row.statement.index}] ownerBefore=${row.ownerBefore} :: ${row.statement.executable.slice(0, 88)}`)
}

console.log('\n=== ownerBefore vs window class disagreements ===')
if (partition.disagreements.length === 0) console.log('  none')
for (const d of partition.disagreements) {
  console.log(
    `  ${d.row.packageId}[${d.row.statement.index}] ${d.windowId} says ${d.windowClass}, simulation says ${d.simulated}\n      ${d.row.statement.executable.slice(0, 96)}`,
  )
}

console.log('\n=== EXECUTION SEGMENTS ===')
const seg = (c2: string): number => plan.segments.filter((s) => s.authorityClass === c2).length
console.log(
  `  OWNER=${seg('OWNER')} CAPABILITY=${seg('CAPABILITY')} TRANSFER=${seg('OWNER_TRANSFER')} TOTAL=${plan.segments.length}`,
)
const multi = plan.windows.filter(
  (w) => plan.segments.filter((s) => s.classificationWindowId === w.windowId).length > 1,
)
console.log(`  windows needing more than one segment: ${multi.map((w) => w.windowId).join(', ') || 'none'}`)

console.log('\n=== MULTI-ROLE WINDOW TABLES (W29, W38, W46, W47, W51) ===')
for (const id of ['W29', 'W38', 'W46', 'W47', 'W51']) {
  const window = plan.windows.find((w) => w.windowId === id)
  if (window === undefined) continue
  console.log(`\n  ${window.packageId}/${id} ${window.authorityClass} n=${window.structuralStatementCount}`)
  const segments = plan.segments.filter((s) => s.classificationWindowId === id)
  for (const member of window.members) {
    const owning =
      window.authorityClass === 'OWNER_TRANSFER' ? member.ownerDestination : member.ownerBefore
    const segment = segments.find((s) =>
      window.members
        .slice(
          window.members.findIndex((m) => m.statement.index === member.statement.index) -
            member.statement.index,
        )
        .length >= 0
        ? s.classificationWindowId === id
        : false,
    )
    void segment
    console.log(
      `    [${String(member.statement.index).padStart(3)}] ${owning ?? '-'}  ${member.identity.statementClass}  ${member.identity.object ? member.identity.object.name : ''}`,
    )
  }
  for (const s of segments) {
    console.log(`    -> ${s.segmentId} executor=${s.executor} n=${s.statementCount} tempCreate=${s.requiredTemporarySchemaCreate ?? '-'}`)
  }
}

console.log('\n=== TEMPORARY SCHEMA CREATE ===')
const capCreate = plan.segments.filter(
  (s) => s.authorityClass === 'CAPABILITY' && s.requiredTemporarySchemaCreate !== null,
)
const trCreate = plan.segments.filter(
  (s) => s.authorityClass === 'OWNER_TRANSFER' && s.requiredTemporarySchemaCreate !== null,
)
console.log(`  CAPABILITY execution segments needing temp CREATE: ${capCreate.length} (${capCreate.map((s) => s.segmentId).join(', ')})`)
console.log(`  TRANSFER execution segments needing temp CREATE:   ${trCreate.length}`)

/* -------------------------------------------------------------------------- */
/* Execution disposition — the F-01 crosscheck                                 */
/* -------------------------------------------------------------------------- */

const gate = validateResolvedAuthorityPlanForGeneration(plan)

console.log('\n=== PRE-GENERATION GATE ===')
for (const check of gate.checks) console.log(`  PASS  ${check}`)

console.log('\n=== EXECUTION DISPOSITION (no residual bucket) ===')
const byKind = new Map<string, number>()
for (const d of gate.dispositions) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1)
for (const [kind, n] of [...byKind.entries()].sort()) console.log(`  ${kind}: ${n}`)
console.log(`  TOTAL ${gate.dispositions.length}`)

console.log('\n=== CANONICAL ROLE-CONTEXT OBLIGATIONS ===')
for (const context of gate.canonicalRoleContexts) {
  console.log(
    `  ${context.packageId}[${context.statementIndex}] must run as ${context.requiredExecutor}` +
      `\n      ${context.statementIdentity}` +
      `\n      opened by ${context.spanOpenedBy}, digest ${context.digest.slice(0, 16)}…`,
  )
}
console.log(`  CANONICAL_ROLE_CONTEXT_OBLIGATIONS = ${gate.canonicalRoleContexts.length}`)

console.log('\n=== INSTALLER, with the positive reason each one qualifies ===')
for (const d of gate.dispositions.filter((x) => x.kind === 'INSTALLER')) {
  console.log(`  ${d.packageId}[${d.statementIndex}] ${d.statementIdentity}\n      ${d.reason}`)
}
