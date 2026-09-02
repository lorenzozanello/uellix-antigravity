// tests/helpers/entrypoint-scanner.ts
//
// AST-BASED STRUCTURAL SCANNER for the runtime-cutover entry-point invariant:
//
//     no server code may reach the protected database outside an identity
//     context — however indirectly it reaches it.
//
// The regex scanner in tests/database-runtime-entrypoints.test.ts catches the
// common shapes. The reaudit demonstrated ten shapes that survived it:
//
//    1. a server JSX component that queries during streaming render
//    2. an aliased import         (import { listX as l } … l())
//    3. a namespace import        (import * as svc … svc.listX())
//    4. a dynamic import          (const m = await import(…); m.listX())
//    5. a transitive local helper (const load = () => listX(); … load())
//    6. a re-export barrel        (import { listX } from './barrel')
//    7. a decorative wrapper      (opener called, DB work OUTSIDE its callback)
//    8. a conditional wrapper     (DB work in the branch the opener misses)
//    9. a non-canonical module    (its own `postgres` client, any file name)
//   10. `db` reassigned           (const database = db; database.select())
//
// HOW IT WORKS
//
// 1. Every module in the configured directories is parsed with the TypeScript
//    compiler API and its imports (static, aliased, namespace, dynamic,
//    re-export) are resolved into a module graph.
//
// 2. A global fixed point computes each module's DANGEROUS EXPORTS: the
//    exported names whose own body reaches the database OUTSIDE an approved
//    context-opener call. Purity matters per SYMBOL, not per module — a page
//    importing a pure role-check from a service module is not tainted by the
//    service's other exports.
//
//    * db/client.ts and any module that value-imports a raw driver package
//      ('postgres', 'pg', …) are database ROOTS: every export is dangerous
//      (form 9 — the module's name and location are irrelevant).
//    * A module whose prologue is `'use server'` is an RPC BOUNDARY: its
//      exports never taint an importer, because each export is an entry point
//      this scanner checks in its own right.
//    * A `'use client'` module can open no transaction; never dangerous.
//    * Re-exports forward the dangerous bit unchanged (form 6).
//
// 3. Inside each module, taint propagates per IDENTIFIER: aliases arrive
//    tainted from step 2 (form 2), namespaces carry their module's dangerous
//    set (form 3), `const x = tainted` and destructuring taint x (form 10),
//    a local function whose body contains an UNCOVERED tainted use is itself
//    tainted (form 5), and the variable holding an awaited dynamic import of
//    a dangerous module is tainted (form 4).
//
// 4. A usage — call, tagged template, JSX element (form 1) — is COVERED only
//    when it sits lexically inside an ARGUMENT of an approved opener call.
//    An opener called elsewhere in the file proves nothing (forms 7, 8).
//
// 5. Checked modules are the Next.js entry points by file convention, every
//    module-level 'use server' module, and every non-client module under the
//    checked directories that can reach a database root — i.e. server
//    components are held to the same rule as pages (form 1).
//
// Everything here reads files. No database, no network, no server.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/* -------------------------------------------------------------------------- */
/* Options and result types                                                   */
/* -------------------------------------------------------------------------- */

export interface ScannerOptions {
  /** Absolute root of the tree to scan. */
  readonly root: string
  /** Directories (relative to root) whose modules participate in the graph. */
  readonly scanDirs: readonly string[]
  /** Directories (relative to root) whose server modules are CHECKED. */
  readonly checkedDirs: readonly string[]
  /** Alias prefix (default '@/') resolved against root. */
  readonly aliasPrefix?: string
  /** Approved context-opening call names. */
  readonly contextOpeners: readonly string[]
  /**
   * Relative (posix) paths of the IDENTITY LAYER itself — the modules whose
   * exports resolve and carry the caller's identity (they are the fix, not
   * the risk). Their exports never taint an importer; the layer has its own
   * live test suites (authenticated-database-context, database-runtime-rls).
   */
  readonly contextModulePaths?: readonly string[]
  /** Relative (posix) paths that legitimately open no context, with reasons. */
  readonly allowlist?: Readonly<Record<string, string>>
  /** Relative (posix) path of the canonical database client. */
  readonly databaseClientPath?: string
  /** Bare specifiers whose value import makes a module a database ROOT. */
  readonly driverSpecifiers?: readonly string[]
  /** Directory names never walked. */
  readonly excludeDirNames?: readonly string[]
}

