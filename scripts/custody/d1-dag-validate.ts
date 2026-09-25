// scripts/custody/d1-dag-validate.ts
//
//   pnpm custody:dag:validate
//
// RE-DERIVES the D-1 auditor provisioning graph from the authority artifacts
// and prints every number. It hand-authors nothing.
//
// It exists because three separate defects in this package's history were
// arithmetic rather than semantic: a count frozen against a tree that then
// moved (OF-N05-8), a classification step that dropped seven of eighteen files
// and froze 17 as a control's expected value (OF-N05-9), and a reachability
// property first computed from a position in a topological order, which is not
// unique and therefore cannot carry it (the deposit-displacement note in
// v1.0.2's RECOMPUTED_GRAPH).
//
// The lesson each time was the same: a number a document asserts is a number
// nobody re-ran. So this validator re-runs the method, and the amendments cite
// it rather than the other way round.
//
// REACHABILITY IS COMPUTED BY TRAVERSAL, NEVER BY POSITION. A topological
// order is not unique, so "N30 appears after N11" is compatible with there
// being no dependency between them at all. Every reachability claim below is a
// breadth-first sweep over the edge set.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

/**
 * Walk up from the working directory until the release directory appears.
 *
 * `import.meta.url` was the obvious way to do this and it does not survive the
 * test runner, which transforms the module and hands it a non-file URL. The
 * validator has to work from the pnpm script AND from a vitest worker, because
 * the whole point of exporting `deriveGraphFacts` is that a test asserts the
 * amendment's numbers against it.
 */
function findRepositoryRoot(): string {
  let dir = resolvePath(process.cwd())
  for (;;) {
    if (existsSync(join(dir, 'docs', 'ops', 'release'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        `Could not locate docs/ops/release above ${process.cwd()}. Run this from inside the repository.`
      )
    }
    dir = parent
  }
}

const RELEASE_DIR = join(findRepositoryRoot(), 'docs', 'ops', 'release')

/**
 * The base authority and every amendment that changes the graph, in the order
 * they amend. An amendment that adds no NEW_NODES and no NEW_EDGES — v1.0.1 is
 * one — contributes nothing and is listed anyway so its absence from the union
 * is a measured fact rather than an omission.
 */
export const GRAPH_SOURCES = [
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.1.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.2.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.3.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.4.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.6.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.7.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.8.json',
  'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.9.json',
] as const

export type GraphSource = (typeof GRAPH_SOURCES)[number]

const DAG_BASE = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json'
/** Any file that CLAIMS to be part of the lineage by name — an arbitrary JSON elsewhere is never read. */
const LINEAGE_NAME = /^FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY(?:_AMENDMENT)?_v(\d+)\.(\d+)\.(\d+)\.json$/

/**
 * NB-6: the lineage as it is on disk, closed-world. Every file named as part
 * of the lineage is read; an amendment belongs to it only if its body says the
 * same version as its name and amends the base. (package_id is NOT a key: the
 * append-only amendments carry three different spellings of it.) The order is
 * by version. Any file named like the lineage that
 * fails those checks, and any duplicate version, is an error — never skipped.
 * `GRAPH_SOURCES` stays the pinned list the code reads; a lineage on disk that
 * differs from it (an unregistered successor amendment, a missing one) is an
 * error too, so a successor authority can no longer be ignored in silence.
 */
export function deriveGraphLineage(releaseDir: string): { readonly sources: readonly string[]; readonly errors: readonly string[] } {
  const errors: string[] = []
  const found: Array<{ file: string; key: number[] }> = []
  if (!existsSync(join(releaseDir, DAG_BASE))) return { sources: [], errors: [`the lineage base ${DAG_BASE} is missing`] }
  for (const file of readdirSync(releaseDir).sort()) {
    const m = LINEAGE_NAME.exec(file)
    if (m === null) continue
    const version = `${m[1]}.${m[2]}.${m[3]}`
    const isBase = file === DAG_BASE
    let body: { version?: unknown; amends?: unknown }
    try {
      body = JSON.parse(readFileSync(join(releaseDir, file), 'utf8')) as typeof body
    } catch {
      errors.push(`${file} is named as a lineage source and is not JSON`)
      continue
    }
    if (!isBase) {
      if (!file.includes('_AMENDMENT_')) errors.push(`${file} is named like the base but is not the base`)
      if (body.version !== version) errors.push(`${file} declares version ${String(body.version)}, not ${version}`)
      if (body.amends !== `docs/ops/release/${DAG_BASE}`) errors.push(`${file} does not amend the lineage base`)
    }
    const key = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (found.some((f) => f.key.join('.') === key.join('.'))) errors.push(`version ${version} appears more than once in the lineage`)
    found.push({ file, key })
  }
  found.sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.key[2]! - b.key[2]!)
  const sources = found.map((f) => f.file)
  if (sources[0] !== DAG_BASE) errors.push('the lineage does not start at its base')
  if (JSON.stringify(sources) !== JSON.stringify(GRAPH_SOURCES)) {
    errors.push(`the lineage on disk (${sources.join(', ')}) is not the pinned GRAPH_SOURCES`)
  }
  return { sources, errors }
}

