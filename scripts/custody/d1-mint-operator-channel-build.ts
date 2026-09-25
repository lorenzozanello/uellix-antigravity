// scripts/custody/d1-mint-operator-channel-build.ts
//
// BUILD THE OPERATOR LAUNCHER, DETERMINISTICALLY, OUTSIDE THE REPOSITORY.
//
// TOOL_BINDING requires the EFFECTIVE launcher to be pinned by sha256 before
// HC-1. What runs is the built CommonJS, so that is what is pinned: the digest
// of the launcher's runtime closure as built here. The build must give the
// same bytes on every host, or a pin written on one machine could never be
// checked on another (CI is Linux; this workstation checks text out with
// core.autocrlf, so its working-tree sources carry CRLF). Hence:
//
//   - every source is read and its CRLF normalized to LF before transpiling;
//   - TypeScript emits with newLine LF;
//   - the digest is sha256 over the sorted "<path>:<sha256 of the emitted
//     bytes>\n" lines of the closure — the same closure rule as the production
//     entry points (relative requires followed, node: builtins skipped, any
//     other require REFUSED).
//
// The pin lives in the execution authority's CHANNEL_BINDING; a test rebuilds
// and compares, so a launcher change without a new pin is RED in CI.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, posix, resolve as resolvePath } from 'node:path'
import ts from 'typescript'
import { requiresOf } from './build-production-entrypoints'
import { isInsideRepositoryTree } from './build-sentinel-consumer'

export const LAUNCHER_ENTRY = 'scripts/custody/d1-mint-operator-launcher.ts'

export function transpileLf(source: string, fileName: string): string {
  return ts.transpileModule(source.replace(/\r\n/g, '\n'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
      newLine: ts.NewLineKind.LineFeed,
    },
    fileName,
  }).outputText
}

export interface LauncherBuild {
  /** Repository-relative .ts path -> emitted CommonJS text. */
  readonly closure: ReadonlyMap<string, string>
  /** Emitted .js path (repository layout) -> sha256 of its bytes. */
  readonly files: Readonly<Record<string, string>>
  readonly digest: string
}

export function buildLauncherClosure(repoRoot: string, read: (abs: string) => string = (abs) => readFileSync(abs, 'utf8')): LauncherBuild {
  const closure = new Map<string, string>()
  const queue = [LAUNCHER_ENTRY]
  while (queue.length > 0) {
    const rel = queue.shift()!
    if (closure.has(rel)) continue
    const text = transpileLf(read(join(repoRoot, rel)), rel)
    closure.set(rel, text)
    for (const spec of requiresOf(text)) {
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) throw new Error(`${rel} requires "${spec}": the launcher may load only node: builtins and relative modules.`)
      queue.push(posix.normalize(posix.join(posix.dirname(rel), `${spec}.ts`)))
    }
  }
  const files: Record<string, string> = {}
  for (const [rel, text] of closure) files[rel.replace(/\.ts$/, '.js')] = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  const digest = createHash('sha256')
    .update(
      Object.keys(files)
        .sort()
        .map((p) => `${p}:${files[p]}\n`)
        .join('')
    )
    .digest('hex')
  return { closure, files, digest }
}

/** Write the build under `<channelDir>/launcher`, refusing a destination inside the repository. Returns the entry path. */
export function writeLauncherBuild(repoRoot: string, channelDir: string, build: LauncherBuild = buildLauncherClosure(repoRoot)): string {
  const root = join(resolvePath(channelDir), 'launcher')
  if (isInsideRepositoryTree(repoRoot, root)) throw new Error('The launcher build must land outside the repository tree.')
  for (const [rel, text] of build.closure) {
    const dest = join(root, normalize(rel.replace(/\.ts$/, '.js')))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, text, 'utf8')
  }
  return join(root, normalize(LAUNCHER_ENTRY.replace(/\.ts$/, '.js')))
}

/** Digest of a launcher build as it lies on disk, for the pre-execution gate (what will actually run). */
export function digestOfWrittenLauncher(channelDir: string, build: LauncherBuild): { digest: string; mismatched: string[] } {
  const root = join(resolvePath(channelDir), 'launcher')
  const files: Record<string, string> = {}
  const mismatched: string[] = []
  for (const rel of Object.keys(build.files)) {
    let h = 'MISSING'
    try {
      h = createHash('sha256').update(readFileSync(join(root, normalize(rel)))).digest('hex')
    } catch {
      /* stays MISSING */
    }
    files[rel] = h
    if (h !== build.files[rel]) mismatched.push(rel)
  }
  const digest = createHash('sha256')
    .update(
      Object.keys(files)
        .sort()
        .map((p) => `${p}:${files[p]}\n`)
        .join('')
    )
    .digest('hex')
  return { digest, mismatched }
}

if (/d1-mint-operator-channel-build\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const b = buildLauncherClosure(process.cwd())
  process.stdout.write(`${JSON.stringify({ launcherDigest: b.digest, files: b.files }, null, 2)}\n`)
}
