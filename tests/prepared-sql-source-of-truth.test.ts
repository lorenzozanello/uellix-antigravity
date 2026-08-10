// tests/prepared-sql-source-of-truth.test.ts
// G2 pre-execution hardening (2026-07-31).
//
// Enforces the safeguards of docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md §6:
// the objects in db/prepared/ are managed OUTSIDE the drizzle chain on purpose,
// and that decision only holds if nothing silently drags them back in.
//
// Fully offline: reads repository files only. No database, no network.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

import { PRECHAIN_REMEDIATION } from '@/db/hosted/prechain-remediation'

const ROOT = process.cwd()
const PREPARED_DIR = path.join(ROOT, 'db', 'prepared')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')

const readRoot = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8')

/**
 * Tables this campaign manages outside the drizzle chain (ADR 21 §4).
 *
 * The last four arrive with the public-capability campaign (stella_0006..0010,
 * design only — nothing applied). They belong on this list for exactly the
 * reason the first two do: if any of them appeared in db/schema.ts, a future
 * `drizzle-kit generate` would emit `CREATE TABLE` without IF NOT EXISTS, which
 * fails against a database where the prepared package already ran. Adding them
 * BEFORE the packages are applied is the point — the guard has to exist before
 * the hazard does, not after someone hits it.
 */
const GATE_MANAGED_TABLES = [
  'stella_suggestion_decisions',
  'evidence_chunks',
  // GR-002 (prepared grounding_0002). Same reason as the rest, and one more:
  // this table is chain of custody, so a `drizzle-kit generate` that decided to
  // drop and recreate it would destroy history rather than an index.
  'evidence_document_versions',
  'report_public_disclosures',
  'capability_verification_hits',
  'stripe_webhook_events',
  'capability_bootstrap_attempts',
] as const

const preparedSqlFiles = readdirSync(PREPARED_DIR).filter((f) => f.endsWith('.sql'))

describe('ADR 21 safeguard 1 — db/prepared is never auto-applied by drizzle', () => {
  it('drizzle.config.ts still points `out` at db/migrations, not db/prepared', () => {
    const config = readRoot('drizzle.config.ts')
    expect(config).toMatch(/out:\s*'\.\/db\/migrations'/)
    expect(config).not.toMatch(/db\/prepared/)
  })

  it('no prepared script is duplicated into db/migrations', () => {
    const migrationFiles = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')))
    for (const file of preparedSqlFiles) {
      expect(migrationFiles.has(file)).toBe(false)
    }
  })

  it('the drizzle journal does not reference any prepared script', () => {
    const journal = readRoot('db', 'migrations', 'meta', '_journal.json')
    for (const file of preparedSqlFiles) {
      expect(journal).not.toContain(file.replace(/\.sql$/, ''))
    }
  })

  it('no migration FILE CONTENT creates or alters a gate-managed table', () => {
    // Comparing file NAMES is not enough: a hand-written db/migrations/0040_x.sql
    // containing `CREATE TABLE "evidence_chunks"` plus a journal entry would slip
    // past every name-based check and then blow up `pnpm db:migrate` against a
    // database where G2 already ran. Grep the contents.
    const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
    expect(migrationFiles.length).toBeGreaterThan(0)
    for (const file of migrationFiles) {
      const content = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      for (const table of GATE_MANAGED_TABLES) {
        expect(content, `${file} references gate-managed table ${table}`).not.toContain(table)
      }
    }
  })

  it('every drizzle config keeps schema/out away from db/prepared', () => {
    // drizzle.local.config.ts declares its own schema/out and must not be a
    // side door back into the drizzle chain.
    const configs = readdirSync(ROOT).filter((f) => /^drizzle.*\.config\.ts$/.test(f))
    expect(configs.length).toBeGreaterThan(0)
    for (const file of configs) {
      const content = readFileSync(path.join(ROOT, file), 'utf8')
      expect(content, `${file} points at db/prepared`).not.toMatch(/db\/prepared/)
    }
  })

  it('no drizzle snapshot knows the gate-managed tables', () => {
    // `drizzle-kit generate` diffs schema.ts against these snapshots. If a
    // gate-managed table appeared here, a future generate could emit DDL that
    // collides with the object G2 already applied.
    const metaDir = path.join(MIGRATIONS_DIR, 'meta')
    const snapshots = readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'))
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      const content = readFileSync(path.join(metaDir, snapshot), 'utf8')
      for (const table of GATE_MANAGED_TABLES) {
        expect(content).not.toContain(table)
      }
    }
  })
})