/**
 * The sources up to and including `through`, in amendment order. An amendment
 * certifies the graph AS IT STOOD when it was written, so its own test must
 * keep measuring that graph after a later amendment lands; otherwise every
 * append would force an edit of the previous amendment's assertions, which is
 * how an append-only record stops being one.
 */
function sourcesThrough(through: GraphSource | undefined): readonly GraphSource[] {
  if (through === undefined) return GRAPH_SOURCES
  return GRAPH_SOURCES.slice(0, GRAPH_SOURCES.indexOf(through) + 1)
}

interface Node {
  readonly id: string
  readonly plane?: string
  readonly act?: string
  readonly preconditions?: readonly string[]
  readonly source: string
}
interface Edge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly source: string
}

interface RawDoc {
  DAG_NODES?: { nodes?: Array<Record<string, unknown>> }
  DAG_EDGES?: { forward_edges?: Array<Record<string, unknown>> }
  NEW_NODES?: Array<Record<string, unknown>>
  NEW_EDGES?: Array<Record<string, unknown>>
}

function collect(through?: GraphSource): { nodes: Node[]; edges: Edge[]; sourcesRead: string[]; sourcesMissing: string[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const sourcesRead: string[] = []
  const sourcesMissing: string[] = []

  for (const file of sourcesThrough(through)) {
    const path = join(RELEASE_DIR, file)
    if (!existsSync(path)) {
      sourcesMissing.push(file)
      continue
    }
    sourcesRead.push(file)
    const doc = JSON.parse(readFileSync(path, 'utf8')) as RawDoc

    for (const n of [...(doc.DAG_NODES?.nodes ?? []), ...(doc.NEW_NODES ?? [])]) {
      nodes.push({
        id: String(n.id),
        plane: typeof n.plane === 'string' ? n.plane : undefined,
        act: typeof n.act === 'string' ? n.act : undefined,
        preconditions: Array.isArray(n.preconditions) ? (n.preconditions as string[]) : [],
        source: file,
      })
    }
    for (const e of [...(doc.DAG_EDGES?.forward_edges ?? []), ...(doc.NEW_EDGES ?? [])]) {
      edges.push({
        id: String(e.id),
        from: String(e.from),
        to: String(e.to),
        kind: String(e.kind),
        source: file,
      })
    }
  }
  return { nodes, edges, sourcesRead, sourcesMissing }
}

/** Kahn. Returns null when the graph has a cycle, along with the members. */
function topologicalOrder(
  ids: readonly string[],
  edges: readonly Edge[]
): { order: string[] | null; inCycle: string[] } {
  const indegree = new Map<string, number>(ids.map((i) => [i, 0]))
  const out = new Map<string, string[]>(ids.map((i) => [i, []]))
  for (const e of edges) {
    out.get(e.from)?.push(e.to)
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  }
  // Sorted so the linearization is deterministic across runs. It is still only
  // ONE of many valid orders, which is precisely why nothing below is derived
  // from a node's position in it.
  const queue = ids.filter((i) => indegree.get(i) === 0).sort()
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }
  if (order.length === ids.length) return { order, inCycle: [] }
  return { order: null, inCycle: ids.filter((i) => !order.includes(i)).sort() }
}

