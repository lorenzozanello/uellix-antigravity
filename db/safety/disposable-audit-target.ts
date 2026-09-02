// db/safety/disposable-audit-target.ts
//
// Safety rules specific to ODS-ACCEL-03's disposable-PostgreSQL audit
// harness (scripts/db-audit-disposable.ts).
//
// This module deliberately does NOT go through db/safety/database-access.ts's
// CAPABILITY_POLICIES table: every existing local capability there pins a
// FIXED port declared by the caller and checks `target.port === expectedLocalPort`
// — exactly right for a stable stack like this worktree's Supabase instance,
// but the disposable harness's whole point is a FRESH, Docker-assigned
// ephemeral port on every run. Forcing that into the fixed-port shape would
// only produce a tautological check (comparing the discovered port to
// itself) without adding real protection.
//
// What IS reused, because it is the hard, security-critical part: real
// WHATWG-URL-based classification from db/safety/database-target.ts
// (anti-spoofing for percent-encoded hosts, multihost authorities, leading-
// zero octets, 0.0.0.0, etc.) and db/safety/database-access.ts's
// resolveEnvironment. What is NEW here is small and specific: refuse the
// one fixed port this repo pins as canonical (LOCAL_DB_PORT), and require
// the database name to match a generated, unguessable disposable pattern.

import { classifyDatabaseTarget, isLocalTarget, type DatabaseTarget, type EnvironmentSource } from './database-target'
import { resolveEnvironment } from './database-access'
import { LOCAL_DB_PORT, LOCAL_PROJECT_ID } from './local-stack'

/** `uellix_audit_<32 lowercase hex chars>` — a UUIDv4 with hyphens stripped, since raw hyphens are not safe to embed unquoted in a `CREATE DATABASE` identifier. */
export const DISPOSABLE_DB_NAME_PATTERN = /^uellix_audit_[0-9a-f]{32}$/

export function isDisposableDatabaseName(name: string): boolean {
  return DISPOSABLE_DB_NAME_PATTERN.test(name)
}

/** Generates a fresh, unguessable disposable identity. Never reused across runs — a random UUID per invocation, not a counter or a caller-supplied value. */
export function generateDisposableIdentity(randomUUID: () => string = () => crypto.randomUUID()): { id: string; dbName: string; containerName: string } {
  const id = randomUUID()
  const hex = id.replace(/-/g, '').toLowerCase()
  return { id, dbName: `uellix_audit_${hex}`, containerName: `uellix-audit-${id}` }
}

/** WHATWG-URL-based; never a substring/regex scrape of the raw connection string. Returns null for anything unparseable or with an empty path, which the caller must treat as "no database name asserted" rather than guessing one. */
export function extractDatabaseName(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    const decoded = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    return decoded.length > 0 ? decoded : null
  } catch {
    return null
  }
}

export interface DisposableSafetyCheck {
  readonly ok: boolean
  readonly reason: string | null
  readonly target: DatabaseTarget
}

export interface DisposableSafetyOptions {
  /** Set false only for the pre-CREATE-DATABASE admin connection (targets the server's default maintenance database, not yet the disposable one). Defaults true. */
  requireDisposableDbName?: boolean
  /** When supplied, the parsed database name must equal exactly this — binds the check to the specific identity THIS run generated, not merely "looks disposable". */
  expectDatabaseName?: string
  env?: EnvironmentSource
}

/**
 * Fail-closed gate run BEFORE any mutation against a candidate connection
 * URL. Every branch below is a REFUSAL reason — the only way to reach `ok:
 * true` is to pass every check.
 */
export function assertDisposableTargetSafe(url: string, options: DisposableSafetyOptions = {}): DisposableSafetyCheck {
  const target = classifyDatabaseTarget(url)

  if (!isLocalTarget(target)) {
    return { ok: false, reason: `target kind "${target.kind}" is not a recognised local target (host=${target.redactedHost})`, target }
  }
  if (target.port === null) {
    return { ok: false, reason: 'connection URL has no explicit port — an ambiguous target is refused, never assumed', target }
  }
  if (target.port === LOCAL_DB_PORT) {
    return {
      ok: false,
      reason: `port ${LOCAL_DB_PORT} is this worktree's pinned canonical local stack (project "${LOCAL_PROJECT_ID}") — a disposable harness must never target it`,
      target,
    }
  }

  const environment = resolveEnvironment(options.env ?? process.env)
  if (environment !== 'development' && environment !== 'test' && environment !== 'ci') {
    return { ok: false, reason: `resolved deployment environment "${environment}" is not development/test/ci`, target }
  }

  const requireDisposableDbName = options.requireDisposableDbName ?? true
  if (requireDisposableDbName) {
    const dbName = extractDatabaseName(url)
    if (!dbName || !isDisposableDatabaseName(dbName)) {
      return {
        ok: false,
        reason: `database name "${dbName ?? '(none)'}" does not match the generated disposable pattern — refusing an ambiguous or foreign target`,
        target,
      }
    }
    if (options.expectDatabaseName && dbName !== options.expectDatabaseName) {
      return { ok: false, reason: 'database name does not match the identity generated for this run', target }
    }
  }

  return { ok: true, reason: null, target }
}
