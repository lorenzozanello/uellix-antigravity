// tests/cross-workstream/project-binding.test.ts
// INTEGRATION — Train 4.2, FASES 6, 9 and 12. R2-INT.
//
// The seams the project binding crosses, checked from the OTHER side of each
// one. Nothing here opens a database or a network socket; the behavioural half
// of the invariant lives in tests/cross-workstream/runtime-grounded-query.test.ts
// (recorded adapter arguments) and its real half in
// tests/e2e/stella-ticket-journey.e2e.test.ts (a live disposable PostgreSQL).
//
// WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
//
// It is the place where two workstreams' beliefs are compared against each
// other rather than against themselves: CAPABILITIES believes it published four
// project-bound SQL signatures; the RUNTIME believes it calls them. Both can be
// internally consistent and disagree. Every assertion below reads BOTH sides.
//
// It is NOT a second model of the protocol. There is no simulated `bind` here,
// no reimplementation of U0110, and no fixture standing in for a charge.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { readSourceText, toLf, bothLineEndings } from '@/tests/helpers/source-text'
import {
  evaluateProjectTicketGates,
  PROJECT_ARGUMENT,
  PROJECT_BOUND_FUNCTIONS,
  PROJECT_MISMATCH_SQLSTATE,
  PROJECT_TICKET_FORWARD,
  PROJECT_TICKET_ROLLBACK,
} from '@/tests/helpers/stella-project-ticket-gates'
import {
  PREPARED_PACKAGE_SUPERSESSIONS,
  PROJECT_BLIND_TICKET_SIGNATURES,
  PROJECT_BOUND_TICKET_SIGNATURES,
  STELLA_TICKET_PACKAGE_CHAIN,
  packageOrderRefusal,
  supersessionsFor,
} from '@/db/prepared-package-order'

const ROOT = process.cwd()

const PROJECT_SQL = readSourceText(`db/prepared/${PROJECT_TICKET_FORWARD}`)
const ROLLBACK_SQL = readSourceText(`db/prepared/${PROJECT_TICKET_ROLLBACK}`)
const ADAPTER_TS = readSourceText('db/stella/operation-tickets.ts')
const ACTION_TS = readSourceText('app/actions/stella/grounded-query.ts')
const PRODUCT_CONTRACT_TS = readSourceText('components/stella/grounded-query.ts')
const ORACLE_TS = readSourceText('tests/eval/stella-release/idempotency-oracle.ts')
const PROJECT_GATE_TS = readSourceText('tests/eval/stella-release/project-binding-release-gate.ts')
const HARNESS_TS = readSourceText('tests/eval/stella-release/project-binding-harness.ts')
const E2E_TS = readSourceText('tests/e2e/stella-ticket-journey.e2e.test.ts')

/** Source with comments stripped: "must NOT appear" assertions otherwise punish
 *  a module for documenting exactly what it refuses to do. */
function codeLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('--'))
    .join('\n')
}

/* ========================================================================== */
/* 1. CAPABILITIES -> RUNTIME                                                 */
/* ========================================================================== */