/** Breadth-first forward sweep. The only way reachability is computed here. */
function reachableFrom(start: string, edges: readonly Edge[]): Set<string> {
  const out = new Map<string, string[]>()
  for (const e of edges) {
    const list = out.get(e.from) ?? []
    list.push(e.to)
    out.set(e.from, list)
  }
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    for (const next of out.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

/** Every node the amendment chain declares, with its plane, act and source. */
export function graphNodes(options: { readonly throughSource?: GraphSource } = {}): ReadonlyArray<{ id: string; plane?: string; act?: string; source: string }> {
  return collect(options.throughSource).nodes
}

/**
 * Every node with a HARD edge into `nodeId`, over the union of all graph
 * sources. Used by the N06 closure check so its predecessor list is read from
 * the graph rather than typed from memory.
 */
export function hardPredecessorsOf(nodeId: string): string[] {
  const { edges } = collect()
  return [...new Set(edges.filter((e) => e.to === nodeId && e.kind === 'HARD').map((e) => e.from))].sort()
}

export interface GraphFacts {
  readonly nodeCount: number
  readonly edgeCount: number
  readonly edgeKindCounts: Readonly<Record<string, number>>
  readonly acyclic: boolean
  readonly topologicalOrder: readonly string[]
  readonly nodeIds: readonly string[]
  readonly duplicateNodeIds: readonly string[]
  readonly duplicateEdgeIds: readonly string[]
  readonly duplicateEdgePairs: readonly string[]
  readonly danglingEndpoints: readonly string[]
  readonly orphans: readonly string[]
  readonly unreachableFromN01: readonly string[]
  readonly sinks: readonly string[]
  readonly missingEdges: readonly string[]
  readonly unexplainedIncoming: readonly string[]
  readonly proseProconditions: readonly string[]
  readonly reachability: Readonly<Record<string, boolean>>
  readonly sourcesRead: readonly string[]
  readonly sourcesMissing: readonly string[]
  readonly failures: readonly string[]
}

/**
 * Derive every graph fact. The CLI prints what this returns; the amendment's
 * RECOMPUTED_GRAPH is asserted against it by
 * `tests/custody/d1-dag-amendment.test.ts`.
 *
 * Separating derivation from printing is what makes "never hand-author a count
 * that can be derived" enforceable rather than aspirational: the amendment's
 * numbers are now checked by a test, so an edited count goes red.
 */
export function deriveGraphFacts(options: { readonly throughSource?: GraphSource } = {}): GraphFacts {
  const { nodes, edges, sourcesRead, sourcesMissing } = collect(options.throughSource)

  const ids = nodes.map((n) => n.id)
  const uniqueIds = Array.from(new Set(ids)).sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1))
  )
  const duplicateNodeIds = ids.filter((id, i) => ids.indexOf(id) !== i)
  const edgeIds = edges.map((e) => e.id)
  const duplicateEdgeIds = edgeIds.filter((id, i) => edgeIds.indexOf(id) !== i)
  const pairs = edges.map((e) => `${e.from}->${e.to}`)
  const duplicateEdgePairs = pairs.filter((p, i) => pairs.indexOf(p) !== i)

  const declared = new Set(uniqueIds)
  const danglingEndpoints = edges
    .filter((e) => !declared.has(e.from) || !declared.has(e.to))
    .map((e) => `${e.id} (${e.from}->${e.to})`)

  const { order, inCycle } = topologicalOrder(uniqueIds, edges)
  const reachable = reachableFrom('N01', edges)
  const unreachable = uniqueIds.filter((i) => !reachable.has(i))
  const hasIncoming = new Set(edges.map((e) => e.to))
  const orphans = uniqueIds.filter((i) => i !== 'N01' && !hasIncoming.has(i))
  const hasOutgoing = new Set(edges.map((e) => e.from))
  const sinks = uniqueIds.filter((i) => !hasOutgoing.has(i))

  // The preconditions each node declares must agree with the set of edges that
  // point at it — but agreement has to be judged against the AMENDED graph,
  // not against a base node object an append-only amendment is forbidden to
  // edit. An amendment that widens a precondition set records the new set in
  // PRECONDITION_SETS_WIDENED_BY_THESE_EDGES, and that declaration is what the
  // comparison uses where it exists.
  //
  // Two distinctions are load-bearing here:
  //
  //   a MISSING EDGE is always a defect. A node that declares N09 as a
  //   precondition with no N09 edge describes a dependency the graph does not
  //   enforce, and the topological order will happily place it wrong.
  //
  //   an UNDECLARED INCOMING EDGE is a defect only when no amendment explains
  //   it. Widening is how this package legitimately tightens the graph, and
  //   flagging every widening would make the validator red on a correct
  //   amendment — which is how a control gets disabled.
  //
  // Preconditions written as prose rather than as node ids are reported
  // separately. N22's "N15 decided SKIP, or N21 passed" and N28's external
  // segment sentence are both prose, and comparing prose to an edge list
  // produces noise, not a finding.
  const widened = new Map<string, Set<string>>()
  for (const file of sourcesRead) {
    const doc = JSON.parse(readFileSync(join(RELEASE_DIR, file), 'utf8')) as Record<string, unknown>
    const section = doc.PRECONDITION_SETS_WIDENED_BY_THESE_EDGES
    if (section === undefined || section === null || typeof section !== 'object') continue
    for (const [nodeId, value] of Object.entries(section as Record<string, unknown>)) {
      if (!/^N\d+$/.test(nodeId)) continue
      const amended = (value as { amended?: unknown }).amended
      if (Array.isArray(amended)) widened.set(nodeId, new Set(amended.map(String)))
    }
  }

  const incoming = new Map<string, Set<string>>(uniqueIds.map((i) => [i, new Set<string>()]))
  for (const e of edges) incoming.get(e.to)?.add(e.from)

  const isNodeId = (s: string): boolean => /^N\d+$/.test(s)
  const missingEdges: string[] = []
  const unexplainedIncoming: string[] = []
  const proseProconditions: string[] = []

  for (const n of nodes) {
    const own = n.preconditions ?? []
    const prose = own.filter((p) => !isNodeId(p))
    if (prose.length > 0) proseProconditions.push(`${n.id}: ${prose.join(' | ')}`)

    // A prose precondition still NAMES its nodes — N22's is "N15 decided SKIP,
    // or N21 passed", which declares both as clearly as a list would. The ids
    // are read out of the prose rather than the prose being compared to an
    // edge list, which would report a representation choice as a defect and
    // teach the next reader to ignore this control.
    const declaredFromProse = prose.flatMap((p) => p.match(/\bN\d+\b/g) ?? [])
    const effective =
      widened.get(n.id) ?? new Set([...own.filter(isNodeId), ...declaredFromProse])
    const fromEdges = incoming.get(n.id) ?? new Set<string>()

    for (const p of effective) if (!fromEdges.has(p)) missingEdges.push(`${n.id} <- ${p}`)
    for (const p of fromEdges) if (!effective.has(p)) unexplainedIncoming.push(`${n.id} <- ${p}`)
  }

  const kinds = new Map<string, number>()
  for (const e of edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)

  // Named reachability properties, each by traversal.
  const properties: Array<[string, boolean]> = [
    ['N05 reachable from N29', reachableFrom('N29', edges).has('N05')],
    ['N23 reachable from N30', reachableFrom('N30', edges).has('N23')],
    ['N30 reachable from N11', reachableFrom('N11', edges).has('N30')],
    ['N06 reachable from N31', reachableFrom('N31', edges).has('N06')],
    ['N06 reachable from N32', reachableFrom('N32', edges).has('N06')],
    ['N32 reachable from N03', reachableFrom('N03', edges).has('N32')],
    ['N10 reachable from N06', reachableFrom('N06', edges).has('N10')],
    // v1.0.4: the first authenticated session consumes what N30 deposited.
    // Checked on every graph, so before v1.0.4 it is honestly false and is
    // only a FAILURE once the amendment that introduces it is in the union.
    ['N13 reachable from N30', reachableFrom('N30', edges).has('N13')],
    // v1.0.5: every in-DAG credential consumer has the N30 entry as a producer.
    ['N14 reachable from N30', reachableFrom('N30', edges).has('N14')],
    ['N21 reachable from N30', reachableFrom('N30', edges).has('N21')],
    ['N22 reachable from N30', reachableFrom('N30', edges).has('N22')],
  ]

  // N28's disconnection is v1.0.0's own declared external segment, disclosed
  // rather than excused: a validator that reported "no orphans" would be false
  // against its own method, and a future lane could not tell a declared
  // discontinuity from a regression.
  const unexpectedOrphans = orphans.filter((o) => o !== 'N28')
  const unexpectedUnreachable = unreachable.filter((u) => u !== 'N28')

  const failures: string[] = []
  if (order === null) failures.push(`graph is cyclic: ${inCycle.join(',')}`)
  if (duplicateNodeIds.length > 0) failures.push('duplicate node ids')
  if (duplicateEdgeIds.length > 0) failures.push('duplicate edge ids')
  if (duplicateEdgePairs.length > 0) failures.push('duplicate edge pairs')
  if (danglingEndpoints.length > 0) failures.push('edges with undeclared endpoints')
  if (unexpectedOrphans.length > 0) {
    failures.push(`unexpected orphans: ${unexpectedOrphans.join(',')}`)
  }
  if (unexpectedUnreachable.length > 0) {
    failures.push(`unexpected unreachable: ${unexpectedUnreachable.join(',')}`)
  }
  if (missingEdges.length > 0) {
    failures.push(`declared preconditions with no edge: ${missingEdges.join(', ')}`)
  }
  if (unexplainedIncoming.length > 0) {
    failures.push(
      `incoming edges neither declared nor recorded as a widening: ${unexplainedIncoming.join(', ')}`
    )
  }
  const introducedBy: Record<string, string> = {
    'N13 reachable from N30': 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.4.json',
    'N14 reachable from N30': 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json',
    'N21 reachable from N30': 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json',
    'N22 reachable from N30': 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v1.0.5.json',
  }
  for (const [label, ok] of properties) {
    const since = introducedBy[label]
    if (!ok && (since === undefined || sourcesRead.includes(since))) failures.push(`reachability lost: ${label}`)
  }

  return {
    nodeCount: uniqueIds.length,
    edgeCount: edges.length,
    edgeKindCounts: Object.fromEntries(kinds),
    acyclic: order !== null,
    topologicalOrder: order ?? [],
    nodeIds: uniqueIds,
    duplicateNodeIds,
    duplicateEdgeIds,
    duplicateEdgePairs,
    danglingEndpoints,
    orphans,
    unreachableFromN01: unreachable,
    sinks,
    missingEdges,
    unexplainedIncoming,
    proseProconditions,
    reachability: Object.fromEntries(properties),
    sourcesRead,
    sourcesMissing,
    failures,
  }
}

