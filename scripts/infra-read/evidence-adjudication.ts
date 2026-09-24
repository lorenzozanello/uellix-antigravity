// scripts/infra-read/evidence-adjudication.ts
//
// EC-1 (serialized + decoded-leaf) evidence scan that honours ONLY the
// v1.0.7 same-run adjudication (v1.0.7, LRW-2).
//
// Every written evidence file is scanned at BOTH levels:
//   A. its serialized text, exactly as committed;
//   B. every decoded string leaf and every object key, recursively.
// A finding is EXPLAINED only if ALL hold:
//   * the record is V-R2.S2 and carries a scanner_adjudications entry
//     {projects[*].link.repo, OPAQUE_HIGH_ENTROPY, EXPECTED_PROVIDER_IDENTIFIER}
//     for the project whose link.repo holds the value;
//   * the finding is OPAQUE_HIGH_ENTROPY, at that exact leaf (B) or inside that
//     exact quoted "repo": value (A);
//   * the value trips NO other detector; and
//   * isAdjudicatedValue(value) — in the entry point this is the executor's
//     in-memory SAME-RUN witness set; the standalone pre-commit CLI can only
//     rely on the executor's markers.
// v1.0.9: a V-R2.L7 finding is EXPLAINED only if the record carries its ONE
// deployments[*].meta.githubRepo adjudication naming the team + project its own
// request was scoped to, the finding is OPAQUE_HIGH_ENTROPY at that leaf (B) or
// inside that exact quoted "githubRepo": value (A), the value trips NO other
// detector, and it is exactly the link.repo bound to that SAME team + project
// both by the caller's lookup and by a V-R2.S2 record of the same file set.
// Anything else is UNEXPLAINED and fails the scan. Reports never carry a value.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanText } from './evidence-scan'
import { ADJUDICATION_CLASSIFICATION, GITHUB_REPOSITORY_NAME_RE } from './repo-witness'

export interface Ec1Finding { readonly level: 'SERIALIZED' | 'DECODED'; readonly detector: string; readonly file: string; readonly where: string }
export interface Ec1Report {
  readonly files: number
  readonly stringLeaves: number
  readonly unexplained: readonly Ec1Finding[]
  readonly adjudicatedExplained: number
}

function adjudicatedValuesOf(record: Record<string, unknown>, isAdjudicatedValue: (v: string) => boolean): Set<string> {
  const out = new Set<string>()
  if (record.op_id !== 'V-R2.S2' || !Array.isArray(record.scanner_adjudications)) return out
  const ids = new Set<string>()
  for (const a of record.scanner_adjudications as Record<string, unknown>[]) {
    if (a && a.normalized_schema_path === 'projects[*].link.repo' && a.detector_id === 'OPAQUE_HIGH_ENTROPY' &&
      a.classification === ADJUDICATION_CLASSIFICATION && typeof a.project_id === 'string') ids.add(a.project_id)
  }
  const projects = (record.projection as Record<string, unknown> | undefined)?.projects
  if (!Array.isArray(projects)) return out
  for (const p of projects as Record<string, unknown>[]) {
    const repo = (p?.link as Record<string, unknown> | undefined)?.repo
    if (typeof p?.id === 'string' && ids.has(p.id) && typeof repo === 'string' &&
      GITHUB_REPOSITORY_NAME_RE.test(repo) &&
      scanText(repo).every((f) => f.detector === 'OPAQUE_HIGH_ENTROPY') && isAdjudicatedValue(repo)) out.add(repo)
  }
  return out
}

/** A same-run, same-project lookup: true only for the link.repo the witness adjudicated for THAT team + project. */
export type SameProjectLookup = (teamId: string, projectId: string, value: string) => boolean

/**
 * v1.0.9: the values a V-R2.L7 record may carry at deployments[].meta.githubRepo
 * under its ONE permitted adjudication. The adjudication must name the team +
 * project the record's own request was scoped to, and each value must be inside
 * the grammar, trip only OPAQUE_HIGH_ENTROPY, and be the value the lookup binds
 * to that SAME team + project. Anything else is not allowed at all.
 */
