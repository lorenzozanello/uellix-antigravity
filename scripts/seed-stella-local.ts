// scripts/seed-stella-local.ts
// Synthetic, deterministic fixtures for the G2/G3 LOCAL REHEARSAL worktree
// (codex/stella-g2-local-rehearsal). Adds exactly what the base local seed
// (scripts/seed-local.ts) does not provide: a project and one Stella
// interaction, so that stella_0002/stella_0003 have something structurally
// realistic to operate on before verification queries are run.
//
// PRECONDITION: `pnpm db:seed:local` must have already run against this same
// local stack — this script looks up 'organizacion-a' / 'analyst-a@test.com'
// by their known seed-local.ts identifiers and fails loudly if they are
// missing, instead of silently creating a parallel synthetic organization.
//
// FAIL-CLOSED: the connection string is a hardcoded literal pointing at this
// worktree's OWN isolated Supabase stack (see supabase/config.toml, [db].port)
// and is validated against an allow-list of local hostnames before any query
// runs. This script deliberately never reads DATABASE_URL or any other env
// var for the connection target — there is nothing an environment variable
// could do to point it at a remote host.
//
// DETERMINISTIC: both rows use fixed, obviously-synthetic UUIDs and are
// upserted (ON CONFLICT ... DO UPDATE), so re-running this script — including
// after a full `pnpm db:reset:local` — always converges to the same state.
//
// ZERO REAL DATA: no real person, organization, email or evidence file is
// referenced anywhere in this script.

import postgres from 'postgres'
import { createHash } from 'node:crypto'

// This worktree's isolated stack only — see docs/ops/LOCAL_STAGING_G2_REHEARSAL.md
// for the full port map and the `docker ps` evidence it was checked against
// before this port was chosen.
const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:56322/postgres'

function assertLocalHost(urlString: string): void {
  let hostname: string
  try {
    hostname = new URL(urlString).hostname
  } catch (err) {
    console.error('CRITICAL DATABASE SAFETY ERROR: could not parse connection URL.')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  const allowedHosts = ['127.0.0.1', 'localhost', '::1']
  if (!allowedHosts.includes(hostname)) {
    console.error('\n================================================================')
    console.error('CRITICAL DATABASE SAFETY ERROR:')
    console.error(`Hostname "${hostname}" is not allowed. Only local connections`)
    console.error(`(${allowedHosts.join(', ')}) are permitted.`)
    console.error('================================================================\n')
    process.exit(1)
  }
}

assertLocalHost(LOCAL_DB_URL)

// Fixed, obviously-synthetic identifiers (recognizable pattern, never a real
// randomUUID) — safe to commit, safe to re-run, trivially greppable in any
// audit of local data.
const SYNTHETIC_PROJECT_ID = '00000000-0000-4000-8000-000000000001'
const SYNTHETIC_INTERACTION_ID = '00000000-0000-4000-8000-000000000002'
const SYNTHETIC_MARKER = 'SEED-SYNTHETIC-G2-REHEARSAL — no real data, no real Gemini call'

// Deterministic 64-char hex "context hash" — matches the varchar(64) NOT NULL
// contract of stella_interactions.context_hash without needing a real
// advisor context to derive it from.
const SYNTHETIC_CONTEXT_HASH = createHash('sha256').update(SYNTHETIC_MARKER).digest('hex')

const SYNTHETIC_RESPONSE_JSON = {
  summary: SYNTHETIC_MARKER,
  requiresHumanReview: true,
  findings: [],
  suggestions: [],
  clarifyingQuestions: [],
  limitations: [SYNTHETIC_MARKER],
}

async function main() {
  const sql = postgres(LOCAL_DB_URL)

  try {
    console.log('Seeding Stella rehearsal fixtures (1 project + 1 interaction)...')

    // Precondition: base seed already ran. Fail loudly, do not create a
    // parallel synthetic organization.
    const [org] = await sql`
      SELECT id FROM public.organizations WHERE slug = 'organizacion-a'
    `
    if (!org) {
      console.error('Missing organization "organizacion-a". Run `pnpm db:seed:local` first.')
      process.exit(1)
    }

    const [user] = await sql`
      SELECT id FROM public.users WHERE email = 'analyst-a@test.com'
    `
    if (!user) {
      console.error('Missing user "analyst-a@test.com". Run `pnpm db:seed:local` first.')
      process.exit(1)
    }

    // Stella needs a non-zero quota to be usable at all; the column defaults
    // to 0 (blocked). Idempotent — safe to set on every run.
    await sql`
      UPDATE public.organizations
      SET stella_monthly_quota = 100
      WHERE id = ${org.id}
    `

    await sql`
      INSERT INTO public.projects (id, organization_id, name, status, created_by)
      VALUES (
        ${SYNTHETIC_PROJECT_ID},
        ${org.id},
        'Proyecto Sintético G2/G3 Rehearsal — NO REAL',
        'active',
        ${user.id}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        status = EXCLUDED.status
    `

    await sql`
      INSERT INTO public.stella_interactions (
        id, organization_id, project_id, created_by,
        stella_role, pipeline_step, context_hash, response_json,
        model_used, tokens_used, risk_level, risk_flags
      )
      VALUES (
        ${SYNTHETIC_INTERACTION_ID},
        ${org.id},
        ${SYNTHETIC_PROJECT_ID},
        ${user.id},
        'advisor',
        'narrative',
        ${SYNTHETIC_CONTEXT_HASH},
        ${sql.json(SYNTHETIC_RESPONSE_JSON)},
        'seed-synthetic',
        0,
        'low',
        '{}'
      )
      ON CONFLICT (id) DO UPDATE SET
        context_hash = EXCLUDED.context_hash,
        response_json = EXCLUDED.response_json
    `

    console.log('Stella rehearsal fixtures ready:', {
      organizationId: org.id,
      userId: user.id,
      projectId: SYNTHETIC_PROJECT_ID,
      interactionId: SYNTHETIC_INTERACTION_ID,
    })
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