export type UsageForm =
  | 'call'
  | 'namespace-call'
  | 'property-call'
  | 'tagged-template'
  | 'jsx-component'
  | 'dynamic-import'

export interface Finding {
  /** Relative posix path of the offending module. */
  readonly file: string
  /** Region label ("module scope / render path" or the closure's name). */
  readonly region: string
  /** The identifier whose use reaches the database. */
  readonly symbol: string
  /** Which of the detected shapes this usage is. */
  readonly form: UsageForm
  /** 1-based line of the usage. */
  readonly line: number
}

export type ModuleClassification =
  | 'contextualized' // every database usage is inside an opener argument
  | 'allowlisted' // reaches the database, opens nothing, documented
  | 'unguarded' // reaches the database with at least one uncovered usage

export interface ScanResult {
  /** Every checked module that can reach the database, classified. */
  readonly classified: ReadonlyMap<string, ModuleClassification>
  /** Uncovered usages (the failures). Empty for a healthy tree. */
  readonly findings: readonly Finding[]
  /** All checked module paths (relative posix), database-reaching or not. */
  readonly checkedModules: readonly string[]
  /** Checked modules that can reach a database root through the graph. */
  readonly databaseReaching: readonly string[]
}

// A module that value-imports any of these is a database ROOT (form 9),
// whatever its name or location. The list is intentionally broader than what
// this repo uses today (postgres-js): a future switch to another driver must
// not silently create an unscanned query path.
const DEFAULT_DRIVERS = [
  'postgres',
  'pg',
  'pg-promise',
  'mysql',
  'mysql2',
  'drizzle-orm/postgres-js',
  'drizzle-orm/node-postgres',
  'drizzle-orm/neon-http',
  'drizzle-orm/neon-serverless',
  '@neondatabase/serverless',
  '@vercel/postgres',
] as const
const DEFAULT_EXCLUDED_DIRS = ['node_modules', '__tests__', '.next'] as const
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const
const MODULE_REGION = 'module scope / render path'

/** Marker for "every export this module has, named or not". */
const ALL_EXPORTS = '*'

const ENTRY_POINT_PATTERNS = [
  /^page\.tsx?$/,
  /^layout\.tsx?$/,
  /^route\.tsx?$/,
  /^default\.tsx?$/,
  /\.action\.tsx?$/,
  /\.actions\.tsx?$/,
  /^actions\.tsx?$/,
  /^template\.tsx?$/,
  /^not-found\.tsx?$/,
  /^error\.tsx?$/,
  /^sitemap\.tsx?$/,
  /^manifest\.tsx?$/,
  /^robots\.tsx?$/,
  /^opengraph-image\.tsx?$/,
  /^twitter-image\.tsx?$/,
  /^icon\.tsx?$/,
  /^apple-icon\.tsx?$/,
]

/* -------------------------------------------------------------------------- */
/* Module model                                                               */
/* -------------------------------------------------------------------------- */

interface ImportBinding {
  readonly localName: string
  readonly kind: 'named' | 'default' | 'namespace'
  /** The name as exported by the source module ('default' for defaults). */
  readonly importedName: string
  readonly resolved: string | null
  readonly specifier: string
}

interface ReExport {
  readonly resolved: string | null
  /** null = `export * from`; otherwise [exportedAs, importedName][] */
  readonly names: readonly { exportedAs: string; importedName: string }[] | null
}

interface ModuleInfo {
  readonly abs: string
  readonly rel: string
  readonly sourceFile: ts.SourceFile
  readonly isClient: boolean
  readonly isUseServer: boolean
  readonly valueEdges: readonly { specifier: string; resolved: string | null }[]
  readonly bindings: readonly ImportBinding[]
  readonly reExports: readonly ReExport[]
  readonly importsDriver: boolean
}

