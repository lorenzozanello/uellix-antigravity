// tests/postgres/disposable-db.ts
// W2-B2-R1 — the gated REAL-PostgreSQL path for the B2 remediation suite
// (W2_B2_REMEDIATION_AUTHORITY_v1.0.0 R-B2-09 postgres_requirement). B2-AR-B1
// survived to the audit precisely because the committed suite is DB-free and
// no mock can observe a CHECK constraint; this harness exists so that the
// review-status vocabulary, the 0056+ migrations, the registry RLS and the
// rubric constraints are proven against a real instance, repeatably.
//
// SAFETY PROPERTY (structural, inherited from scripts/baseline-rehearsal-local.ts):
// it reaches Postgres ONLY through `docker exec` into a LOCAL supabase_db
// container on this machine, creates databases with a fixed prefix, and drops
// only databases with that prefix. There is no connection string, no hostname
// and therefore no path by which it can reach hosted, staging, production or
// the stack's own `postgres` database.
//
// GATING: opt-in via UELLIX_PG_TESTS=1. Without it every describe is skipped
// and the DB-free suite stays DB-free.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BASELINE_UNITS } from '@/db/hosted/baseline-manifest'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

const ROOT = process.cwd()
const SHIM = path.join(ROOT, 'scripts', 'rehearsal', 'local-supabase-shim.sql')
const PREFIX = 'uellix_rehearsal_pgtest_'

/**
 * G2-ENVIRONMENT PREREQUISITE SHIM — a measured, pre-existing corpus fact,
 * NOT a remediation: db/migrations/0044_fib_audit_hardening_supersession.sql
 * re-installs a no-truncate trigger on public.stella_suggestion_decisions, a
 * table that NO baseline unit creates — it is installed on real targets by
 * the Stella hosted chain (db/prepared/stella_0003_suggestion_decisions.sql),
 * which requires the full uellix_* role topology and a migrator session and
 * cannot run in a bare local stack. A fresh baseline-only provision therefore
 * stops at 0044. This shim creates ONLY that table, mirrored column-for-column
 * from the measured G2 schema (db/baseline/stella_g2_schema.sql:4599-4613,
 * ownership omitted), so the corpus can continue. It is listed here, at the
 * top of the harness, precisely so nobody mistakes a green run for evidence
 * that the baseline corpus provisions from nothing — it does not.
 */
const G2_PREREQUISITE_SHIM = `
CREATE TABLE IF NOT EXISTS public.stella_suggestion_decisions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  interaction_id uuid,
  suggestion_key text NOT NULL,
  decision text NOT NULL,
  previous_value_hash text,
  applied_text text,
  rejection_reason text,
  decided_by uuid NOT NULL,
  decided_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT stella_suggestion_decisions_decision_check CHECK ((decision = ANY (ARRAY['accepted'::text, 'accepted_edited'::text, 'rejected'::text, 'undone'::text]))),
  CONSTRAINT stella_suggestion_decisions_prev_hash_check CHECK (((previous_value_hash IS NULL) OR (previous_value_hash ~ '^[0-9a-f]{64}$'::text)))
);
`

