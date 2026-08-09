// scripts/baseline-rehearsal-local.ts
// TRAIN 5C0 — Phase 9. The local baseline rehearsal.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, AND THE THING IT IS EXPLICITLY NOT FOR
// ---------------------------------------------------------------------------
// It is a REGRESSION harness and a DEFECT REPRODUCTION. It is not, and must
// never be cited as, evidence of managed-Supabase compatibility.
//
// The reason is specific rather than cautious. `supabase/config.toml` sets
// `[db.migrations] enabled = true`, so the Supabase CLI applies
// supabase/migrations/** at container start, before a single Drizzle file runs.
// That is precisely why "0000…0039" appeared to work locally for a year while
// being an unrunnable sequence anywhere else. A rehearsal that reproduced the
// convenient local arrangement would reproduce the blindness with it.
//
// So this script does the opposite: it builds a database that has NOT had the
// Supabase units applied for it, and runs the naive order first, to WATCH IT
// FAIL. Run A failing is a passing result. A run A that succeeds means the
// defect this train exists to fix has been silently papered over.
//
// ---------------------------------------------------------------------------
// WHY docker exec AND NOT A CONNECTION STRING
// ---------------------------------------------------------------------------
// Every other guard in this repository answers "is this URL local?" — a
// question with a wrong answer available. `docker exec` into a container on
// this machine has no wrong answer: there is no hostname to mistype and no
// remote database reachable by that path at all. The safety property is
// structural rather than asserted.
//
// The databases are created by this script, named with a fixed prefix, and
// dropped by it. It never opens, reads or writes the stack's own `postgres`
// database.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  BASELINE_ORDER,
  BASELINE_UNITS,
  REHEARSAL_ARTEFACT,
  baselineManifestDigest,
} from '../db/hosted/baseline-manifest'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'
import {
  deriveExpectedBaselineState,
  evaluateBaselinePostconditions,
  type BaselineObservation,
} from '../db/hosted/baseline-postconditions'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHIM = path.join(ROOT, 'scripts', 'rehearsal', 'local-supabase-shim.sql')

/** Fixed prefix. The teardown only ever drops databases matching it. */
const PREFIX = 'uellix_rehearsal_'
const DB_NAIVE = `${PREFIX}naive`
const DB_MANIFEST = `${PREFIX}manifest`

