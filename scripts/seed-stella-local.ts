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

import { createHash } from 'node:crypto'
import { createDatabaseClient } from '../db/client'
import { LOCAL_DATABASE_URL, LOCAL_DB_PORT } from '../db/safety/local-stack'
import { describeError } from '../db/safety/redact-error'

// This worktree's isolated stack only. The literal used to live here; it now
// comes from db/safety/local-stack.ts, the single source of truth that
// tests/database-target-safety.test.ts cross-checks against
// supabase/config.toml. See docs/ops/LOCAL_STAGING_G2_REHEARSAL.md for the
// full port map and the `docker ps` evidence the port was checked against.
const LOCAL_DB_URL = LOCAL_DATABASE_URL

// The hand-rolled `assertLocalHost` that used to live here was removed. It
// validated only the hostname — so a loopback URL on another local stack's
// port passed it — and it printed the rejected hostname unredacted. Both are
// now handled by the central guard inside `createDatabaseClient`, which is
// the ONLY place in the repository that constructs a driver.

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

/**
 * TRAIN 4.3 — the operation identity `stella_interactions_governed_identity_check`
 * requires. Obviously synthetic on sight, and 64 hex characters so it satisfies
 * the column's shape. See the INSERT below for why it is deliberately not a
 * plausible charge key.
 */
const SYNTHETIC_IDEMPOTENCY_KEY = '0'.repeat(48) + 'deadbeef' + '0'.repeat(8)

const SYNTHETIC_RESPONSE_JSON = {
  summary: SYNTHETIC_MARKER,
  requiresHumanReview: true,
  findings: [],
  suggestions: [],
  clarifyingQuestions: [],
  limitations: [SYNTHETIC_MARKER],
}

async function main() {
  // The guard runs inside createDatabaseClient, before the driver exists: it
  // pins the capability, the environment AND the port. The port matters here
  // — this host runs several local Supabase stacks side by side, so loopback
  // alone does not identify the right database.
  const client = createDatabaseClient({
    connectionString: LOCAL_DB_URL,
    capability: 'local_seed',
    expectedLocalPort: LOCAL_DB_PORT,
  })
  console.log(`[seed-stella-local] ${client.decision.auditLine}`)

  const sql = client.sql

  try {
    // -----------------------------------------------------------------------
    // TRAIN 4.3 — THE SEED MAY NOT WEAR A RUNTIME IDENTITY (FASE 11)
    // -----------------------------------------------------------------------
    // `db/prepared/stella_0017_governed_stella_consumption.sql` §1 revokes
    // INSERT on `public.stella_interactions` from every runtime principal —
    // `uellix_writer` (the real holder; `uellix_app` inherits from it),
    // `uellix_app`, `authenticated`, `anon`, `service_role`, `authenticator`
    // and PUBLIC. The ledger's only writers are the table OWNER and
    // `uellix_cap_stella_quota`, and the second only in order to BE the
    // governed conversion function.
    //
    // A seed that wrote through a runtime role would therefore be one of two
    // things, and both are bad: on a database WITH stella_0017 it would fail
    // confusingly, and on a database WITHOUT it, it would be a working,
    // committed, runtime-equivalent bypass — a demonstration that the direct
    // path still exists, kept alive in the repository by a fixture script.
    //
    // So the refusal is EXPLICIT and comes first, before any statement that
    // could write. It is checked on `session_user` and `current_user` both:
    // the first is who connected, the second is who is acting after any
    // `SET ROLE`, and a script that checked only one could be redirected by
    // the other.
    const [identity] = await sql<{ session_user: string; current_user: string }[]>`
      SELECT session_user::text AS session_user, current_user::text AS current_user
    `
    const RUNTIME_IDENTITIES = [
      'uellix_app',
      'uellix_writer',
      'uellix_reader',
      'uellix_auditor',
      'authenticated',
      'anon',
      'service_role',
      'authenticator',
    ]
    const wearing = [identity?.session_user, identity?.current_user].filter(
      (role): role is string => typeof role === 'string' && RUNTIME_IDENTITIES.includes(role),
    )
    if (wearing.length > 0) {
      console.error(
        '[seed-stella-local] REFUSED: this script writes fixtures into public.stella_interactions ' +
          'and is running under a RUNTIME identity. Runtime principals hold no write privilege on ' +
          'the ledger (prepared stella_0017 §1), and a seed that had one would be a committed ' +
          'bypass of the governed consumption path. Re-run as the migrator/owner identity.',
      )
      console.error(`[seed-stella-local] refused identity: ${wearing.join(', ')}`)
      process.exit(1)
    }

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

    // TRAIN 4.3. `stella_interactions_governed_identity_check` (prepared
    // stella_0017 §2) requires an operation identity on every row. It is
    // `NOT VALID`, so it binds the OWNER too and `session_replication_role`
    // does not silence it — the fixture therefore carries one.
    //
    // The value is DELIBERATELY NOT a plausible charge key. A real one is
    // sha256('stella/ticket/charge/v1' || LF || ticket_id || LF || nonce),
    // derived inside the completion verb from a nonce no function returns. This
    // is a fixed, obviously-synthetic 64-hex literal in the same recognizable
    // pattern as the ids above, so a row seeded by this script can never be
    // mistaken — by an auditor or by a query — for a unit some reviewer was
    // actually charged for.
    await sql`
      INSERT INTO public.stella_interactions (
        id, organization_id, project_id, created_by,
        stella_role, pipeline_step, context_hash, response_json,
        model_used, tokens_used, risk_level, risk_flags,
        idempotency_key
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
        '{}',
        ${SYNTHETIC_IDEMPOTENCY_KEY}
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
    await client.close()
  }
}

main().catch((err) => {
  // Redacted: the first post-guard failure is a driver error whose message
  // embeds the host verbatim.
  console.error('[seed-stella-local] Failed:', describeError(err))
  process.exit(1)
})