describe('ADR 21 safeguard 2 — drizzle-kit push must stay unavailable', () => {
  it('package.json declares no db:push script', () => {
    const pkg = JSON.parse(readRoot('package.json')) as { scripts: Record<string, string> }
    const scriptNames = Object.keys(pkg.scripts)
    expect(scriptNames.some((n) => /push/i.test(n))).toBe(false)
    // `push` is the only drizzle command that diffs against the LIVE database
    // and would propose dropping the gate-managed tables. Match `push` anywhere
    // after `drizzle-kit` — flags may sit between them
    // (e.g. `drizzle-kit --config=drizzle.config.ts push`).
    for (const [name, body] of Object.entries(pkg.scripts)) {
      expect(body, `script ${name} invokes drizzle-kit push`).not.toMatch(/drizzle-kit\b[^\n]*\bpush\b/)
    }
  })
})

describe('ADR 21 safeguard 3 — gate-managed tables stay out of db/schema.ts', () => {
  const schema = readRoot('db', 'schema.ts')

  it.each(GATE_MANAGED_TABLES)('db/schema.ts does not declare %s', (table) => {
    // Adding these to schema.ts without following the ADR §7 promotion
    // procedure would make `pnpm db:generate` emit a CREATE TABLE without
    // IF NOT EXISTS — which fails against a database where G2 already ran.
    expect(schema).not.toContain(table)
  })

  it('drizzle-generated migrations create tables WITHOUT IF NOT EXISTS (the reason for §3)', () => {
    // This is the evidence the ADR rests on. If drizzle ever starts emitting
    // idempotent DDL, revisit the decision instead of trusting this comment.
    const generated = readRoot('db', 'migrations', '0000_quick_husk.sql')
    expect(generated).toMatch(/CREATE TABLE "audit_logs"/)
    expect(generated).not.toMatch(/CREATE TABLE IF NOT EXISTS "audit_logs"/)
  })
})

