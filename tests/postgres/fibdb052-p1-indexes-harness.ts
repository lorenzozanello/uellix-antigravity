// tests/postgres/fibdb052-p1-indexes-harness.ts
// FIBDB-052 P1 (FIBDB052_P1_EXECUTION_AUTHORITY_v1.0.0.json, HPO-FIBP1-02) —
// setup/probe generator for the CANONICAL disposable PostgreSQL harness
// (scripts/db-audit-disposable.ts, `pnpm db:audit:disposable`). It never opens
// a connection itself. Mirrors tests/postgres/s3refusal-completeness-harness.ts,
// the committed template for this shape.
//
//   pnpm exec tsx tests/postgres/fibdb052-p1-indexes-harness.ts <outDir>
//     writes <outDir>/setup.json  — {statements: string[]}
//        and <outDir>/probes.json — {probes: [{id, sql}]}
//
// SETUP ORDER (statement by statement, each its own psql invocation):
//   1. cluster role topology mirrored from db/baseline/stella_g2_roles.sql;
//   2. scripts/rehearsal/local-supabase-shim.sql (auth/storage minimum);
//   3. the G2 prerequisite shim (stella_suggestion_decisions);
//   4. EVERY db/hosted/baseline-manifest.ts unit in manifest order — which is
//      how 0069_fib_fibdb052_p1_indexes.sql reaches the cluster. It is NEVER
//      spliced in by hand: if the unit were not registered in the manifest,
//      this harness would provision a database without it and every positive
//      probe below would fail. That is deliberate — a green run is therefore
//      also evidence that the unit IS registered in the baseline manifest.
//
// No fixture rows and no hosted-fidelity ACL block are emitted: every probe
// reads the system catalogue (pg_index / pg_class / pg_am / pg_attribute),
// which needs no tenant data and no runtime grant. Adding either would be
// scope this node does not have.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BASELINE_UNITS } from '../../db/hosted/baseline-manifest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const PROBES_TEMPLATE = 'tests/postgres/fibdb052-p1-indexes.probes.json'

const ROLE_PRELUDE = `
-- Cluster roles mirrored from db/baseline/stella_g2_roles.sql (attributes only, no passwords).
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN CREATE ROLE uellix_owner NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN CREATE ROLE uellix_writer NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_auditor') THEN CREATE ROLE uellix_auditor NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_migrator') THEN CREATE ROLE uellix_migrator NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN CREATE ROLE uellix_app NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS; END IF;
END $r$;
GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE;
GRANT uellix_writer TO uellix_app WITH INHERIT TRUE, SET FALSE;
`

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

export interface SetupManifest {
  readonly statements: string[]
}

export function buildSetupManifest(root: string = ROOT): SetupManifest {
  const statements: string[] = []
  statements.push(ROLE_PRELUDE)
  statements.push(readFileSync(path.join(root, 'scripts/rehearsal/local-supabase-shim.sql'), 'utf8'))
  statements.push(G2_PREREQUISITE_SHIM)
  for (const unit of BASELINE_UNITS) {
    statements.push(
      `-- BASELINE UNIT ${unit.ordinal}/${BASELINE_UNITS.length}: ${unit.id}\n` +
        readFileSync(path.join(root, unit.file), 'utf8'),
    )
  }
  return { statements }
}

/** The committed probe template, read verbatim. */
export function resolveProbes(root: string = ROOT): { probes: { id: string; sql: string }[] } {
  return JSON.parse(readFileSync(path.join(root, PROBES_TEMPLATE), 'utf8')) as {
    probes: { id: string; sql: string }[]
  }
}

export function writeManifests(outDir: string, root: string = ROOT): { setupPath: string; probePath: string } {
  mkdirSync(outDir, { recursive: true })
  const setupPath = path.join(outDir, 'setup.json')
  const probePath = path.join(outDir, 'probes.json')
  writeFileSync(setupPath, JSON.stringify(buildSetupManifest(root)), 'utf8')
  writeFileSync(probePath, JSON.stringify(resolveProbes(root), null, 1), 'utf8')
  return { setupPath, probePath }
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  const outDir = process.argv[2]
  if (!outDir) {
    console.error('usage: tsx tests/postgres/fibdb052-p1-indexes-harness.ts <outDir>')
    process.exit(2)
  }
  const { setupPath, probePath } = writeManifests(outDir)
  console.log(`setup:  ${setupPath} (${BASELINE_UNITS.length} baseline units)`)
  console.log(`probes: ${probePath}`)
}