function deploymentRepoValuesOf(record: Record<string, unknown>, sameProject: SameProjectLookup): Set<string> {
  const out = new Set<string>()
  if (record.op_id !== 'V-R2.L7' || !Array.isArray(record.scanner_adjudications) || record.scanner_adjudications.length !== 1) return out
  const a = record.scanner_adjudications[0] as Record<string, unknown> | null
  const endpoint = (record.operation as Record<string, unknown> | undefined)?.endpoint
  if (!a || a.normalized_schema_path !== 'deployments[*].meta.githubRepo' || a.detector_id !== 'OPAQUE_HIGH_ENTROPY' ||
    a.classification !== ADJUDICATION_CLASSIFICATION || a.source_op_id !== 'V-R2.S2' || a.exact_equality !== true ||
    typeof a.team_id !== 'string' || typeof a.project_id !== 'string' || typeof endpoint !== 'string' ||
    !endpoint.startsWith(`/v6/deployments?projectId=${a.project_id}&teamId=${a.team_id}&`)) return out
  const deployments = (record.projection as Record<string, unknown> | undefined)?.deployments
  if (!Array.isArray(deployments)) return out
  for (const d of deployments as Record<string, unknown>[]) {
    const value = (d?.meta as Record<string, unknown> | undefined)?.githubRepo
    if (typeof value === 'string' && GITHUB_REPOSITORY_NAME_RE.test(value) &&
      scanText(value).every((f) => f.detector === 'OPAQUE_HIGH_ENTROPY') && sameProject(a.team_id, a.project_id, value)) out.add(value)
  }
  return out
}

/**
 * v1.0.9: the standalone pre-commit lookup. The in-run witness is gone, so it
 * binds a V-R2.L7 value to the link.repo that a V-R2.S2 record OF THE SAME
 * BUNDLE adjudicated for the same team + project (the S2 page's own request
 * scope names the team). It never accepts a value the bundle does not bind.
 */
export function bundleSameProjectLookup(records: readonly unknown[]): SameProjectLookup {
  const bound = new Map<string, Set<string>>()
  for (const raw of records) {
    const r = raw as Record<string, unknown> | null
    if (!r || r.op_id !== 'V-R2.S2' || !Array.isArray(r.scanner_adjudications)) continue
    const endpoint = (r.operation as Record<string, unknown> | undefined)?.endpoint
    const team = typeof endpoint === 'string' ? /^\/v9\/projects\?teamId=([A-Za-z0-9_-]+)&/.exec(endpoint)?.[1] : undefined
    if (!team) continue
    for (const v of adjudicatedValuesOf(r, () => true)) {
      for (const p of ((r.projection as Record<string, unknown>).projects as Record<string, unknown>[])) {
        if ((p?.link as Record<string, unknown> | undefined)?.repo !== v || typeof p.id !== 'string') continue
        const key = JSON.stringify([team, p.id])
        bound.set(key, (bound.get(key) ?? new Set<string>()).add(v))
      }
    }
  }
  return (teamId, projectId, value) => {
    const s = bound.get(JSON.stringify([teamId, projectId]))
    return s !== undefined && s.size === 1 && s.has(value)
  }
}

/** Every [start, end) region of `<key> <quoted value>` in the serialized text, for an adjudicated value. */
function quotedRegions(text: string, values: Set<string>, jsonKey = '"repo"'): [number, number][] {
  const regions: [number, number][] = []
  for (const v of values) {
    const quoted = JSON.stringify(v)
    for (const key of [`${jsonKey}: `, `${jsonKey}:`]) {
      let i = text.indexOf(key + quoted)
      while (i >= 0) {
        const start = i + key.length
        regions.push([start, start + quoted.length])
        i = text.indexOf(key + quoted, i + 1)
      }
    }
  }
  return regions
}