describe('CAPABILITIES -> RUNTIME: the four new signatures are the four the adapter calls', () => {
  it('every verb the package publishes takes p_expected_project_id, and the adapter passes it in the SAME slot', () => {
    for (const { name } of PROJECT_BOUND_FUNCTIONS) {
      // The SQL side: the signature exists with the project argument second.
      const declaration = new RegExp(
        `CREATE OR REPLACE FUNCTION uellix_stella_ops\\.${name}\\(\\s*\\n\\s*p_ticket_id char\\(64\\),\\s*\\n\\s*${PROJECT_ARGUMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      )
      expect(PROJECT_SQL, `${name} does not take ${PROJECT_ARGUMENT} in position 2`).toMatch(declaration)

      // The TypeScript side: the adapter's SQL literal calls it with three (or
      // two, for inspect) arguments, the project cast to uuid, second.
      const call = new RegExp(
        `uellix_stella_ops\\.${name}\\(\\s*\\n\\s*\\$\\{ticketId\\}::char\\(64\\),\\s*\\n\\s*\\$\\{expectedProjectId\\}::uuid`,
      )
      expect(ADAPTER_TS, `the adapter calls ${name} without the project in position 2`).toMatch(call)
    }
  })

  it('the adapter REQUIRES the project in TypeScript — the old two-argument shape does not compile', () => {
    // An optional trailing parameter would be a signature the old call sites
    // still satisfy; making it required in the SQL's own position is the
    // TypeScript counterpart of stella_0015 §3 DROPping the unbound overloads.
    for (const fn of ['bindOperationTicket', 'completeOperationTicket']) {
      expect(ADAPTER_TS).toMatch(
        new RegExp(`export async function ${fn}\\(\\s*\\n\\s*ticketId: string,\\s*\\n\\s*expectedProjectId: string,\\s*\\n\\s*queryHash: string,`),
      )
    }
    expect(ADAPTER_TS).toMatch(
      /export async function abortOperationTicket\(\s*\n\s*ticketId: string,\s*\n\s*expectedProjectId: string,\s*\n\s*reason: OperationTicketAbortReason,/,
    )
    expect(ADAPTER_TS).toMatch(
      /export async function inspectOperationTicket\(\s*\n\s*ticketId: string,\s*\n\s*expectedProjectId: string,\s*\n\)/,
    )
    // No optional project anywhere: `expectedProjectId?` is the old shape.
    expect(codeLines(ADAPTER_TS)).not.toMatch(/expectedProjectId\?/)
  })

  it('the OLD signatures do not resolve: the package drops all four and the adapter emits none', () => {
    for (const { name, legacy } of PROJECT_BOUND_FUNCTIONS) {
      expect(PROJECT_SQL).toContain(`DROP FUNCTION IF EXISTS uellix_stella_ops.${name}(${legacy});`)
    }
    // And no two-argument call survives in the adapter. Measured as "every call
    // to a governed verb names the project", rather than as an absence.
    const calls = ADAPTER_TS.match(/uellix_stella_ops\.\w+\(/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const { name } of PROJECT_BOUND_FUNCTIONS) {
      const at = ADAPTER_TS.indexOf(`uellix_stella_ops.${name}(`)
      expect(at, `${name} is not called by the adapter at all`).toBeGreaterThan(-1)
      // A fixed line window, not `indexOf(')')`: the first argument is
      // `${ticketId}::char(64)`, whose own parenthesis would close the slice
      // before the project argument was ever in it — and the assertion would
      // then be about a string that stops one line too early.
      const args = ADAPTER_TS.slice(at).split('\n').slice(0, 5).join('\n')
      expect(args, `${name} is called without an execution project`).toContain('${expectedProjectId}::uuid')
    }
  })

  it('U0110 is preserved end to end and sanitized at the product boundary', () => {
    // SQL raises it, and raises it for nothing else.
    expect(PROJECT_SQL).toContain(`USING ERRCODE = '${PROJECT_MISMATCH_SQLSTATE}'`)
    // The adapter maps it, by SQLSTATE and never by message text.
    expect(ADAPTER_TS).toContain(`PROJECT_MISMATCH: '${PROJECT_MISMATCH_SQLSTATE}'`)
    expect(ADAPTER_TS).toMatch(/case TICKET_ERROR_CODES\.PROJECT_MISMATCH:[\s\S]{0,600}?return 'out_of_scope'/)
    // No identifier crosses the boundary: the SQL message names no project and
    // no ticket, and the adapter interpolates nothing into a rejection.
    const raises = PROJECT_SQL.match(/RAISE EXCEPTION '[^']*' USING ERRCODE = 'U0110'/g) ?? []
    expect(raises.length).toBe(PROJECT_BOUND_FUNCTIONS.length)
    for (const raise of raises) {
      expect(raise).not.toMatch(/%/)
      expect(raise).toContain('a different project')
    }
  })

  it('the error stack is walked through error.cause, so a wrapped SQLSTATE is still classified', () => {
    // Drizzle wraps every driver failure; reading `error.code` at the top level
    // finds `undefined` for EVERY refusal the package raises, and all of them
    // would silently classify as `unavailable` — "the system broke" instead of
    // "your ticket was refused".
    expect(ADAPTER_TS).toMatch(/function sqlStateOf\(error: unknown\)/)
    expect(ADAPTER_TS).toMatch(/current = \(current as \{ cause\?: unknown \}\)\.cause/)
    // Depth-bounded: a cause cycle must not hang the request.
    expect(ADAPTER_TS).toMatch(/depth < \d+/)
  })

  it('the five older rejection reasons stay distinguishable — U0110 widened nothing', () => {
    for (const [code, reason] of [
      ['U0100', 'malformed'],
      ['U0102', 'out_of_scope'],
      ['U0106', 'ungoverned'],
      ['U0107', 'query_mismatch'],
      ['U0108', 'expired'],
      ['U0109', 'settled'],
    ] as const) {
      expect(ADAPTER_TS).toContain(`'${code}'`)
      expect(ADAPTER_TS).toContain(`return '${reason}'`)
    }
  })
})

/* ========================================================================== */
/* 2. Package order (R2a) — the reapply fails CLOSED                          */
/* ========================================================================== */

describe('CAPABILITIES -> RUNTIME: applying stella_0014 over stella_0015 is refused before anything is published', () => {
  it('the registry names the canonical chain and exactly the signatures stella_0015 drops', () => {
    expect(STELLA_TICKET_PACKAGE_CHAIN).toEqual([
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
      'stella_0015_project_bound_operation_tickets',
    ])
    // The guard's idea of "unsafe" must be the package's own. Both lists are
    // to_regprocedure spellings; a drift here would make the guard protect a
    // signature nobody publishes while missing the one that matters.
    for (const { name, legacy } of PROJECT_BOUND_FUNCTIONS) {
      expect(PROJECT_BLIND_TICKET_SIGNATURES).toContain(`uellix_stella_ops.${name}(${legacy})`)
      expect(PROJECT_SQL).toContain(`DROP FUNCTION IF EXISTS uellix_stella_ops.${name}(${legacy});`)
    }
    for (const signature of PROJECT_BOUND_TICKET_SIGNATURES) {
      expect(PROJECT_SQL, `${signature} is not asserted by the package's own verification`).toContain(signature)
    }
  })

  it('the rule fires only for stella_0014, and only when the successor is actually installed', () => {
    const rules = supersessionsFor('db/prepared/stella_0014_operation_tickets.sql')
    expect(rules).toHaveLength(1)
    const [rule] = rules

    // Successor present -> refusal, naming what would be republished.
    const refusal = packageOrderRefusal(rule!, true)
    expect(refusal).not.toBeNull()
    expect(refusal!).toContain('stella_0015_project_bound_operation_tickets.sql is already installed')
    for (const signature of PROJECT_BLIND_TICKET_SIGNATURES) {
      expect(refusal!).toContain(signature)
    }

    // Successor absent -> the ordinary forward chain converges, untouched.
    expect(packageOrderRefusal(rule!, false)).toBeNull()
  })

  it('no other prepared script carries a rule, so the guard costs zero round trips elsewhere', () => {
    for (const other of ['stella_0013_grounded_query_quota', 'stella_0015_project_bound_operation_tickets', 'grounding_0004_runtime_attestation']) {
      expect(supersessionsFor(`${other}.sql`)).toHaveLength(0)
    }
    // Exact-match, never prefix: a hypothetical stella_0014b must not silently
    // inherit stella_0014's rule.
    expect(supersessionsFor('stella_0014b_something.sql')).toHaveLength(0)
    expect(PREPARED_PACKAGE_SUPERSESSIONS).toHaveLength(1)
  })

  it('the probe asks the CATALOG, not a version table, and is a fixed literal', () => {
    const [rule] = PREPARED_PACKAGE_SUPERSESSIONS
    expect(rule!.probe).toContain('to_regprocedure')
    expect(rule!.probe).toContain('bind_operation_ticket(character, uuid, character)')
    // Nothing from the file being applied can reach the probe: no template
    // hole, no concatenation.
    expect(rule!.probe).not.toMatch(/\$\{|\+\s*\w+/)
  })

  it('the guard also sits on the path that ACTUALLY applies these packages — psql as superuser', () => {
    // ADVERSARIAL REVIEW A (Train 4.2), and it was exact: `applyPreparedScript`
    // does `SET LOCAL ROLE uellix_owner`, while stella_0014 §0 and stella_0015
    // §0 both refuse anything that is not `rolsuper`. So the migrator guard,
    // correct as it is, can never fire for THESE two packages — it was placed
    // where the train does not pass.
    //
    // The real path is `psql` as superuser, which is what
    // scripts/stella-ticket-e2e.sh does and what every prepared header
    // documents. The precondition therefore lives there too, and this test is
    // what stops the two from drifting into disagreeing about the rule.
    const script = readSourceText('scripts/stella-ticket-e2e.sh')
    const [rule] = PREPARED_PACKAGE_SUPERSESSIONS

    expect(script).toMatch(/package_order_guard\(\)/)
    // Applied BEFORE the file is copied and run, never after.
    const guardCall = script.indexOf('package_order_guard "$f"')
    const apply = script.indexOf('-f "/$f.sql"')
    expect(guardCall, 'the shell loop does not call the guard').toBeGreaterThan(-1)
    expect(guardCall).toBeLessThan(apply)

    // The SAME package and the SAME catalog probe as the TypeScript registry.
    expect(script).toContain(rule!.packageName)
    expect(script).toContain('uellix_stella_ops.bind_operation_ticket(character, uuid, character)')
    expect(script).toContain('DB_MIGRATOR_PACKAGE_ORDER_VIOLATION')
  })

  it('the migrator runs the guard as a PRECONDITION, inside the transaction, before the script', () => {
    const migrator = readSourceText('db/migrator.ts')
    const guardAt = migrator.indexOf('await assertPreparedPackageOrder(')
    const scriptAt = migrator.indexOf('await tx.unsafe(source).simple()')
    expect(guardAt, 'the migrator does not call the package-order guard').toBeGreaterThan(-1)
    expect(scriptAt).toBeGreaterThan(-1)
    // The ORDER is the property: a guard after the script would have committed
    // the unsafe signatures on any path that skipped the rollback.
    expect(guardAt).toBeLessThan(scriptAt)
    expect(migrator).toContain('DB_MIGRATOR_PACKAGE_ORDER_VIOLATION')
  })

  it('the rollback of stella_0015 does not restore the project-blind signatures', () => {
    for (const { name } of PROJECT_BOUND_FUNCTIONS) {
      // The rollback republishes the stella_0014 shapes on purpose for two of
      // the six functions? No — it must not republish ANY unbound verb.
      expect(codeLines(ROLLBACK_SQL)).not.toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION uellix_stella_ops\\.${name}\\(\\s*\\n\\s*p_ticket_id char\\(64\\),\\s*\\n\\s*p_query_hash`),
      )
    }
    // And it says so as a machine-checked postcondition rather than as prose.
    expect(ROLLBACK_SQL).toMatch(/FAILED verification|RAISE EXCEPTION/)
  })
})

/* ========================================================================== */
/* 3. RUNTIME -> GROUNDING                                                    */
/* ========================================================================== */

describe('RUNTIME -> GROUNDING: the retrieval scope is the derived execution project', () => {
  it('the Grounding scope is built by the same object that carries the ticket verbs', () => {
    // One factory, one value. `scope(organizationId)` is a member of
    // `ExecutionProject`, so a scope built from a different project cannot be
    // constructed without constructing a second ExecutionProject.
    expect(ACTION_TS).toMatch(/scope\(organizationId: string\): GroundingScope/)
    expect(ACTION_TS).toMatch(/scope:\s*\(organizationId\)\s*=>\s*\(\{ organizationId, projectId \}\)/)
    expect(ACTION_TS).toMatch(/const scope: GroundingScope = project\.scope\(organizationId\)/)
  })

  it('the repository is constructed from that scope and from nothing else', () => {
    expect(ACTION_TS).toMatch(/createPersistedGroundingChunkRepository\(scope\)/)
    // A second construction site is a second chance to hand it another project.
    expect((codeLines(ACTION_TS).match(/createPersistedGroundingChunkRepository\(/g) ?? [])).toHaveLength(1)
  })

  it('bind happens BEFORE any chunk is read, so a cross-project ticket never reaches evidence', () => {
    const code = codeLines(ACTION_TS)
    const bind = code.indexOf('project.bindTicket(')
    const evidence = code.indexOf('createPersistedGroundingChunkRepository(')
    const complete = code.indexOf('project.completeTicket(')
    expect(bind).toBeGreaterThan(-1)
    expect(bind).toBeLessThan(evidence)
    expect(evidence).toBeLessThan(complete)
  })

  it('there is exactly one derivation of the execution project in the whole module', () => {
    const code = codeLines(ACTION_TS)
    expect((code.match(/function deriveExecutionProject\(/g) ?? [])).toHaveLength(1)
    // The action derives once; the issuance surface reuses the SAME function
    // rather than re-implementing a trim, so the project welded onto a ticket
    // and the project asserted at execution cannot drift.
    expect((code.match(/deriveExecutionProject\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

/* ========================================================================== */
/* 4. RUNTIME -> PRODUCT                                                      */
/* ========================================================================== */

describe('RUNTIME -> PRODUCT: the payload did not grow a project, and a mismatch is not a provider fault', () => {
  it('StellaGroundedQueryRequest still has exactly one field', () => {
    const start = PRODUCT_CONTRACT_TS.indexOf('export interface StellaGroundedQueryRequest {')
    const body = PRODUCT_CONTRACT_TS.slice(start, PRODUCT_CONTRACT_TS.indexOf('}', start))
    const fields = body.split('\n').filter((l) => /^\s+readonly\s/.test(l))
    expect(fields).toHaveLength(1)
    expect(fields[0]).toContain('query: string')
  })

  it('the ticket is still a separate parameter of the runner, and so is the project', () => {
    expect(PRODUCT_CONTRACT_TS).toContain(
      toLf('export type StellaGroundedQueryRunner = (\n  request: StellaGroundedQueryRequest,\n  ticket: StellaOperationTicket,\n) => Promise<StellaGroundedQueryResult>'),
    )
    // The project reaches the action as a BOUND argument, never through the
    // runner's own signature — so a client holding a runner cannot choose one.
    // Over CODE: the contract's prose explains that the project is bound
    // server-side, and naming it there must not fail this test.
    expect(codeLines(PRODUCT_CONTRACT_TS)).not.toMatch(/projectId/)
  })

  it('a project mismatch reaches the reviewer as UNAUTHORIZED, never as an AI-service error', () => {
    // `out_of_scope` is what U0110 becomes, and every scope failure shares one
    // sentence — telling them apart on screen would be an oracle.
    expect(ACTION_TS).toMatch(/function groundedTicketRejection\(/)
    const start = ACTION_TS.indexOf('function groundedTicketRejection(')
    const body = ACTION_TS.slice(start, ACTION_TS.indexOf('\n}', start))
    expect(body).toContain("'UNAUTHORIZED'")
    expect(body).not.toContain('GEMINI_ERROR')
    // And the module names no provider on any refusal path at all.
    expect(codeLines(ACTION_TS)).not.toMatch(/GEMINI_ERROR/)
  })

  it('the post-complete retry keeps its named state, and now records what it READ', () => {
    expect(ACTION_TS).toContain('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
    // The retry inspects under the execution project; a ticket of another
    // project is `unreadable` rather than an error, and that name is what keeps
    // the two apart in the audit trail.
    expect(ACTION_TS).toMatch(/project\.inspectTicket\(options\.ticket\)/)
    expect(ACTION_TS).toMatch(/ticketState: settledState === null \? 'unreadable' : settledState\.status/)
  })

  it('no human decision is persisted by this path', () => {
    const code = codeLines(ACTION_TS)
    expect(code).not.toMatch(/recordStellaDecision|suggestion_decisions|stellaDecisions/)
  })
})

/* ========================================================================== */
/* 5. FASE 6 — the 'use server' endpoint surface                              */
/* ========================================================================== */

/** Every module in the tree whose first non-empty line is a 'use server' prologue. */
function useServerModules(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (statSync(full).size > 2_000_000) continue
      const head = toLf(readFileSync(full, 'utf8')).split('\n').slice(0, 5).join('\n')
      if (/^\s*['"]use server['"]\s*;?\s*$/m.test(head)) {
        found.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  for (const top of ['app', 'lib', 'db', 'components']) {
    const dir = path.join(root, top)
    try {
      statSync(dir)
    } catch {
      continue
    }
    walk(dir)
  }
  return found.sort()
}

describe("FASE 6: no 'use server' module publishes a low-level ticket verb", () => {
  const modules = useServerModules(ROOT)

  it('finds the grounded-query action among the scanned modules — the scanner is not looking at nothing', () => {
    expect(modules.length).toBeGreaterThan(5)
    expect(modules).toContain('app/actions/stella/grounded-query.ts')
  })

  it('none of them exports bind/complete/abort/inspect, or re-exports the adapter', () => {
    for (const rel of modules) {
      const source = readSourceText(rel)
      for (const verb of [
        'bindOperationTicket',
        'completeOperationTicket',
        'abortOperationTicket',
        'inspectOperationTicket',
        'issueOperationTicket',
      ]) {
        // An `export { bindOperationTicket }` or `export const bind... =` in a
        // 'use server' module publishes an independently invocable endpoint
        // that takes whatever the client sends — including a project.
        expect(source, `${rel} exports ${verb} as a server-action endpoint`).not.toMatch(
          new RegExp(`export\\s+(async\\s+)?(function|const|let)\\s+${verb}\\b`),
        )
        expect(source, `${rel} re-exports ${verb}`).not.toMatch(
          new RegExp(`export\\s*\\{[^}]*\\b${verb}\\b[^}]*\\}`),
        )
      }
      expect(source, `${rel} re-exports the whole ticket adapter`).not.toMatch(
        /export\s+\*\s+from\s+['"]@?\/?.*operation-tickets['"]/,
      )
    }
  })

  it('the grounded-query action exports exactly two endpoints, both taking the server-bound project FIRST', () => {
    const exported = [...ACTION_TS.matchAll(/^export\s+async\s+function\s+(\w+)/gm)].map((m) => m[1])
    expect(exported.sort()).toEqual([
      'issueStellaGroundedQueryTicketForProject',
      'runStellaGroundedQueryForProject',
    ])
    // No other export shape either — a `export const x = ...` is an endpoint too.
    expect(codeLines(ACTION_TS)).not.toMatch(/^export\s+(const|let|var|\{)/m)

    // ISSUANCE derives the project on the server: one parameter, bound at the
    // mount site, and re-verified in SQL.
    expect(ACTION_TS).toMatch(
      /export async function issueStellaGroundedQueryTicketForProject\(\s*\n\s*projectId: string,\s*\n\)/,
    )
    // EXECUTION revalidates it: projectId first (bind prepends), then the
    // one-field request, then the ticket as its own argument.
    expect(ACTION_TS).toMatch(
      /export async function runStellaGroundedQueryForProject\(\s*\n\s*projectId: string,\s*\n\s*request: StellaGroundedQueryRequest,\s*\n\s*ticket: string,\s*\n\)/,
    )
  })

  it('transporting a ticket cannot change its scope: the execution project is never read back from it', () => {
    const code = codeLines(ACTION_TS)
    expect(code).not.toMatch(/ticket\.project|projectOf\(|projectFromTicket/)
    // And the only project the action ever names downstream is the derived one.
    expect(code).toMatch(/const execution = deriveExecutionProject\(options\.boundProjectId\)/)
    expect(code).toMatch(/const project = executionProject\(execution\)/)
  })

  it('there is no second, older route that omits the execution project', () => {
    // The whole tree, not just the action: a forgotten helper elsewhere that
    // still called the two-argument shape would typecheck against nothing and
    // fail only at runtime, in SQL, as U0100.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        const rel = path.relative(ROOT, full).split(path.sep).join('/')
        // The adapter defines them; the doubles in tests name them as mock keys.
        if (rel === 'db/stella/operation-tickets.ts' || rel.startsWith('tests/')) continue
        const source = codeLines(toLf(readFileSync(full, 'utf8')))
        for (const verb of ['bindOperationTicket', 'completeOperationTicket', 'abortOperationTicket', 'inspectOperationTicket']) {
          const call = new RegExp(`${verb}\\(([^)]*)\\)`, 'g')
          for (const match of source.matchAll(call)) {
            const args = match[1]!.split(',').map((a) => a.trim()).filter(Boolean)
            if (args.length < 3 && !(verb === 'inspectOperationTicket' && args.length === 2)) {
              offenders.push(`${rel}: ${verb}(${match[1]})`)
            }
          }
        }
      }
    }
    for (const top of ['app', 'lib', 'db', 'components', 'scripts']) {
      try {
        statSync(path.join(ROOT, top))
      } catch {
        continue
      }
      walk(path.join(ROOT, top))
    }
    expect(offenders).toEqual([])
  })
})

/* ========================================================================== */
/* 6. RUNTIME -> RELEASE                                                      */
/* ========================================================================== */

describe('RUNTIME -> RELEASE: the oracle reads real rows, and the reference model stays an oracle', () => {
  it('the quota oracle can require a charge project, and says so by name', () => {
    expect(ORACLE_TS).toContain('expectedChargeProjectId')
    expect(ORACLE_TS).toMatch(/forTicket\[0\]!\.projectId !== expectation\.expectedChargeProjectId/)
    // The failure message has to name the insufficiency it closes: an oracle
    // that only checks organization_id passes while a charge drifts to a
    // sibling project of the same organization.
    expect(ORACLE_TS).toMatch(/not merely a project that shares the charge's organization/)
  })

  it('the runtime gate requires all seven proofs and fails closed with no report', () => {
    for (const field of [
      'bindRejectedForeignProject',
      'completeRejectedForeignProject',
      'abortRejectedForeignProject',
      'inspectRejectedForeignProject',
      'chargeAttributedToExecutionProject',
      'zeroChargeOnAttack',
      'legacySignatureInvocable',
    ]) {
      expect(PROJECT_GATE_TS, `runtime-project-attribution-verified ignores ${field}`).toContain(field)
    }
    expect(PROJECT_GATE_TS).toMatch(/if \(!report\) \{[\s\S]{0,400}passed: false/)
  })

  it('the E2E — not the reference model — is what can supply that report', () => {
    // The reference protocol is an ORACLE: it says what a correct system would
    // do. It cannot be evidence that THIS system does it, and the boundary is
    // that the runtime report is built from database reads.
    expect(E2E_TS).toContain('RuntimeProjectAttributionReport')
    expect(E2E_TS).toMatch(/computeProjectBindingGateReport/)
    // The harness (reference model) must not be imported by the E2E as a source
    // of runtime truth — only its gate reducer is.
    expect(E2E_TS).not.toMatch(/createReferenceTicketProtocol/)
  })

  it('the harness keeps its negative controls, including the one that proves an org-only oracle is insufficient', () => {
    expect(HARNESS_TS).toContain('nc-oracle-checking-only-organization-insufficient')
    expect(HARNESS_TS).toContain('nc-legacy-signature-bypasses-project-gate')
  })
})

/* ========================================================================== */
/* 7. FASE 9 — the gates BITE, under both line endings and under mutation     */
/* ========================================================================== */

describe('FASE 9: the project-binding gates bite identically under LF and CRLF', () => {
  it('the real package passes in BOTH materializations — the verdict does not depend on line endings', () => {
    for (const [label] of bothLineEndings('')) {
      const flip = (text: string) => (label === 'CRLF' ? text.replace(/\n/g, '\r\n') : text)
      const violations = evaluateProjectTicketGates({
        [PROJECT_TICKET_FORWARD]: flip(PROJECT_SQL),
        [PROJECT_TICKET_ROLLBACK]: flip(ROLLBACK_SQL),
      })
      expect(violations, `${label}: the shipped package must pass`).toEqual([])
    }
  })

  it('removing p_expected_project_id is caught — under LF and under CRLF alike', () => {
    // The mutation FASE 9 names explicitly. Applied to the real file, so it is
    // a mutation of the shipped bytes rather than of a fixture that resembles
    // them.
    const mutated = PROJECT_SQL.replaceAll(`  ${PROJECT_ARGUMENT},\n`, '')
    expect(mutated, 'the mutation did not change anything — the anchor drifted').not.toBe(PROJECT_SQL)

    for (const [label, text] of bothLineEndings(mutated)) {
      const violations = evaluateProjectTicketGates({
        [PROJECT_TICKET_FORWARD]: text,
        [PROJECT_TICKET_ROLLBACK]: label === 'CRLF' ? ROLLBACK_SQL.replace(/\n/g, '\r\n') : ROLLBACK_SQL,
      })
      expect(violations.length, `${label}: a package with no execution project was accepted`).toBeGreaterThan(0)
    }
  })

  it('reintroducing an old signature is caught — under LF and under CRLF alike', () => {
    // The second mutation FASE 9 names: the DROP is removed, so the
    // project-blind overload survives next to its own replacement. This is
    // exactly what a careless re-apply of stella_0014 would leave behind.
    const mutated = PROJECT_SQL.replace(
      'DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(character, character);',
      '-- (removed)',
    )
    expect(mutated).not.toBe(PROJECT_SQL)

    for (const [label, text] of bothLineEndings(mutated)) {
      const violations = evaluateProjectTicketGates({
        [PROJECT_TICKET_FORWARD]: text,
        [PROJECT_TICKET_ROLLBACK]: label === 'CRLF' ? ROLLBACK_SQL.replace(/\n/g, '\r\n') : ROLLBACK_SQL,
      })
      expect(violations.length, `${label}: a surviving project-blind signature was accepted`).toBeGreaterThan(0)
    }
  })

  it('the two suites holding the three CRLF-sensitive anchors read their sources through the normalizing reader', () => {
    // The measurement that produced this list: every LF source in the tree was
    // flipped to CRLF and the whole suite re-run. THREE test CASES went red, in
    // TWO files — ticket-idempotency.test.ts has two of them and
    // runtime-grounded-query.test.ts has one. Both counts are stated because an
    // earlier version of this title said "three suites", which is the kind of
    // prose/assertion drift this file exists to catch elsewhere (adversarial
    // review B, MINOR). Pinned by name so a future edit that reintroduces a
    // bare readFileSync is a visible act.
    for (const rel of [
      'tests/cross-workstream/ticket-idempotency.test.ts',
      'tests/cross-workstream/runtime-grounded-query.test.ts',
    ]) {
      const source = readSourceText(rel)
      expect(source, `${rel} still reads sources with a bare readFileSync`).not.toMatch(/readFileSync\(/)
      expect(source).toContain("from '@/tests/helpers/source-text'")
    }
    // And the gate evaluator normalizes its INPUT rather than its files.
    const gates = readSourceText('tests/helpers/stella-project-ticket-gates.ts')
    expect(gates).toMatch(/replace\(\/\\r\\n\/g, '\\n'\)/)
  })

  it('production files are NOT normalized to make a test pass', () => {
    // The helper reads; it never writes. Stated as an assertion because the
    // cheap fix for a CRLF-sensitive test is to rewrite the file it reads, and
    // that moves the evidence instead of reading it.
    const helper = readSourceText('tests/helpers/source-text.ts')
    expect(helper).not.toMatch(/writeFileSync|appendFileSync|rmSync/)
  })
})