export class EntrypointScanner {
  private readonly options: Required<
    Pick<
      ScannerOptions,
      | 'aliasPrefix'
      | 'allowlist'
      | 'contextModulePaths'
      | 'databaseClientPath'
      | 'driverSpecifiers'
      | 'excludeDirNames'
    >
  > &
    ScannerOptions

  private readonly modules = new Map<string, ModuleInfo>()
  private readonly reachCache = new Map<string, boolean>()
  private readonly databaseClientAbs: string
  private readonly contextModuleAbs: ReadonlySet<string>
  /** abs path -> set of dangerous export names (may contain ALL_EXPORTS). */
  private dangerous = new Map<string, Set<string>>()
  private dangerousComputed = false

  constructor(options: ScannerOptions) {
    this.options = {
      aliasPrefix: '@/',
      allowlist: {},
      contextModulePaths: [],
      databaseClientPath: 'db/client.ts',
      driverSpecifiers: [...DEFAULT_DRIVERS],
      excludeDirNames: [...DEFAULT_EXCLUDED_DIRS],
      ...options,
    }
    this.databaseClientAbs = path.resolve(this.options.root, this.options.databaseClientPath)
    this.contextModuleAbs = new Set(
      this.options.contextModulePaths.map((relativePath) =>
        path.resolve(this.options.root, relativePath)
      )
    )
    for (const dir of this.options.scanDirs) {
      const absoluteDir = path.join(this.options.root, dir)
      if (existsSync(absoluteDir)) this.loadDirectory(absoluteDir)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Loading and parsing                                                     */
  /* ---------------------------------------------------------------------- */

  private loadDirectory(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (this.options.excludeDirNames.includes(entry)) continue
        this.loadDirectory(full)
      } else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        if (entry.includes('.test.')) continue
        this.loadModule(full)
      }
    }
  }

  private relative(abs: string): string {
    return path.relative(this.options.root, abs).split(path.sep).join('/')
  }

  private resolveSpecifier(fromFile: string, specifier: string): string | null {
    let base: string
    if (specifier.startsWith(this.options.aliasPrefix)) {
      base = path.join(this.options.root, specifier.slice(this.options.aliasPrefix.length))
    } else if (specifier.startsWith('.')) {
      base = path.resolve(path.dirname(fromFile), specifier)
    } else {
      return null // bare specifier: a package
    }
    if (existsSync(base) && statSync(base).isFile()) return base
    for (const extension of EXTENSIONS) {
      if (existsSync(base + extension)) return base + extension
    }
    for (const extension of EXTENSIONS) {
      const indexed = path.join(base, `index${extension}`)
      if (existsSync(indexed)) return indexed
    }
    return null
  }

  private loadModule(abs: string): ModuleInfo {
    const key = path.resolve(abs)
    const existing = this.modules.get(key)
    if (existing) return existing

    const text = readFileSync(key, 'utf8')
    const sourceFile = ts.createSourceFile(
      key,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      key.endsWith('.tsx') || key.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )

    const valueEdges: { specifier: string; resolved: string | null }[] = []
    const bindings: ImportBinding[] = []
    const reExports: ReExport[] = []
    let importsDriver = false

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        const resolved = this.resolveSpecifier(key, specifier)
        if (this.options.driverSpecifiers.includes(specifier)) importsDriver = true
        valueEdges.push({ specifier, resolved })

        if (!clause) continue
        if (clause.name) {
          bindings.push({
            localName: clause.name.text,
            kind: 'default',
            importedName: 'default',
            resolved,
            specifier,
          })
        }
        const named = clause.namedBindings
        if (named && ts.isNamespaceImport(named)) {
          bindings.push({
            localName: named.name.text,
            kind: 'namespace',
            importedName: ALL_EXPORTS,
            resolved,
            specifier,
          })
        }
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue
            bindings.push({
              localName: element.name.text,
              kind: 'named',
              importedName: (element.propertyName ?? element.name).text,
              resolved,
              specifier,
            })
          }
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text
        if (this.options.driverSpecifiers.includes(specifier)) importsDriver = true
        const resolved = this.resolveSpecifier(key, specifier)
        valueEdges.push({ specifier, resolved })
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          reExports.push({
            resolved,
            names: statement.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => ({
                exportedAs: element.name.text,
                importedName: (element.propertyName ?? element.name).text,
              })),
          })
        } else {
          reExports.push({ resolved, names: null }) // export * from
        }
      }
    }

    // Dynamic import() specifiers participate in reachability as value edges.
    const visitDynamic = (node: ts.Node): void => {
      if (isDynamicImportCall(node)) {
        const specifier = (node.arguments[0] as ts.StringLiteralLike).text
        if (this.options.driverSpecifiers.includes(specifier)) importsDriver = true
        valueEdges.push({ specifier, resolved: this.resolveSpecifier(key, specifier) })
      }
      ts.forEachChild(node, visitDynamic)
    }
    visitDynamic(sourceFile)

    const info: ModuleInfo = {
      abs: key,
      rel: this.relative(key),
      sourceFile,
      isClient: hasDirective(sourceFile, 'use client'),
      isUseServer: hasDirective(sourceFile, 'use server'),
      valueEdges,
      bindings,
      reExports,
      importsDriver,
    }
    this.modules.set(key, info)
    return info
  }

  private getModule(abs: string): ModuleInfo | null {
    const key = path.resolve(abs)
    const existing = this.modules.get(key)
    if (existing) return existing
    if (!existsSync(key) || !statSync(key).isFile()) return null
    return this.loadModule(key)
  }

  /* ---------------------------------------------------------------------- */
  /* Graph reachability (for the inventory and checked-module discovery)     */
  /* ---------------------------------------------------------------------- */

  private isDatabaseRoot(info: ModuleInfo): boolean {
    return info.abs === this.databaseClientAbs || info.importsDriver
  }

  /** Can this module reach a database root through value imports? */
  reachesDatabase(abs: string, walking = new Set<string>()): boolean {
    const key = path.resolve(abs)
    const cached = this.reachCache.get(key)
    if (cached !== undefined) return cached
    if (walking.has(key)) return false // back edge: resolved by the outer walk

    const info = this.getModule(key)
    if (!info) {
      const isClientPath = key === this.databaseClientAbs
      this.reachCache.set(key, isClientPath)
      return isClientPath
    }
    if (info.isClient) {
      this.reachCache.set(key, false)
      return false
    }
    if (this.isDatabaseRoot(info)) {
      this.reachCache.set(key, true)
      return true
    }

    walking.add(key)
    let touchedCycle = false
    let reaches = false
    for (const edge of info.valueEdges) {
      if (edge.resolved === null) continue
      if (edge.resolved.includes(`${path.sep}node_modules${path.sep}`)) continue
      const resolvedKey = path.resolve(edge.resolved)
      if (walking.has(resolvedKey)) {
        touchedCycle = true
        continue
      }
      if (this.reachesDatabase(resolvedKey, walking)) {
        reaches = true
        break
      }
      if (this.reachCache.get(resolvedKey) === undefined) touchedCycle = true
    }
    walking.delete(key)

    if (reaches) this.reachCache.set(key, true)
    // Negative results are only cached when no back edge could have hidden a
    // path — a module inside an import cycle must not be recorded permanently.
    else if (!touchedCycle) this.reachCache.set(key, false)
    return reaches
  }

  /* ---------------------------------------------------------------------- */
  /* Dangerous exports — global fixed point                                  */
  /* ---------------------------------------------------------------------- */

  private dangerousExportsOf(abs: string): ReadonlySet<string> {
    return this.dangerous.get(path.resolve(abs)) ?? new Set()
  }

  private hasDangerousExports(abs: string): boolean {
    return this.dangerousExportsOf(abs).size > 0
  }

  private computeDangerousExports(): void {
    if (this.dangerousComputed) return
    this.dangerousComputed = true

    // Seeds: database roots expose only danger.
    for (const info of this.modules.values()) {
      if (!info.isClient && !info.isUseServer && this.isDatabaseRoot(info)) {
        this.dangerous.set(info.abs, new Set([ALL_EXPORTS]))
      }
    }

    // Monotone iteration: dangerous sets only ever grow, so this terminates.
    for (let changed = true; changed; ) {
      changed = false
      for (const info of this.modules.values()) {
        if (info.isClient || info.isUseServer || this.isDatabaseRoot(info)) continue
        const previous = this.dangerous.get(info.abs) ?? new Set<string>()
        const next = this.moduleDangerousExports(info)
        if (next.size > previous.size) {
          this.dangerous.set(info.abs, next)
          changed = true
        }
      }
    }
  }

  private exportIsDangerous(resolved: string | null, importedName: string): boolean {
    if (resolved === null) return false
    if (this.contextModuleAbs.has(path.resolve(resolved))) return false // identity layer
    const info = this.getModule(resolved)
    if (info && (info.isClient || info.isUseServer)) return false // RPC / browser boundary
    const set = this.dangerousExportsOf(resolved)
    if (set.has(ALL_EXPORTS)) return true
    if (importedName === ALL_EXPORTS) return set.size > 0
    return set.has(importedName)
  }

  /** One module's dangerous exports, given the current global state. */
  private moduleDangerousExports(info: ModuleInfo): Set<string> {
    const result = new Set<string>()

    // Re-exports forward the dangerous bit (form 6).
    for (const reExport of info.reExports) {
      if (reExport.resolved === null) continue
      if (reExport.names === null) {
        // export * from: forward every dangerous name.
        for (const name of this.dangerousExportsOf(reExport.resolved)) result.add(name)
        continue
      }
      for (const { exportedAs, importedName } of reExport.names) {
        if (this.exportIsDangerous(reExport.resolved, importedName)) result.add(exportedAs)
      }
    }

    const analysis = this.analyzeModuleInternal(info)

    // An uncovered usage at MODULE SCOPE runs at import time: every export of
    // such a module is dangerous to whoever imports it.
    if (analysis.moduleScopeUncovered) return new Set([ALL_EXPORTS])

    for (const name of analysis.dangerousLocalExports) result.add(name)
    return result
  }

  /* ---------------------------------------------------------------------- */
  /* Per-module analysis                                                     */
  /* ---------------------------------------------------------------------- */

  private analyzeModuleInternal(info: ModuleInfo): {
    findings: Finding[]
    dangerousLocalExports: Set<string>
    moduleScopeUncovered: boolean
  } {
    const empty = { findings: [], dangerousLocalExports: new Set<string>(), moduleScopeUncovered: false }
    if (info.isClient) return empty

    // 1. Seed identifier taint from imports whose SPECIFIC export is dangerous.
    //    (Openers are matched by name, so the context modules cannot self-taint:
    //    lib/auth/session's own exports are the openers themselves.)
    const tainted = new Map<string, { form: UsageForm; module: string | null }>()
    for (const binding of info.bindings) {
      if (binding.resolved === null) continue
      if (this.options.contextOpeners.includes(binding.localName)) continue
      if (!this.exportIsDangerous(binding.resolved, binding.importedName)) continue
      tainted.set(binding.localName, {
        form: binding.kind === 'namespace' ? 'namespace-call' : 'call',
        module: binding.kind === 'namespace' ? binding.resolved : null,
      })
    }

    // Dynamic imports of modules with dangerous exports (form 4).
    const dynamicImportNodes = new Set<ts.CallExpression>()
    const collectDynamic = (node: ts.Node): void => {
      if (isDynamicImportCall(node)) {
        const resolved = this.resolveSpecifier(
          info.abs,
          (node.arguments[0] as ts.StringLiteralLike).text
        )
        if (
          resolved !== null &&
          !this.contextModuleAbs.has(path.resolve(resolved)) &&
          this.hasDangerousExports(resolved)
        ) {
          const target = this.getModule(resolved)
          if (target && !target.isClient && !target.isUseServer) {
            dynamicImportNodes.add(node)
          }
        }
      }
      ts.forEachChild(node, collectDynamic)
    }
    collectDynamic(info.sourceFile)

    if (tainted.size === 0 && dynamicImportNodes.size === 0) return empty

    const isCoveredByOpener = (node: ts.Node): boolean => {
      for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (ts.isCallExpression(current)) {
          const calleeName = calleeIdentifierName(current.expression)
          if (
            calleeName !== null &&
            this.options.contextOpeners.includes(calleeName) &&
            current.arguments.some((argument) => argument === node || isAncestor(argument, node))
          ) {
            return true
          }
        }
      }
      return false
    }

    /** Does this subtree contain an UNCOVERED tainted usage? */
    const hasUncoveredUse = (root: ts.Node): boolean => {
      let found = false
      const visit = (node: ts.Node): void => {
        if (found) return
        if (this.isTaintedUsage(node, tainted, dynamicImportNodes) && !isCoveredByOpener(node)) {
          found = true
          return
        }
        ts.forEachChild(node, visit)
      }
      visit(root)
      return found
    }

    // 2. Propagate taint to local reassignments and helper functions until a
    //    fixed point (forms 5 and 10). A helper only becomes tainted when its
    //    body contains an UNCOVERED use — a helper that opens its own context
    //    (like the stella logStellaAudit pattern) is the fix, not the risk.
    for (let changed = true; changed; ) {
      changed = false
      const propagate = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const names = declaredNames(node.name)
          const init = unwrapExpression(node.initializer)
          const initTainted =
            (ts.isIdentifier(init) && tainted.has(init.text)) ||
            (ts.isPropertyAccessExpression(init) &&
              (() => {
                const base = leftmost(init)
                return ts.isIdentifier(base) && tainted.has(base.text)
              })()) ||
            (ts.isCallExpression(init) && dynamicImportNodes.has(init))
          if (initTainted) {
            const sourceModule =
              ts.isCallExpression(init) && dynamicImportNodes.has(init)
                ? this.resolveSpecifier(info.abs, (init.arguments[0] as ts.StringLiteralLike).text)
                : null
            for (const name of names) {
              if (!tainted.has(name)) {
                tainted.set(name, { form: 'call', module: sourceModule })
                changed = true
              }
            }
          }
          if (
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            names.length === 1 &&
            !tainted.has(names[0]) &&
            !isUseServerFunction(init) &&
            hasUncoveredUse(init)
          ) {
            tainted.set(names[0], { form: 'call', module: null })
            changed = true
          }
        }
        if (
          ts.isFunctionDeclaration(node) &&
          node.name &&
          node.body &&
          !tainted.has(node.name.text) &&
          !isUseServerFunction(node) &&
          hasUncoveredUse(node.body)
        ) {
          tainted.set(node.name.text, { form: 'call', module: null })
          changed = true
        }
        ts.forEachChild(node, propagate)
      }
      propagate(info.sourceFile)
    }

    // 3. Regions: each function-level 'use server' closure is independent.
    const regionRoots: { label: string; node: ts.Node }[] = []
    const useServerNodes = new Set<ts.Node>()
    const findRegions = (node: ts.Node): void => {
      if (isFunctionLike(node) && isUseServerFunction(node)) {
        regionRoots.push({ label: functionLabel(node), node })
        useServerNodes.add(node)
        return
      }
      ts.forEachChild(node, findRegions)
    }
    findRegions(info.sourceFile)

    // 4. Collect UNCOVERED usages per region.
    const findings: Finding[] = []
    const record = (node: ts.Node, region: string, symbol: string, form: UsageForm): void => {
      const { line } = info.sourceFile.getLineAndCharacterOfPosition(node.getStart(info.sourceFile))
      findings.push({ file: info.rel, region, symbol, form, line: line + 1 })
    }

    const inspect = (node: ts.Node, region: string): void => {
      if (useServerNodes.has(node) && region === MODULE_REGION) return
      const usage = this.classifyTaintedUsage(node, tainted, dynamicImportNodes)
      if (usage !== null && !isCoveredByOpener(node)) {
        record(node, region, usage.symbol, usage.form)
      }
      ts.forEachChild(node, (child) => inspect(child, region))
    }

    for (const region of regionRoots) inspect(region.node, region.label)
    inspect(info.sourceFile, MODULE_REGION)

    // 5. Which EXPORTED declarations contain uncovered usage — those are this
    //    module's dangerous exports. Module-scope statements outside any
    //    declaration count as import-time danger.
    const dangerousLocalExports = new Set<string>()
    let moduleScopeUncovered = false
    for (const statement of info.sourceFile.statements) {
      const exported = exportedDeclarationNames(statement)
      if (exported !== null) {
        if (hasUncoveredUse(statement)) {
          for (const name of exported) dangerousLocalExports.add(name)
        }
        continue
      }
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement) &&
        hasUncoveredUse(statement)
      ) {
        // Non-exported module-scope code with uncovered usage. If a
        // non-exported helper is tainted it already flows into the exported
        // declarations that call it via `hasUncoveredUse` there; this branch
        // covers genuine import-time side effects.
        if (!ts.isVariableStatement(statement) && !ts.isFunctionDeclaration(statement)) {
          moduleScopeUncovered = true
        }
      }
    }

    return { findings, dangerousLocalExports, moduleScopeUncovered }
  }

  private isTaintedUsage(
    node: ts.Node,
    tainted: ReadonlyMap<string, { form: UsageForm; module: string | null }>,
    dynamicImportNodes: ReadonlySet<ts.CallExpression>
  ): boolean {
    return this.classifyTaintedUsage(node, tainted, dynamicImportNodes) !== null
  }

  private classifyTaintedUsage(
    node: ts.Node,
    tainted: ReadonlyMap<string, { form: UsageForm; module: string | null }>,
    dynamicImportNodes: ReadonlySet<ts.CallExpression>
  ): { symbol: string; form: UsageForm } | null {
    if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      const callee = unwrapExpression(node.expression)
      if (ts.isIdentifier(callee)) {
        const entry = tainted.get(callee.text)
        if (entry) return { symbol: callee.text, form: 'call' }
        return null
      }
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const base = leftmost(callee)
        if (!ts.isIdentifier(base)) return null
        const entry = tainted.get(base.text)
        if (!entry) return null
        // Namespace / dynamic-module bindings: only the DANGEROUS members of
        // the module count — `svc.pureHelper()` is not a database usage.
        if (entry.module !== null && ts.isPropertyAccessExpression(callee)) {
          const member = callee.name.text
          if (!this.exportIsDangerous(entry.module, member)) return null
        }
        return {
          symbol: base.text,
          form: entry.form === 'namespace-call' ? 'namespace-call' : 'property-call',
        }
      }
      // (await import('…'))\.foo() — inline dynamic import usage.
      if (ts.isCallExpression(callee) && dynamicImportNodes.has(callee)) {
        return { symbol: (callee.arguments[0] as ts.StringLiteralLike).text, form: 'dynamic-import' }
      }
      return null
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const tag = unwrapExpression(node.tag)
      const base = ts.isIdentifier(tag)
        ? tag
        : ts.isPropertyAccessExpression(tag)
          ? leftmost(tag)
          : null
      if (base && ts.isIdentifier(base) && tainted.has(base.text)) {
        return { symbol: base.text, form: 'tagged-template' }
      }
      return null
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName
      if (ts.isIdentifier(tag) && tainted.has(tag.text)) {
        return { symbol: tag.text, form: 'jsx-component' }
      }
      return null
    }

    return null
  }

  /* ---------------------------------------------------------------------- */
  /* Checked-module discovery and whole-tree scan                            */
  /* ---------------------------------------------------------------------- */

  private isUnderCheckedDir(rel: string): boolean {
    return this.options.checkedDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
  }

  private isEntryPointFile(rel: string): boolean {
    const name = path.posix.basename(rel)
    if (ENTRY_POINT_PATTERNS.some((pattern) => pattern.test(name))) return true
    return this.options.checkedDirs.some((dir) => rel.startsWith(`${dir}/actions/`))
  }

  /** Entry points, 'use server' modules and database-reaching server modules. */
  listCheckedModules(): string[] {
    const checked: string[] = []
    for (const info of [...this.modules.values()]) {
      if (info.isClient) continue
      if (info.isUseServer && this.isUnderCheckedDir(info.rel)) {
        checked.push(info.rel)
        continue
      }
      if (!this.isUnderCheckedDir(info.rel)) continue
      if (this.isEntryPointFile(info.rel)) {
        checked.push(info.rel)
      } else if (this.reachesDatabase(info.abs)) {
        // Form 1: a server component shipped under the app/component trees
        // that can reach the database is checked exactly like a page — it
        // runs during render, outside any open context.
        checked.push(info.rel)
      }
    }
    return [...new Set(checked)].sort()
  }

  /** Findings for one module (public, for fixtures and focused assertions). */
  analyzeModule(abs: string): Finding[] {
    this.computeDangerousExports()
    const info = this.getModule(abs)
    if (!info) return []
    return this.analyzeModuleInternal(info).findings
  }

  scan(): ScanResult {
    this.computeDangerousExports()
    const checkedModules = this.listCheckedModules()
    const classified = new Map<string, ModuleClassification>()
    const findings: Finding[] = []
    const databaseReaching: string[] = []

    for (const rel of checkedModules) {
      const abs = path.join(this.options.root, rel)
      if (!this.reachesDatabase(abs)) continue
      databaseReaching.push(rel)
      if (rel in this.options.allowlist) {
        classified.set(rel, 'allowlisted')
        continue
      }
      const moduleFindings = this.analyzeModule(abs)
      if (moduleFindings.length === 0) {
        classified.set(rel, 'contextualized')
      } else {
        classified.set(rel, 'unguarded')
        findings.push(...moduleFindings)
      }
    }

    return { classified, findings, checkedModules, databaseReaching }
  }
}

