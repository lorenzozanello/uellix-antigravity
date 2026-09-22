// scripts/custody/build-sentinel-consumer.ts
//
// TRANSPILE THE CONSUMER AND ITS IMPORT CLOSURE TO PLAIN COMMONJS, OUTSIDE THE
// REPOSITORY TREE, SO THE DEMONSTRATION CAN RUN IT UNDER BARE `node`.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: A LEAK THE FIRST RUN FOUND
// ---------------------------------------------------------------------------
// The first version of the demonstration ran the consumer through `tsx`. The
// external process observation then showed, among the consuming process's own
// children:
//
//     esbuild.exe (child of the consuming process)
//
// `tsx` starts esbuild as a helper service, and Node's `child_process`
// inherits the parent environment by default — so the delivered variable was
// present in the environment block of a bundler worker that has no business
// holding it. Nothing printed it and nothing logged it, but WCM-C1's scope is
// "the single command that consumes it", and a bundler is not that command.
//
// This is exactly the case RC-7 is written to catch, in its own words: an
// enumeration drawn from reading the consumer's source "cannot see children
// spawned by libraries, tooling hooks or the runtime itself". The consumer's
// source spawns nothing. The runtime underneath it did.
//
// The finding is recorded in the evidence rather than quietly fixed, because
// it generalises: the production invocation must not deliver the real
// credential into a process running under a development runtime either, and a
// future lane that reaches for `tsx` because the demonstration used it would
// reintroduce the leak. Transpiling ahead of time removes it here and makes
// the demonstration's process topology the one a production invocation would
// actually have.
//
// The transpile happens ONCE, BEFORE any deposit, so no build tool is running
// while a value is live.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import ts from 'typescript'

/**
 * Whether a path is inside the repository working tree.
 *
 * Exported and pure so the refusal it backs is testable on any platform,
 * without creating a directory or running a demonstration. Both the harness's
 * `--out-dir` check and the build's own landing check use it, so the two
 * cannot drift into disagreeing about what "outside the tree" means.
 *
 * `relative()` returning an ABSOLUTE path is the Windows case that matters: two
 * paths on different drives have no relative form, and a check that only
 * looked for a leading `..` would call `D:\tmp` inside a tree on `C:`.
 */
export function isInsideRepositoryTree(repoRoot: string, candidate: string): boolean {
  const rel = relative(resolvePath(repoRoot), resolvePath(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The runtime import closure of the consumer, measured rather than guessed.
 *
 * `db/safety/database-target` is absent deliberately: the consumer's dependency
 * on it is `import type`, which transpiles to nothing. A file listed here that
 * contributed no runtime import would be dead weight; one missing that did
 * would fail loudly at require time, which is the right direction for this
 * list to fail in.
 */
const CLOSURE = [
  'scripts/custody/n05-sentinel-consumer.ts',
  'db/safety/resolve-capability-database-url.ts',
  'db/safety/database-role.ts',
  'db/hosted/target-identity.ts',
] as const

/**
 * Transpile the closure into `outDir`, mirroring the repository layout so the
 * relative, extensionless specifiers keep resolving — CommonJS resolves
 * `require('./database-role')` against `database-role.js` without help.
 *
 * Returns the path of the built consumer entry point.
 */
export function buildSentinelConsumer(repoRoot: string, outDir: string): string {
  const buildRoot = join(outDir, 'consumer-build')

  for (const rel of CLOSURE) {
    const source = readFileSync(join(repoRoot, rel), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        // Type-only imports are erased. The consumer's `import type` of
        // EnvironmentSource is why the closure is four files and not five.
        verbatimModuleSyntax: false,
      },
      fileName: rel,
    })
    const destination = join(buildRoot, rel.replace(/\.ts$/, '.js'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, outputText, 'utf8')
  }

  const entry = join(buildRoot, CLOSURE[0].replace(/\.ts$/, '.js'))
  // A build that landed inside the repository tree would defeat the whole
  // point of the out-of-tree requirement, so it is checked rather than assumed.
  if (isInsideRepositoryTree(repoRoot, entry)) {
    throw new Error(`The consumer build landed inside the repository tree at ${entry}.`)
  }
  return entry
}
