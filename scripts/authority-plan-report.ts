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
} from '@/db/hosted/authority/classification-manifest'
import { RECOVERED_TOTALS } from '@/db/hosted/authority/recovered-boundaries'
import { validateResolvedAuthorityPlanForGeneration } from '@/db/hosted/authority/execution-disposition'

const plan = buildAuthorityPlan()
const partition = partitionHostedStatements(plan)

const byClass = (c: string): number => plan.windows.filter((w) => w.authorityClass === c).length

console.log('=== CLASSIFICATION WINDOWS ===')
console.log(
  `  OWNER=${byClass('OWNER')}/${RECOVERED_TOTALS.owner} ` +
    `CAPABILITY=${byClass('CAPABILITY')}/${RECOVERED_TOTALS.capability} ` +
    `OWNER_TRANSFER=${byClass('OWNER_TRANSFER')}/${RECOVERED_TOTALS.transfer} ` +
    `TOTAL=${plan.windows.length}/51`,
)

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
const c = partition.counts
console.log(
  `  INSTALLER=${c.installer}/${RECOVERED_TOTALS.installerStatements} ` +
    `OWNER=${c.owner}/${RECOVERED_TOTALS.ownerStatements} ` +
    `CAPABILITY=${c.capability}/${RECOVERED_TOTALS.capabilityStatements} ` +
    `TRANSFER=${c.ownerTransfer}/${RECOVERED_TOTALS.transferStatements} ` +
    `MANAGED=${c.managedRewrite}/${RECOVERED_TOTALS.managedRewriteStatements} ` +
    `BOOKKEEPING=${c.bookkeeping}/${RECOVERED_TOTALS.bookkeepingStatements}`,
)
console.log(
  `  governed+bookkeeping=${c.installer + c.owner + c.capability + c.ownerTransfer + c.managedRewrite + c.bookkeeping}/${RECOVERED_TOTALS.hostedStatements}  EXCLUDED=${c.excluded}  file total=${c.total}`,
)

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
