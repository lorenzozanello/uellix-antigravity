// scripts/custody/build-production-entrypoints.ts
//
// TRANSPILE THE SIX PRODUCTION CUSTODY ENTRY POINTS TO PLAIN COMMONJS,
// OUTSIDE THE REPOSITORY TREE, SO EACH RUNS UNDER BARE `node`.
//
//   d1-n30-deposit            N30, the deposit (stdin pipe only)
//   d1-deliver-n13            the launcher: N05's delivery path to one consumer
//   d1-auditor-n13-consumer   N13's consumer
//   d1-auditor-n14-consumer   N14's consumer
//   d1-auditor-n22-consumer   N22's consumer (and N21's, with --node=N21)
//   d1-wcm-remove             the governed removal (N24, N28, compensation)
//
// Why bare node: build-sentinel-consumer.ts records the measured leak — under
// tsx the consumer spawns an esbuild helper that inherits the delivered value.
// The custody inventory therefore requires a production process holding the
// value to run under no development runtime, and that includes the launcher
// and the depositor, not only the consumer.
//
// THE CLOSURE IS DERIVED, NOT LISTED. build-sentinel-consumer.ts keeps a hand
// list and says so. Here each transpiled output is scanned for the require()
// calls TypeScript actually emitted, and the walk follows every relative one.
// Type-only imports emit nothing and are therefore never followed. A require
// of anything that is neither relative nor a `node:` builtin is a REFUSAL:
// the production processes must not depend on node_modules, except the one
// driver the consumer loads lazily, in execute mode, through createRequire
// from an explicit root — which is not a static require and is not followed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, posix } from 'node:path'
import ts from 'typescript'
import { isInsideRepositoryTree } from './build-sentinel-consumer'

export const PRODUCTION_ENTRY_POINTS = [
  'scripts/custody/d1-n30-deposit.ts',
  'scripts/custody/d1-deliver-n13.ts',
  'scripts/custody/d1-auditor-n13-consumer.ts',
  'scripts/custody/d1-wcm-remove.ts',
  'scripts/custody/d1-auditor-n14-consumer.ts',
  'scripts/custody/d1-auditor-n22-consumer.ts',
] as const

export type EntryName = 'deposit' | 'deliver' | 'consumer' | 'remove' | 'consumerN14' | 'consumerN22'

const REQUIRE_RE = /require\("([^"]+)"\)/g

export function transpile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
    fileName,
  }).outputText
}

/** Every static require specifier in a transpiled CommonJS output. */
export function requiresOf(outputText: string): string[] {
  return Array.from(outputText.matchAll(REQUIRE_RE), (m) => m[1])
}

/**
 * The runtime closure of `entries`, as repository-relative .ts paths, with the
 * transpiled text of each. Throws on a non-relative, non-builtin require.
 */
export function deriveClosure(
  repoRoot: string,
  entries: readonly string[],
  read: (abs: string) => string = (abs) => readFileSync(abs, 'utf8')
): Map<string, string> {
  const out = new Map<string, string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const rel = queue.shift()!
    if (out.has(rel)) continue
    const text = transpile(read(join(repoRoot, rel)), rel)
    out.set(rel, text)
    for (const spec of requiresOf(text)) {
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) {
        throw new Error(`${rel} requires "${spec}", which is neither relative nor a node: builtin. Production custody processes may not load node_modules statically.`)
      }
      queue.push(posix.normalize(posix.join(posix.dirname(rel), `${spec}.ts`)))
    }
  }
  return out
}

/** Transpile the closure into `outDir/production-build`, mirroring the repo layout. */
export function buildProductionEntryPoints(repoRoot: string, outDir: string): Record<EntryName, string> {
  const buildRoot = join(outDir, 'production-build')
  const closure = deriveClosure(repoRoot, PRODUCTION_ENTRY_POINTS)
  for (const [rel, text] of closure) {
    const destination = join(buildRoot, normalize(rel.replace(/\.ts$/, '.js')))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, text, 'utf8')
  }
  const at = (rel: string): string => {
    const p = join(buildRoot, normalize(rel.replace(/\.ts$/, '.js')))
    if (isInsideRepositoryTree(repoRoot, p)) throw new Error(`A production entry point landed inside the repository tree at ${p}.`)
    return p
  }
  return {
    deposit: at(PRODUCTION_ENTRY_POINTS[0]),
    deliver: at(PRODUCTION_ENTRY_POINTS[1]),
    consumer: at(PRODUCTION_ENTRY_POINTS[2]),
    remove: at(PRODUCTION_ENTRY_POINTS[3]),
    consumerN14: at(PRODUCTION_ENTRY_POINTS[4]),
    consumerN22: at(PRODUCTION_ENTRY_POINTS[5]),
  }
}
