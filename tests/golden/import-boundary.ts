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

function isPlaywrightTestSpecifier(expr: ts.Expression | undefined): expr is ts.StringLiteralLike {
  return !!expr && ts.isStringLiteralLike(expr) && expr.text === PLAYWRIGHT_TEST_MODULE
}

/**
 * Every direct reference to `@playwright/test` in one file, across the four
 * syntactic forms a module can be reached through. Returns the empty array
 * for a file with none.
 *
 * Pure — parses the given text, touches no filesystem — so callers can drive
 * it with a fixture as well as a real file, and this module can be unit
 * tested directly rather than only through the guard that consumes it.
 */
export function findPlaywrightTestReferences(file: string, content: string): readonly ImportBoundaryOffense[] {
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS)
  const offenses: ImportBoundaryOffense[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // `ImportClause.isTypeOnly` is deprecated in favour of `phaseModifier`.
      // NOTE: `ts.isTypeOnlyImportDeclaration` is NOT the replacement here —
      // it switches on `ImportClause` / `ImportSpecifier` / `NamespaceImport`
      // / `ImportEqualsDeclaration` and falls through to `false` for an
      // `ImportDeclaration` itself, which would silently defeat this check
      // (every import, type-only or not, would read as non-type-only).
      const isTypeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      if (!isTypeOnly && isPlaywrightTestSpecifier(node.moduleSpecifier as ts.Expression)) {
        offenses.push({ file, kind: 'import', matched: node.getText(sourceFile) })
      }
      return
    }

    if (ts.isExportDeclaration(node)) {
      // `ExportDeclaration.isTypeOnly` is NOT deprecated (only the import-side
      // property is) — used directly rather than through
      // `ts.isTypeOnlyExportDeclaration`, which additionally requires
      // `!exportClause` and so reads `export type { test } from '...'` as
      // NOT type-only (it means something narrower: a bare `export type *`).
      if (!node.isTypeOnly && node.moduleSpecifier && isPlaywrightTestSpecifier(node.moduleSpecifier)) {
        offenses.push({ file, kind: 'export', matched: node.getText(sourceFile) })
      }
      return
    }

    if (ts.isCallExpression(node)) {
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      // A dynamic `import(...)` parses as a CallExpression whose `expression`
      // is the `import` keyword itself, not an identifier named `import`.
      const isDynamicImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword

      if ((isRequireCall || isDynamicImportCall) && isPlaywrightTestSpecifier(node.arguments[0])) {
        offenses.push({
          file,
          kind: isRequireCall ? 'require' : 'dynamic-import',
          matched: node.getText(sourceFile),
        })
      }
      // Fall through — a require()/import() can itself be nested inside an
      // argument list or a template interpolation; keep walking.
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return offenses
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