describe('ADR 21 safeguard 4 — db/prepared/README.md is an accurate registry', () => {
  const readme = readFileSync(path.join(PREPARED_DIR, 'README.md'), 'utf8')

  it('lists every prepared .sql file that is not a rollback', () => {
    const forward = preparedSqlFiles.filter((f) => !f.includes('rollback'))
    expect(forward.length).toBeGreaterThan(0)
    for (const file of forward) {
      expect(readme).toContain(file)
    }
  })

  it('lists a rollback for every forward script, and the file exists', () => {
    const forward = preparedSqlFiles.filter((f) => !f.includes('rollback'))
    expect(forward.length).toBeGreaterThan(0)
    for (const file of forward) {
      // "<family>_<NNNN>[<letter>]_<description>.sql"
      //   -> "<family>_<NNNN>[<letter>]_rollback.sql"
      // The optional trailing letter carries follow-up units that harden an
      // already-published script without renumbering it (stella_0002b), so the
      // evidence produced for the original keeps referring to the same name.
      //
      // TRAIN 5B widened <family> from one word to several. `stella_hosted_0001`
      // is a family, not a variant of `stella_0001`: it starts its own sequence
      // because it targets a different privilege model, and folding it into the
      // stella numbering would have implied an ordering between packages that
      // are never applied to the same database. The widening is deliberately
      // narrow — still lowercase words joined by underscores, still one numeric
      // segment, still an optional trailing letter — so a typo like
      // `stella__0001_x.sql` remains unmatched and still fails here.
      // COMMIT 5.2. Exactly ONE exemption, and it is typed rather than
      // spelled here: a FORWARD-ONLY package declares in
      // db/hosted/prechain-remediation.ts why undoing it is not a thing a
      // script can do. Writing the filename into this test instead would make
      // the next exemption a one-line edit nobody has to justify.
      if (file === `${PRECHAIN_REMEDIATION.id}.sql`) {
        expect(PRECHAIN_REMEDIATION.kind).toBe('prechain-remediation')
        expect(PRECHAIN_REMEDIATION.forwardOnlyNoRollbackReason.length).toBeGreaterThan(200)
        expect(
          existsSync(path.join(PREPARED_DIR, 'stella_hosted_0002_rollback.sql')),
          'a forward-only remediation must NOT ship a rollback script',
        ).toBe(false)
        continue
      }

      const match = /^([a-z]+(?:_[a-z]+)*_\d+[a-z]?)_.+\.sql$/.exec(file)
      expect(match, `unexpected prepared script name: ${file}`).not.toBeNull()
      const rollback = `${match![1]}_rollback.sql`
      expect(existsSync(path.join(PREPARED_DIR, rollback)), `missing ${rollback}`).toBe(true)
      expect(readme).toContain(rollback)
    }
  })

  it('names both gate-managed tables and points at the ADR', () => {
    for (const table of GATE_MANAGED_TABLES) {
      expect(readme).toContain(table)
    }
    expect(readme).toContain('21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md')
  })

  it('states that db:migrate:local does not reproduce the gate-managed tables', () => {
    // [\s\S] instead of the `s` (dotAll) flag: the tsconfig target predates ES2018.
    expect(readme).toMatch(/db:migrate:local[\s\S]*no[\s\S]*reproduce/i)
  })

  it('records that the RK-14 follow-ups are NOT part of G2 and stella_0004 does not exist', () => {
    expect(readme).toMatch(/NO forma parte de G2/i)
    expect(readme).toMatch(/todavía no existe/i)
  })

  it('describes each script\'s real search_path (audit N6)', () => {
    // The README is the authoritative registry per ADR §5; a claim it makes
    // about the scripts must actually hold. Read the real SET from each file.
    for (const file of preparedSqlFiles) {
      const sql = readFileSync(path.join(PREPARED_DIR, file), 'utf8')
      const match = /^SET search_path = ([^;]+);/m.exec(sql)
      expect(match, `${file} has no explicit SET search_path`).not.toBeNull()
      const value = match![1].trim()
      // grounding needs `extensions` for the vector type; stella_* do not.
      const expected = file.startsWith('grounding_0001_evidence_chunks')
        ? 'public, extensions'
        : 'public'
      expect(value, `${file} declares search_path = ${value}`).toBe(expected)
    }
    // ...and the README must not claim they are all identical.
    expect(readme).toMatch(/search_path = public, extensions/)
    expect(readme).not.toMatch(/Todos los scripts fijan `SET search_path = public;`/)
  })

  it('documents the lexical-fallback procedure in terms that still exist (audit N1)', () => {
    // The old wording told the operator to remove a `CREATE EXTENSION ...;`
    // statement that no longer exists as such.
    // [\s\S] instead of the `s` (dotAll) flag: the tsconfig target predates ES2018.
    expect(readme).toMatch(/dos[\s\S]*cosas/i)
    expect(readme).toMatch(/BEGIN PGVECTOR SECTION/)
    expect(readme).toMatch(/END PGVECTOR SECTION/)
    expect(readme).toMatch(/embedding vector\(384\),/)
    // ...and those banners must actually exist in the script the README describes
    const grounding = readFileSync(path.join(PREPARED_DIR, 'grounding_0001_evidence_chunks.sql'), 'utf8')
    expect(grounding).toContain('===== BEGIN PGVECTOR SECTION =====')
    expect(grounding).toContain('===== END PGVECTOR SECTION =====')
  })
})