/* -------------------------------------------------------------------------- */
/* AST helpers                                                                */
/* -------------------------------------------------------------------------- */

function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  )
}

function hasDirective(sourceFile: ts.SourceFile, directive: string): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteralLike(statement.expression)) {
      if (statement.expression.text === directive) return true
      continue // another directive in the prologue
    }
    break
  }
  return false
}

type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

function isUseServerFunction(node: ts.Node): boolean {
  if (!isFunctionLike(node) || !node.body || !ts.isBlock(node.body)) return false
  const first = node.body.statements[0]
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteralLike(first.expression) &&
    first.expression.text === 'use server'
  )
}

function functionLabel(node: FunctionLikeNode): string {
  if (ts.isFunctionDeclaration(node) && node.name) return `${node.name.text}()`
  const parent: ts.Node | undefined = node.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return `${parent.name.text}()`
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return `${parent.name.text}()`
  }
  return `'use server' closure at offset ${node.getStart()}`
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isAwaitExpression(current)) current = current.expression
    else return current
  }
}

function leftmost(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node
  for (;;) {
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression
    } else if (ts.isCallExpression(current)) {
      current = current.expression
    } else if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression
    } else {
      return current
    }
  }
}

function declaredNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...declaredNames(element.name))
  }
  return names
}

/**
 * Names exported by a top-level declaration statement, or null when the
 * statement is not an exported declaration.
 */
function exportedDeclarationNames(statement: ts.Statement): string[] | null {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  if (!isExported) {
    if (ts.isExportAssignment(statement)) return ['default'] // export default <expr>
    return null
  }
  const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (isDefault) return ['default']
    return statement.name ? [statement.name.text] : ['default']
  }
  if (ts.isVariableStatement(statement)) {
    const names: string[] = []
    for (const declaration of statement.declarationList.declarations) {
      names.push(...declaredNames(declaration.name))
    }
    return names
  }
  return null
}

function calleeIdentifierName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) return unwrapped.text
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text
  return null
}

function isAncestor(candidate: ts.Node, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === candidate) return true
  }
  return false
}
