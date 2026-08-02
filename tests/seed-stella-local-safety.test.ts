// tests/seed-stella-local-safety.test.ts
// Focused offline test for the G2/G3 local rehearsal seed script
// (scripts/seed-stella-local.ts). Fully static: reads source only, never
// imports the script (importing it would call process.exit and try to open
// a real Postgres connection) and never touches a database.
//
// Verifies the properties the rehearsal worktree depends on: fail-closed
// host validation, deterministic/idempotent inserts, zero real data, and
// zero dependency on environment variables for the connection target.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LOCAL_DATABASE_URL } from '@/db/safety/local-stack'

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'seed-stella-local.ts')
const raw = readFileSync(SCRIPT_PATH, 'utf8')

describe('scripts/seed-stella-local.ts — connection safety', () => {
  it('takes its target from the single pinned local-stack constant', () => {
    // The literal used to be duplicated here. It now comes from
    // db/safety/local-stack.ts, which tests/database-target-safety.test.ts
    // cross-checks against supabase/config.toml — so the loopback guarantee
    // is asserted once, against the real stack config, instead of by grepping
    // a copy of the string in every script.
    expect(raw).toMatch(/const LOCAL_DB_URL = LOCAL_DATABASE_URL/)
    expect(raw).toMatch(/from '\.\.\/db\/safety\/local-stack'/)
    expect(new URL(LOCAL_DATABASE_URL).hostname).toBe('127.0.0.1')
  })

  it('never reads DATABASE_URL or any env var for the connection target', () => {
    // The whole point of this script is that no environment variable can
    // redirect it anywhere. Scan for the two ways that could happen.
    expect(raw).not.toMatch(/process\.env\.DATABASE_URL/)
    expect(raw).not.toMatch(/process\.env\.[A-Z_]*SUPABASE[A-Z_]*URL/)
  })

  it('opens its connection through the central guarded factory, never the driver directly', () => {
    // Previously this script called `postgres(LOCAL_DB_URL)` itself behind a
    // hand-rolled hostname check. That check validated only the hostname — so
    // a loopback URL on ANOTHER local stack's port passed it — and it printed
    // the rejected hostname unredacted.
    expect(raw).not.toMatch(/from 'postgres'/)
    expect(raw).not.toMatch(/postgres\(/)
    expect(raw).toMatch(/createDatabaseClient\(/)
  })

  it('declares the capability AND the expected port, not just a local host', () => {
    expect(raw).toMatch(/capability: 'local_seed'/)
    expect(raw).toMatch(/expectedLocalPort: LOCAL_DB_PORT/)
  })

  it('exits non-zero on refusal, and redacts the error instead of printing it raw', () => {
    expect(raw).toMatch(/process\.exit\(1\)/)
    expect(raw).toMatch(/describeError\(err\)/)
    expect(raw).not.toMatch(/console\.error\(err\)/)
  })
})

describe('scripts/seed-stella-local.ts — precondition on the base seed', () => {
  it('fails loudly instead of creating a parallel organization when the base seed is missing', () => {
    expect(raw).toMatch(/organizacion-a/)
    expect(raw).toMatch(/analyst-a@test\.com/)
    // Both lookups must gate on a synchronous failure — not a silent INSERT
    // of a substitute org/user.
    const orgCheckIdx = raw.indexOf("slug = 'organizacion-a'")
    const orgExitIdx = raw.indexOf('process.exit(1)', orgCheckIdx)
    expect(orgCheckIdx).toBeGreaterThan(-1)
    expect(orgExitIdx).toBeGreaterThan(orgCheckIdx)
  })

  it('never invokes the proxy or taxonomy seed scripts', () => {
    expect(raw).not.toMatch(/seed-proxies/)
    expect(raw).not.toMatch(/seed-taxonomies/)
  })
})

describe('scripts/seed-stella-local.ts — determinism and idempotency', () => {
  it('uses fixed, recognizably-synthetic UUIDs instead of randomUUID()', () => {
    // Match the CALL, not the word — the script's own explanatory comment
    // mentions "randomUUID" in prose ("never a real randomUUID").
    expect(raw).not.toMatch(/randomUUID\(/)
    expect(raw).toMatch(/SYNTHETIC_PROJECT_ID = '00000000-0000-4000-8000-\d+'/)
    expect(raw).toMatch(/SYNTHETIC_INTERACTION_ID = '00000000-0000-4000-8000-\d+'/)
  })

  it('upserts both the project and the interaction (re-runs converge, never duplicate)', () => {
    expect(raw).toMatch(/INSERT INTO public\.projects[\s\S]*?ON CONFLICT \(id\) DO UPDATE SET/)
    expect(raw).toMatch(/INSERT INTO public\.stella_interactions[\s\S]*?ON CONFLICT \(id\) DO UPDATE SET/)
  })

  it('derives context_hash deterministically instead of hardcoding or randomizing it', () => {
    expect(raw).toMatch(/createHash\('sha256'\)\.update\(SYNTHETIC_MARKER\)\.digest\('hex'\)/)
  })
})

describe('scripts/seed-stella-local.ts — zero real data', () => {
  it('marks every synthetic value with an explicit, greppable marker', () => {
    expect(raw).toMatch(/SEED-SYNTHETIC-G2-REHEARSAL/)
    expect(raw).toMatch(/NO REAL/)
  })

  it('sets a recognizable model_used so a synthetic row is never mistaken for a real Gemini call', () => {
    expect(raw).toMatch(/'seed-synthetic'/)
  })

  it('respects the stella_role and risk_level CHECK constraints from db/schema.ts', () => {
    // db/schema.ts: stella_interactions_stella_role_check IN ('advisor',
    // 'validator', 'composer', 'proxy_reviewer', 'evidence_reviewer',
    // 'audit_assistant'); risk_level IS NULL OR IN ('low','medium','high').
    expect(raw).toMatch(/'advisor'/)
    expect(raw).toMatch(/'low'/)
  })
})

describe('package.json — db:seed:stella-local script', () => {
  it('is registered and points at this script', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['db:seed:stella-local']).toBe('tsx scripts/seed-stella-local.ts')
  })
})