describe('G2 documentation — abort criteria are explicit', () => {
  const g2 = readRoot('docs', 'ops', 'gates', 'G2_PACKAGE.md')
  const addendum = readRoot('docs', 'ops', 'gates', 'G2_PACKAGE_GROUNDING_ADDENDUM.md')

  it('G2_PACKAGE.md has an abort-criteria section', () => {
    expect(g2).toMatch(/##\s*Criterios de aborto/i)
  })

  it.each([
    ['host equivocado', /[Hh]ost equivocado/],
    ['backup no verificable', /[Bb]ackup no verificable/],
    ['migraciones base ausentes', /[Mm]igraciones base ausentes/],
    ['feature flag encendido', /STELLA_DECISIONS_PERSISTENCE_ENABLED/],
    ['forma incompatible', /[Ff]orma incompatible/],
    ['fallo de verificación post-apply', /[Ff]allo de cualquier verificación/],
    ['estado parcial', /[Ee]stado parcial/],
  ])('G2 abort criteria cover %s', (_label, pattern) => {
    expect(g2).toMatch(pattern)
  })

  it('G2 prefers a single transaction over pasting into the SQL editor', () => {
    expect(g2).toMatch(/-1 -v ON_ERROR_STOP=1/)
    expect(g2).toMatch(/Método principal/i)
    expect(g2).toMatch(/Último recurso/i)
  })

  it('the grounding addendum also prefers psql -1 and has its own abort criteria', () => {
    expect(addendum).toMatch(/-1 -v ON_ERROR_STOP=1/)
    expect(addendum).toMatch(/Método principal/i)
    expect(addendum).toMatch(/##\s*Criterios de aborto/i)
  })

  it('the grounding addendum blocks execution on the G5 P3 decision and pgvector', () => {
    expect(addendum).toMatch(/G5 P3/)
    expect(addendum).toMatch(/pgvector/i)
    expect(addendum).toMatch(/[Ee]jecución separada/)
  })
})

describe('Dormant decision-persistence flag', () => {
  it('is fail-closed in config and gated before any DB access in the action', () => {
    const config = readRoot('lib', 'stella', 'config.ts')
    expect(config).toMatch(/isDecisionsPersistenceEnabled:\s*process\.env\.STELLA_DECISIONS_PERSISTENCE_ENABLED === 'true'/)

    const action = readRoot('app', 'actions', 'stella', 'decisions.ts')
    const flagGate = action.indexOf('isDecisionsPersistenceEnabled')
    const firstDbAccess = action.indexOf('db.execute')
    expect(flagGate).toBeGreaterThan(-1)
    expect(firstDbAccess).toBeGreaterThan(-1)
    expect(flagGate).toBeLessThan(firstDbAccess)
  })

  it('is documented in the prepared-SQL registry and the rollback precondition', () => {
    const readme = readFileSync(path.join(PREPARED_DIR, 'README.md'), 'utf8')
    expect(readme).toContain('STELLA_DECISIONS_PERSISTENCE_ENABLED')
    const rollback = readFileSync(path.join(PREPARED_DIR, 'stella_0003_rollback.sql'), 'utf8')
    expect(rollback).toContain('STELLA_DECISIONS_PERSISTENCE_ENABLED')
  })

  // Lorenzo added this manually — the harness deny-list (D-002, which covers
  // `.env*`) blocks this agent from reading or writing that file directly, so
  // it could only be documented as a blocked it.todo until he did.
  it('is documented in .env.example: present once, value exactly false, fail-closed', () => {
    const env = readRoot('.env.example')
    const KEY = 'STELLA_DECISIONS_PERSISTENCE_ENABLED'

    // Present, anchored: no leading/trailing whitespace, no quotes, no other
    // value ('true', '1', 'yes', ...) — only a bare `false` satisfies
    // lib/stella/config.ts's `=== 'true'` fail-closed comparison as intended.
    expect(env).toMatch(new RegExp(`^${KEY}=false$`, 'm'))

    // Exactly one entry — a duplicate (even a second one also set to false)
    // would be confusing drift in a file meant to be copied verbatim.
    const occurrences = env.match(new RegExp(`^${KEY}=`, 'gm')) ?? []
    expect(occurrences).toHaveLength(1)

    // No ambiguous or secret-shaped value anywhere near the key — catches a
    // stray edit that widened the line to `KEY=false  # some real value` or
    // pasted a token instead of the boolean.
    // .replace strips a trailing \r: this repo's tracked files are CRLF.
    const line = env.split('\n').find((l) => l.startsWith(`${KEY}=`))?.replace(/\r$/, '')
    expect(line).toBe(`${KEY}=false`)
    // Check only the VALUE side for an opaque token — the key name itself is
    // 37 chars and would false-positive against a length-based check.
    expect(line?.split('=')[1]).not.toMatch(/[A-Za-z0-9_-]{6,}/)

    // The four required explanatory comments immediately precede the key.
    const idx = env.indexOf(`${KEY}=`)
    const preamble = env.slice(0, idx)
    const commentBlock = preamble.slice(preamble.lastIndexOf('\n\n') + 1)
    expect(commentBlock).toMatch(/false por defecto/i)
    // [\s\S] instead of the `s` (dotAll) flag: the tsconfig target predates ES2018.
    expect(commentBlock).toMatch(/no activar antes[\s\S]*G2[\s\S]*G3/i)
    expect(commentBlock).toMatch(/gate posterior/i)
    expect(commentBlock).toMatch(/no contiene secretos|no es (un )?secreto/i)

    // Production stays fail-closed regardless of what the template says: the
    // template documents a default, but lib/stella/config.ts is what actually
    // enforces it, and only the literal string 'true' flips it on.
    const config = readRoot('lib', 'stella', 'config.ts')
    expect(config).toMatch(/isDecisionsPersistenceEnabled:\s*process\.env\.STELLA_DECISIONS_PERSISTENCE_ENABLED === 'true'/)
  })
})