function main(): number {
  const f = deriveGraphFacts()

  const w = (label: string, value: unknown): void => {
    process.stdout.write(`  ${label.padEnd(44)} ${String(value)}\n`)
  }

  process.stdout.write('\nD-1 AUDITOR PROVISIONING DAG - RE-DERIVED\n\n')
  w('sources read', f.sourcesRead.length)
  for (const s of f.sourcesRead) process.stdout.write(`      ${s}\n`)
  for (const s of f.sourcesMissing) process.stdout.write(`      MISSING: ${s}\n`)
  process.stdout.write('\n')
  w('NODE_COUNT', f.nodeCount)
  w('EDGE_COUNT', f.edgeCount)
  for (const [kind, n] of Object.entries(f.edgeKindCounts).sort()) w(`  edges of kind ${kind}`, n)
  w('ACYCLIC', f.acyclic)
  w('TOPOLOGICAL_ORDER_LENGTH', f.topologicalOrder.length)
  w('DUPLICATE_NODE_IDS', f.duplicateNodeIds.join(',') || '[]')
  w('DUPLICATE_EDGE_IDS', f.duplicateEdgeIds.join(',') || '[]')
  w('DUPLICATE_EDGE_PAIRS', f.duplicateEdgePairs.join(',') || '[]')
  w('EDGE_ENDPOINTS_NOT_DECLARED', f.danglingEndpoints.join(',') || '[]')
  w('ORPHAN_NODES', f.orphans.join(',') || '[]')
  w('UNREACHABLE_FROM_N01', f.unreachableFromN01.join(',') || '[]')
  w('SINK_NODES', f.sinks.join(','))
  w('DECLARED_PRECONDITION_WITHOUT_EDGE', f.missingEdges.length)
  for (const m of f.missingEdges) process.stdout.write(`      ${m}\n`)
  w('INCOMING_EDGE_NOT_DECLARED_OR_WIDENED', f.unexplainedIncoming.length)
  for (const m of f.unexplainedIncoming) process.stdout.write(`      ${m}\n`)
  w('PROSE_PRECONDITIONS (informational)', f.proseProconditions.length)
  for (const m of f.proseProconditions) process.stdout.write(`      ${m}\n`)
  process.stdout.write('\n  REACHABILITY (by traversal, never by position)\n')
  for (const [label, ok] of Object.entries(f.reachability)) w(`  ${label}`, ok)
  process.stdout.write(
    `\n  TOPOLOGICAL_ORDER  ${f.acyclic ? f.topologicalOrder.join(' ') : 'NONE (cyclic)'}\n\n`
  )

  if (f.failures.length > 0) {
    process.stdout.write('  RESULT  FAIL\n')
    for (const reason of f.failures) process.stdout.write(`    - ${reason}\n`)
    process.stdout.write('\n')
    return 1
  }
  process.stdout.write(
    '  RESULT  PASS (N28 orphan/unreachable is v1.0.0 declared external segment)\n\n'
  )
  return 0
}

/**
 * Run the CLI only when this file IS the entry point.
 *
 * `tests/custody/d1-dag-amendment.test.ts` imports `deriveGraphFacts` from
 * here, and an unguarded call would print the whole report into the test
 * output and set `process.exitCode` from inside a worker.
 */
if ((process.argv[1] ?? '').endsWith('d1-dag-validate.ts')) {
  process.exitCode = main()
}
