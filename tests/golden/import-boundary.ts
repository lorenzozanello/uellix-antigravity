// tests/golden/import-boundary.ts
//
// A SYNTAX-AWARE DETECTOR FOR A DIRECT @playwright/test REFERENCE.
//
// ===========================================================================
// THE DEFECT THIS CLOSES (N-2)
// ===========================================================================
// The meta guard used to police the harness.ts import boundary with a single
// regular expression anchored to one quote character:
//
//   /import\s+(?!type\b)[^;]*from\s+'@playwright\/test'/
//
// That is not a closed-world check, it is a check for ONE spelling of the
// violation. `import { test } from "@playwright/test"` (double quotes),
// `require('@playwright/test')`, and `require("@playwright/test")` all
// reference the same module through the same boundary this file exists to
// enforce, and all three evaded the regex silently — a scan that reports zero
// offenders because it never looked at the offending syntax, not because
// there was nothing to find.
//
// A module reference is not a quote spelling. It is `ImportDeclaration`,
// `ExportDeclaration` (a re-export carries the same live binding as an
// import), `require(...)`, and a statically-resolvable dynamic `import(...)`.
// Each of those is a distinct AST shape with a string-literal module
// specifier whose TEXT — not its source spelling — is `@playwright/test`.
// Parsing the file and reading that text is quote-invariant by construction:
// there is no second string form left for a mutation to find.
//
// ===========================================================================
// WHY THE TYPESCRIPT COMPILER API AND NOT A NEW DEPENDENCY
// ===========================================================================
// `typescript` is already a `package.json` dependency — every file in this
// repository is compiled by it. `ts.createSourceFile` gives a real AST without
// adding anything to the dependency graph the ODS scope gate would have to
// authorise.
//
// ===========================================================================
// WHAT IS DELIBERATELY LEFT ALONE
// ===========================================================================
// `import type { Page } from '@playwright/test'` is NOT reported. A type-only
// import erases at compile time and produces no runtime binding to `test`,
// so it cannot run a test outside the guarded harness — the exact failure
// mode this detector exists to catch. The original regex encoded the same
// exemption with `(?!type\b)`; here it is `ts.isTypeOnlyImportDeclaration` /
// `ts.isTypeOnlyExportDeclaration`, read from the AST instead of inferred
// from the token immediately after `import`.

import ts from 'typescript'

const PLAYWRIGHT_TEST_MODULE = '@playwright/test'

export type ImportBoundaryOffenseKind = 'import' | 'export' | 'require' | 'dynamic-import'

export interface ImportBoundaryOffense {
  readonly file: string
  readonly kind: ImportBoundaryOffenseKind
  /** The exact source text of the offending node, so a failure names what was found. */
  readonly matched: string
}

/** One statically-resolvable module reference, whatever module it names. */
export interface ModuleReference {
  readonly kind: ImportBoundaryOffenseKind
  /** The module specifier's TEXT — quote spelling already discarded by the parser. */
  readonly specifier: string
  /** `import type` / `export type`: erased at compile time, so no runtime binding. */
  readonly typeOnly: boolean
  /** The exact source text of the referencing node. */
  readonly text: string
}

/**
 * Raised when the source does not parse.
 *
 * ===========================================================================
 * WHY PARSING FAILS CLOSED (N-4)
 * ===========================================================================
 * `ts.createSourceFile` NEVER throws. Handed `import { from 'x'` it returns a
 * SourceFile whose tree is a best-effort recovery, and a walk over that tree
 * finds whatever the recovery happened to salvage — very possibly nothing.
 * The scan would then report zero references for a file that is simply
 * unreadable, which is the "green because nothing was looked at" shape this
 * whole meta surface exists to make impossible.
 *
 * Malformed source cannot execute today and `pnpm typecheck` would catch it,
 * so this is defence in depth rather than a live hole. It is still wrong for a
 * scanner to answer confidently about text it failed to read, so an
 * unparseable file raises instead of silently answering "nothing here".
 */
export class GoldenSourceParseError extends Error {
  constructor(file: string, readonly diagnosticCount: number, firstMessage: string) {
    super(`${file} does not parse (${diagnosticCount} parse diagnostic(s)); first: ${firstMessage}`)
    this.name = 'GoldenSourceParseError'
  }
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * `parseDiagnostics` is populated by the parser but is not on the public
 * `SourceFile` type, so it is read through a narrow structural cast rather
 * than `any`.
 */
function assertParsed(file: string, sourceFile: ts.SourceFile): void {
  const { parseDiagnostics } = sourceFile as unknown as {
    parseDiagnostics?: readonly ts.Diagnostic[]
  }
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, ' ')
    throw new GoldenSourceParseError(file, parseDiagnostics.length, first)
  }
}