export function scanEvidenceText(text: string, file: string, isAdjudicatedValue: (v: string) => boolean, sameProject: SameProjectLookup = () => false): Omit<Ec1Report, 'files'> {
  const unexplained: Ec1Finding[] = []
  let explained = 0
  let leaves = 0
  let record: unknown
  try { record = JSON.parse(text) } catch {
    return { stringLeaves: 0, unexplained: [{ level: 'SERIALIZED', detector: 'UNPARSABLE_EVIDENCE', file, where: '$' }], adjudicatedExplained: 0 }
  }
  const allowed = typeof record === 'object' && record !== null ? adjudicatedValuesOf(record as Record<string, unknown>, isAdjudicatedValue) : new Set<string>()
  const deploymentAllowed = typeof record === 'object' && record !== null ? deploymentRepoValuesOf(record as Record<string, unknown>, sameProject) : new Set<string>()
  // A. serialized
  const regions = [...quotedRegions(text, allowed), ...quotedRegions(text, deploymentAllowed, '"githubRepo"')]
  for (const f of scanText(text)) {
    const ok = f.detector === 'OPAQUE_HIGH_ENTROPY' && regions.some(([a, b]) => a <= f.offset && f.offset < b)
    if (ok) explained++
    else unexplained.push({ level: 'SERIALIZED', detector: f.detector, file, where: `@${f.offset}` })
  }
  // B. decoded leaves and keys
  const walk = (v: unknown, generic: string): void => {
    if (typeof v === 'string') {
      leaves++
      for (const f of scanText(v)) {
        const ok = f.detector === 'OPAQUE_HIGH_ENTROPY' && ((generic === 'projection.projects[].link.repo' && allowed.has(v)) ||
          (generic === 'projection.deployments[].meta.githubRepo' && deploymentAllowed.has(v)))
        if (ok) explained++
        else unexplained.push({ level: 'DECODED', detector: f.detector, file, where: generic })
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, `${generic}[]`)
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        for (const f of scanText(k)) unexplained.push({ level: 'DECODED', detector: f.detector, file, where: `${generic}{key}` })
        walk(x, generic === '' ? k : `${generic}.${k}`)
      }
    }
  }
  walk(record, '')
  return { stringLeaves: leaves, unexplained, adjudicatedExplained: explained }
}

/**
 * `sameProject` is the caller's same-project lookup (in-run: the executor's
 * witness binding). v1.0.9: it is always AND-ed with the bundle's own binding,
 * so a V-R2.L7 value is explained only if a V-R2.S2 record of the SAME set
 * adjudicated exactly that value for the same team + project.
 */
export function scanEvidenceFiles(files: readonly string[], isAdjudicatedValue: (v: string) => boolean, sameProject: SameProjectLookup): Ec1Report {
  if (files.length === 0) throw new Error('STOP_EVIDENCE_SCAN_EMPTY_SET: no files to scan')
  let leaves = 0
  let explained = 0
  const unexplained: Ec1Finding[] = []
  const texts = files.map((file) => readFileSync(file, 'utf8'))
  const parsed = texts.map((text) => { try { return JSON.parse(text) as unknown } catch { return undefined } })
  const bundle = bundleSameProjectLookup(parsed)
  const bound: SameProjectLookup = (t, p, v) => bundle(t, p, v) && sameProject(t, p, v)
  for (const [i, file] of files.entries()) {
    const r = scanEvidenceText(texts[i], path.basename(file), isAdjudicatedValue, bound)
    leaves += r.stringLeaves
    explained += r.adjudicatedExplained
    unexplained.push(...r.unexplained)
  }
  return { files: files.length, stringLeaves: leaves, unexplained, adjudicatedExplained: explained }
}

function main(argv: string[]): number {
  let report: Ec1Report
  try {
    // Standalone pre-commit re-scan: the same-run witness is gone, so only the
    // executor's markers can be honoured (see the header). A V-R2.L7 value is
    // still bound to the same bundle's V-R2.S2 adjudication for its project.
    report = scanEvidenceFiles(argv, () => true, () => true)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  for (const f of report.unexplained) console.log(`  ${f.level} ${f.detector} ${f.file} ${f.where}`)
  const ser = report.unexplained.filter((f) => f.level === 'SERIALIZED').length
  const dec = report.unexplained.filter((f) => f.level === 'DECODED').length
  console.log(`EC1_FILES=${report.files} STRING_LEAVES=${report.stringLeaves} ADJUDICATED_EXPLAINED=${report.adjudicatedExplained}`)
  console.log(`EC1_SERIALIZED_SCAN=${ser === 0 ? 'PASS' : 'FAIL'} (${ser} unexplained)`)
  console.log(`EC1_DECODED_LEAF_SCAN=${dec === 0 ? 'PASS' : 'FAIL'} (${dec} unexplained)`)
  return ser + dec === 0 ? 0 : 1
}

const invokedDirectly = typeof process !== 'undefined' && process.argv[1] !== undefined && /evidence-adjudication\.[cm]?[jt]s$/.test(process.argv[1])
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