function docker(args: readonly string[], stdin?: string): string {
  return execFileSync('docker', args, { input: stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Same resolution rule as the rehearsal: explicit env, else exactly one running supabase_db. Null => cannot run. */
export function resolveContainer(): string | null {
  let running: string[]
  try {
    running = docker(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'])
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return null
  }
  const explicit = process.env.UELLIX_REHEARSAL_CONTAINER
  if (explicit) return running.includes(explicit) ? explicit : null
  return running.length === 1 ? running[0] : null
}

export interface PgFailure {
  readonly failed: true
  readonly message: string
}

export class DisposableDb {
  readonly name: string

  constructor(readonly container: string, suffix: string) {
    if (!/^[a-z0-9_]+$/.test(suffix)) throw new Error(`bad suffix ${suffix}`)
    this.name = `${PREFIX}${suffix}`
  }

  /**
   * DROP/CREATE the disposable database, apply the shim, then EVERY baseline
   * unit in manifest order. The corpus grants to the cluster role
   * `uellix_app` (0042_fib_audit_insert_policy.sql), which a bare local stack
   * does not have: it is created NOLOGIN if absent — roles are cluster-wide,
   * so this is the one piece of state outside the disposable database, and
   * it is a privilege-less shell in a throwaway local container.
   */
  provision(): void {
    this.admin(`DROP DATABASE IF EXISTS ${this.name}`)
    this.admin(`CREATE DATABASE ${this.name}`)
    this.admin(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN CREATE ROLE uellix_app NOLOGIN; END IF; END $$;`)
    this.psql(readFileSync(SHIM, 'utf8'), false)
    this.psql(G2_PREREQUISITE_SHIM, false)
    for (const unit of BASELINE_UNITS) {
      const sql = readFileSync(path.join(ROOT, unit.file), 'utf8')
      try {
        this.psql(sql, true)
      } catch (error) {
        throw new Error(`baseline unit ${unit.id} failed to apply to ${this.name}: ${describeError(error)}`)
      }
    }
  }

  /** Apply a single SQL file (e.g. a unit not yet in the manifest) in one transaction. */
  applyFile(relativePath: string): void {
    this.psql(readFileSync(path.join(ROOT, relativePath), 'utf8'), true)
  }

  drop(): void {
    if (!this.name.startsWith(PREFIX)) throw new Error(`refusing to drop ${this.name}`)
    this.admin(`DROP DATABASE IF EXISTS ${this.name}`)
  }

  /** Execute SQL that is expected to succeed (single transaction). */
  exec(sql: string): void {
    this.psql(sql, true)
  }

  /** Execute SQL that is EXPECTED to fail; returns the server's error text. Throws if it succeeded. */
  expectError(sql: string): string {
    try {
      this.psql(sql, true)
    } catch (error) {
      return describeError(error)
    }
    throw new Error(`expected the statement to be rejected but it succeeded:\n${sql}`)
  }

  /** Run a query and return rows as arrays of columns (pipe-separated, unaligned, tuples only). */
  query(sql: string): string[][] {
    const out = docker(['exec', '-i', this.container, 'psql', '-U', 'postgres', '-d', this.name, '-v', 'ON_ERROR_STOP=1', '-tAq', '-F', '|', '-c', sql])
    return out.split('\n').map((s) => s.trimEnd()).filter((s) => s.length > 0).map((line) => line.split('|'))
  }

  /** First column of the first row, or null. */
  scalar(sql: string): string | null {
    return this.query(sql)[0]?.[0] ?? null
  }

  private psql(sql: string, singleTransaction: boolean): void {
    const args = ['exec', '-i', this.container, 'psql', '-U', 'postgres', '-d', this.name, '-v', 'ON_ERROR_STOP=1', '-q']
    if (singleTransaction) args.push('-1')
    args.push('-f', '-')
    docker(args, sql)
  }

  private admin(sql: string): void {
    docker(['exec', this.container, 'psql', '-U', 'postgres', '-q', '-c', sql])
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { stderr?: string | Buffer; message?: string }
    const stderr = e.stderr ? String(e.stderr) : ''
    // psql -q still emits NOTICEs on stderr; the ERROR/DETAIL lines are what
    // a caller needs to see first.
    const lines = stderr.split('\n').map((l) => l.trimEnd()).filter(Boolean)
    const significant = lines.filter((l) => !/NOTICE:/.test(l))
    return (significant.length > 0 ? significant : lines).join('\n') || (e.message ?? String(error)).trim()
  }
  return String(error)
}

/**
 * A minimal, FK-complete fixture: one auth user, one app user, one global
 * proxy source, one global financial proxy. Returns the ids. Everything is
 * global (organization_id NULL) so no organization/membership rows are
 * needed. Idempotent per fixture key.
 */
export function seedProxyFixture(db: DisposableDb, key: string): { userId: string; sourceId: string; proxyId: string } {
  const userId = deterministicUuid(`${key}:user`)
  const sourceId = deterministicUuid(`${key}:source`)
  const proxyId = deterministicUuid(`${key}:proxy`)
  db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${userId}', '${key}@pgtest.local') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.users (id, email) VALUES ('${userId}', '${key}@pgtest.local') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.proxy_sources (id, organization_id, name, status, created_by)
      VALUES ('${sourceId}', NULL, 'pgtest source ${key}', 'active', '${userId}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.financial_proxies (id, organization_id, source_id, name, currency, value, unit, reference_year, review_status, created_by)
      VALUES ('${proxyId}', NULL, '${sourceId}', 'pgtest proxy ${key}', 'USD', '100.0000', 'person', 2025, 'suggested', '${userId}') ON CONFLICT (id) DO NOTHING;
  `)
  return { userId, sourceId, proxyId }
}

/** Stable v4-shaped UUID from a label — fixtures are addressable without random ids leaking into assertions. */
export function deterministicUuid(label: string): string {
  let h = 0x811c9dc5
  const hex: string[] = []
  for (let round = 0; round < 4; round += 1) {
    for (const ch of `${label}#${round}`) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    hex.push(h.toString(16).padStart(8, '0'))
  }
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`
}
