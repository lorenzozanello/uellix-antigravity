// tests/audit-action-contract.test.ts
// FIBIU-28 (FIBC-040) — "a contract test scans lib/ and app/ and fails on any
// literal action outside the governed union". Static source scan, no DB.
//
// TypeScript already rejects a raw literal at compile time now that
// AuditLogEntry.action is the closed AuditAction union (see pnpm typecheck).
// This test is the second, independent half of that guarantee: a scan that
// keeps working even if a future refactor widens the type again, and that
// gives a readable file:value report instead of a generic tsc diagnostic.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { AUDIT_ACTIONS } from '@/lib/audit/logger'

const SCAN_ROOTS = ['lib', 'app']
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next'])
const TEST_FILE_RE = /\.test\.tsx?$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (/\.tsx?$/.test(entry) && !TEST_FILE_RE.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const GOVERNED_VALUES = new Set<string>(Object.values(AUDIT_ACTIONS))

// action: '...'  or  action: "..."  — a raw string-literal action value.
const ACTION_LITERAL_RE = /\baction\s*:\s*(['"])([a-zA-Z0-9_.]+)\1/g

describe('audit action contract — no raw invalid literal compiles (FIBC-040)', () => {
  it('every raw string-literal action: value in lib/** and app/** belongs to the governed AUDIT_ACTIONS vocabulary', () => {
    const root = process.cwd()
    const violations: { file: string; value: string }[] = []

    for (const rel of SCAN_ROOTS) {
      const dir = path.join(root, rel)
      for (const file of walk(dir)) {
        const source = readFileSync(file, 'utf8')
        // Only inspect files that actually reach the audit contract — avoids
        // matching unrelated `action:` fields elsewhere in the tree (union
        // type declarations, SQL-DDL test helpers, Sentry tags, etc.).
        if (!source.includes('logAuditAction') && !source.includes('recordAuditCorrection')) continue

        let match: RegExpExecArray | null
        ACTION_LITERAL_RE.lastIndex = 0
        while ((match = ACTION_LITERAL_RE.exec(source)) !== null) {
          const value = match[2]
          if (!GOVERNED_VALUES.has(value)) {
            violations.push({ file: path.relative(root, file), value })
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('has at least one governed action value (sanity — the scan is not vacuously passing)', () => {
    expect(GOVERNED_VALUES.size).toBeGreaterThan(50)
  })
})