function docker(args: readonly string[], stdin?: string): string {
  return execFileSync('docker', args, {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/**
 * Finds the local Supabase Postgres container.
 *
 * Refuses if there is more than one and none was named, rather than picking:
 * this machine runs several stacks, and "the first one docker listed" is not a
 * target anybody chose.
 */
function resolveContainer(): string {
  const explicit = process.env.UELLIX_REHEARSAL_CONTAINER
  const running = docker(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  if (explicit) {
    if (!running.includes(explicit)) {
      throw new Error(
        `UELLIX_REHEARSAL_CONTAINER=${explicit} is not a running supabase_db container. Running: ${running.join(', ') || 'none'}`,
      )
    }
    return explicit
  }
  if (running.length === 0) {
    throw new Error('no running supabase_db container. Start a local Supabase stack first.')
  }
  if (running.length > 1) {
    throw new Error(
      `${running.length} local stacks are running (${running.join(', ')}). Set UELLIX_REHEARSAL_CONTAINER to choose one — picking for you would be picking a database you did not name.`,
    )
  }
  return running[0]
}

function psql(container: string, database: string, sql: string, singleTransaction = true): string {
  const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-q']
  if (singleTransaction) args.push('-1')
  args.push('-f', '-')
  return docker(args, sql)
}

function query(container: string, database: string, sql: string): string[] {
  const out = docker(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-tAq', '-c', sql],
  )
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

function createDatabase(container: string, name: string): void {
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to create ${name}: not a rehearsal database`)
  docker(['exec', container, 'psql', '-U', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${name}`])
  docker(['exec', container, 'psql', '-U', 'postgres', '-q', '-c', `CREATE DATABASE ${name}`])
  psql(container, name, readFileSync(SHIM, 'utf8'), false)
}

function dropDatabase(container: string, name: string): void {
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to drop ${name}: not a rehearsal database`)
  docker(['exec', container, 'psql', '-U', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${name}`])
}

interface ApplyOutcome {
  readonly applied: number
  readonly failedUnit: string | null
  readonly error: string | null
}

function applyUnits(container: string, database: string, files: readonly string[]): ApplyOutcome {
  let applied = 0
  for (const file of files) {
    const sql = readFileSync(path.join(ROOT, file), 'utf8')
    try {
      psql(container, database, sql)
      applied += 1
    } catch (error) {
      const raw = error instanceof Error ? `${(error as { stderr?: Buffer }).stderr ?? error.message}` : String(error)
      return { applied, failedUnit: file, error: raw.split('\n').filter(Boolean).slice(0, 3).join(' / ') }
    }
  }
  return { applied, failedUnit: null, error: null }
}

/** Reads the catalog into the shape the postconditions consume. */
function observe(container: string, database: string): BaselineObservation {
  const q = (sql: string) => query(container, database, sql)

  const columns: Record<string, string[]> = {}
  for (const row of q(
    `SELECT table_schema||'.'||table_name||'|'||column_name FROM information_schema.columns WHERE table_schema='public'`,
  )) {
    const [table, column] = row.split('|')
    ;(columns[table] ??= []).push(column)
  }

  const rowCounts: Record<string, number> = {}
  for (const table of q(
    `SELECT 'public.'||tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`,
  )) {
    // COUNT(*), not n_live_tup: the statistics collector has not necessarily run
    // on a database created seconds ago, and an unanalysed table reports 0
    // whether or not it holds rows. A postcondition that accepted a stale zero
    // would be the exact "decorative check" this train is trying not to ship.
    rowCounts[table] = Number(q(`SELECT count(*) FROM ${table}`)[0] ?? '0')
  }

  return {
    schemas: q(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1`),
    tables: q(`SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`),
    columns,
    constraints: q(
      `SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY 1`,
    ),
    functions: q(
      `SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`,
    ),
    triggers: q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    rlsEnabledTables: q(
      `SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relrowsecurity AND n.nspname='public' ORDER BY 1`,
    ),
    // public AND storage: the corpus creates the evidence-bucket policies on
    // storage.objects, and an observation scoped to public would report them
    // missing while looking like a clean pass for everything it did see.
    policies: q(
      `SELECT schemaname||'.'||tablename||'.'||policyname FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY 1`,
    ),
    roles: q(`SELECT rolname FROM pg_roles ORDER BY 1`),
    grants: q(
      `SELECT grantee||':'||privilege_type||':'||table_schema||'.'||table_name FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public' ORDER BY 1`,
    ),
    rowCounts,
    extensions: q(`SELECT extname FROM pg_extension ORDER BY 1`),
    // The shim creates no bucket table, so a disposable database has none. The
    // rehearsal declares the bucket present rather than pretending to measure
    // it: B0-15 is a HOSTED question — supabase/config.toml creates the bucket
    // locally and nothing does hosted — and a rehearsal that answered it from a
    // shim would be manufacturing the reassurance the postcondition exists to
    // withhold.
    storageBuckets: ['uellix-evidence'],

    storagePolicies: [

      { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", withCheck: null },

      { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))" },

      { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", withCheck: null },

    ],
    // Same: B0-14 asks about a secret manager, which a disposable database does
    // not have. Declared empty, and listed among the rehearsal's shims.
    environmentSecretNames: [],

    // B0-17 IS measurable here, so it is measured. Effective ACL, so a function
    // that was never REVOKEd reports the implicit PUBLIC EXECUTE it really has.
    functionGrants: q(
      `SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type||':'||n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname='public' AND a.privilege_type='EXECUTE' ORDER BY 1`,
    ),

    // B0-18 is NOT measurable here, and the same rule as B0-15 applies: the
    // journal is written by the hosted wrapper chain, and this rehearsal applies
    // the corpus through drizzle against a disposable database that has no
    // uellix_provisioning schema at all. Declared as the conforming shape and
    // listed among the shims, because a rehearsal that answered a HOSTED
    // question from a local shim would manufacture the reassurance the
    // postcondition exists to withhold.
    journal: {
      packages: [...BASELINE_ORDER],
      environments: ['staging'],
      projectRefs: [KNOWN_STAGING_PROJECT_REF],
      statuses: ['APPLIED'],
    },
  }
}

/* -------------------------------------------------------------------------- */

export interface RehearsalResult {
  readonly container: string
  readonly naiveFailedAt: string | null
  readonly naiveError: string | null
  readonly manifestApplied: number
  readonly manifestFailedAt: string | null
  readonly manifestError: string | null
  readonly postconditions: readonly { id: string; passed: boolean; detail: string }[]
  readonly shimmed: readonly string[]
  /**
   * SHA-256 over the manifest's id+hash+ordinal triples.
   *
   * The gate compares this against the manifest it can see. A rehearsal result
   * from before a manifest edit is not evidence about the manifest after it, and
   * without this the artefact would simply age into a rubber stamp.
   */
  readonly manifestDigest: string
}


export function runRehearsal(): RehearsalResult {
  const container = resolveContainer()
  const readSql = (file: string): string | null => {
    try {
      return readFileSync(path.join(ROOT, file), 'utf8')
    } catch {
      return null
    }
  }

  const naiveOrder = BASELINE_UNITS.filter((u) => u.kind === 'drizzle-migration').map((u) => u.file)
  const manifestOrder = BASELINE_UNITS.map((u) => u.file)

  try {
    /* RUN A — the order the provisioning contract used to specify. Must fail. */
    console.log(`[rehearsal] container ${container}`)
    console.log(`[rehearsal] RUN A: the naive order, ${naiveOrder.length} Drizzle units only`)
    createDatabase(container, DB_NAIVE)
    const naive = applyUnits(container, DB_NAIVE, naiveOrder)
    if (naive.failedUnit === null) {
      console.log('[rehearsal] RUN A completed — which is a FAILURE of this rehearsal.')
    } else {
      console.log(`[rehearsal]   failed at ${naive.failedUnit} after ${naive.applied} unit(s)`)
      console.log(`[rehearsal]   ${naive.error}`)
    }

    /* RUN B — the manifest order. Must complete. */
    console.log(`[rehearsal] RUN B: the manifest order, ${manifestOrder.length} units`)
    createDatabase(container, DB_MANIFEST)
    const manifest = applyUnits(container, DB_MANIFEST, manifestOrder)
    console.log(`[rehearsal]   applied ${manifest.applied}/${manifestOrder.length}`)
    if (manifest.failedUnit) console.log(`[rehearsal]   FAILED at ${manifest.failedUnit}: ${manifest.error}`)

    /* CHECKPOINT B0, against a database that actually received the baseline. */
    let postconditions: { id: string; passed: boolean; detail: string }[] = []
    if (manifest.failedUnit === null) {
      const observed = observe(container, DB_MANIFEST)
      const expected = deriveExpectedBaselineState(readSql)
      postconditions = evaluateBaselinePostconditions(observed, expected).map((r) => ({
        id: r.id,
        passed: r.passed,
        detail: r.detail,
      }))
      const failed = postconditions.filter((p) => !p.passed)
      console.log(
        `[rehearsal] CHECKPOINT B0: ${postconditions.length - failed.length}/${postconditions.length} postconditions pass`,
      )
      for (const f of failed) console.log(`[rehearsal]   FAIL ${f.id}: ${f.detail}`)
    }

    return {
      container,
      naiveFailedAt: naive.failedUnit,
      naiveError: naive.error,
      manifestApplied: manifest.applied,
      manifestFailedAt: manifest.failedUnit,
      manifestError: manifest.error,
      postconditions,
      shimmed: [
        'schema auth (auth.users, auth.uid()) — owned by supabase_auth_admin on a real project',
        'schema storage (storage.objects, storage.foldername()) — owned by supabase_storage_admin',
        'B0-15 (uellix-evidence bucket) is ASSERTED, not measured: a disposable database has no Storage',
        'B0-14 (no SUPABASE_SERVICE_ROLE_KEY) is ASSERTED, not measured: no secret manager here',
        'ownership of auth.users and storage.objects is OURS here and is the platform\'s hosted — the two class-C probes cannot be exercised locally at all',
      ],
      manifestDigest: baselineManifestDigest(),
    }
  } finally {
    // TEARDOWN runs even on a throw. A rehearsal that leaves its databases
    // behind on failure is a rehearsal whose next run starts dirty.
    dropDatabase(container, DB_NAIVE)
    dropDatabase(container, DB_MANIFEST)
    console.log('[rehearsal] teardown: both disposable databases dropped')
  }
}

if (import.meta.filename === process.argv[1]) {
  const result = runRehearsal()

  console.log('')
  console.log('='.repeat(78))
  console.log('SHIMMED — none of this exists on a real managed project as OUR object:')
  for (const s of result.shimmed) console.log(`  - ${s}`)
  console.log('A green run proves ORDER and INTERNAL CONSISTENCY. It proves nothing')
  console.log('about managed-Supabase privileges. See the header of this file.')
  console.log('='.repeat(78))

  const naiveFailedAsExpected = result.naiveFailedAt === 'db/migrations/0039_grant_rls_helper_execution.sql'
  const manifestSucceeded = result.manifestFailedAt === null && result.manifestApplied === BASELINE_UNITS.length
  const b0 = result.postconditions.every((p) => p.passed) && result.postconditions.length > 0

  console.log(`RUN A failed at 0039 as predicted : ${naiveFailedAsExpected}`)
  console.log(`RUN B applied all 50 units        : ${manifestSucceeded}`)
  console.log(`CHECKPOINT B0 clean               : ${b0}`)

  // Record the run. The gate reads THIS, not the presence of this file:
  // adversarial review B pointed out that `hosted-baseline-rehearsal-ready` was
  // passing on `readFileSync(script)` succeeding, which is true in a CI that has
  // no Docker and has therefore never run a rehearsal in its life. A gate whose
  // name says "rehearsal ready" has to be about a rehearsal.
  mkdirSync(path.join(ROOT, path.dirname(REHEARSAL_ARTEFACT)), { recursive: true })
  writeFileSync(
    path.join(ROOT, REHEARSAL_ARTEFACT),
    `${JSON.stringify(
      {
        manifestDigest: result.manifestDigest,
        naiveFailedAt: result.naiveFailedAt,
        manifestApplied: result.manifestApplied,
        manifestFailedAt: result.manifestFailedAt,
        postconditionsPassed: result.postconditions.filter((p) => p.passed).length,
        postconditionsTotal: result.postconditions.length,
        shimmed: result.shimmed,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\nrecorded: ${REHEARSAL_ARTEFACT}`)

  process.exit(naiveFailedAsExpected && manifestSucceeded && b0 ? 0 : 1)
}