/**
 * EVERY statically-resolvable module reference in one file, across the four
 * syntactic forms a module can be reached through: `import`, re-`export`,
 * `require(...)`, and dynamic `import(...)` with a literal specifier.
 *
 * This is the single AST walk the whole Golden meta surface reads module
 * identity through — both the `@playwright/test` harness boundary (N-2) and
 * the Evaluate production-linkage probe (B-4) are predicates over its result,
 * so neither can drift into matching quote spellings or path substrings.
 *
 * Pure — parses the given text, touches no filesystem — so callers can drive
 * it with a fixture as well as a real file.
 *
 * Throws `GoldenSourceParseError` if the source does not parse; see above.
 */
export function findModuleReferences(file: string, content: string): readonly ModuleReference[] {
  // The script kind is chosen from the EXTENSION, not fixed to TS. Parsing a
  // `.tsx` file as TS turns every JSX element into parse diagnostics, which —
  // now that parsing fails closed — would raise on ordinary, valid React
  // source instead of on the malformed source this is meant to catch.
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(file),
  )
  assertParsed(file, sourceFile)

  const references: ModuleReference[] = []
  const literal = (expr: ts.Expression | undefined): ts.StringLiteralLike | undefined =>
    expr && ts.isStringLiteralLike(expr) ? expr : undefined

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // `ImportClause.isTypeOnly` is deprecated in favour of `phaseModifier`.
      // NOTE: `ts.isTypeOnlyImportDeclaration` is NOT the replacement here —
      // it switches on `ImportClause` / `ImportSpecifier` / `NamespaceImport`
      // / `ImportEqualsDeclaration` and falls through to `false` for an
      // `ImportDeclaration` itself, which would silently defeat this check
      // (every import, type-only or not, would read as non-type-only).
      const specifier = literal(node.moduleSpecifier as ts.Expression)
      if (specifier) {
        references.push({
          kind: 'import',
          specifier: specifier.text,
          typeOnly: node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
          text: node.getText(sourceFile),
        })
      }
      return
    }

    if (ts.isExportDeclaration(node)) {
      // `ExportDeclaration.isTypeOnly` is NOT deprecated (only the import-side
      // property is) — used directly rather than through
      // `ts.isTypeOnlyExportDeclaration`, which additionally requires
      // `!exportClause` and so reads `export type { test } from '...'` as
      // NOT type-only (it means something narrower: a bare `export type *`).
      const specifier = literal(node.moduleSpecifier)
      if (specifier) {
        references.push({
          kind: 'export',
          specifier: specifier.text,
          typeOnly: node.isTypeOnly,
          text: node.getText(sourceFile),
        })
      }
      return
    }

    if (ts.isCallExpression(node)) {
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      // A dynamic `import(...)` parses as a CallExpression whose `expression`
      // is the `import` keyword itself, not an identifier named `import`.
      const isDynamicImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const specifier = isRequireCall || isDynamicImportCall ? literal(node.arguments[0]) : undefined

      if (specifier) {
        references.push({
          kind: isRequireCall ? 'require' : 'dynamic-import',
          specifier: specifier.text,
          // A runtime call cannot be type-only.
          typeOnly: false,
          text: node.getText(sourceFile),
        })
      }
      // Fall through — a require()/import() can itself be nested inside an
      // argument list or a template interpolation; keep walking.
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

/**
 * Every direct reference to `@playwright/test` in one file. Returns the empty
 * array for a file with none.
 */
export function findPlaywrightTestReferences(file: string, content: string): readonly ImportBoundaryOffense[] {
  return findModuleReferences(file, content)
    .filter((reference) => !reference.typeOnly && reference.specifier === PLAYWRIGHT_TEST_MODULE)
    .map((reference) => ({ file, kind: reference.kind, matched: reference.text }))
}

/**
 * Scan (path, content) pairs, mirroring `scanForBypasses`'s shape so the meta
 * guard can compose them the same way.
 */
export function scanForPlaywrightTestImportOffenses(
  files: ReadonlyArray<readonly [string, string]>,
): readonly ImportBoundaryOffense[] {
  const offenses: ImportBoundaryOffense[] = []
  for (const [file, content] of files) {
    offenses.push(...findPlaywrightTestReferences(file, content))
  }
  return offenses
}
