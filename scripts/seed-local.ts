// scripts/seed-local.ts
//
// LOCAL ONLY, FAIL-CLOSED. Creates the base synthetic organizations, auth
// users and memberships for this worktree's isolated Supabase stack.
//
// Both destinations are guarded before anything is created:
//
//   * the Postgres target, via `createLocalDatabaseClient` (`local_seed`),
//     which resolves this worktree's pinned local URL and never reads
//     `DATABASE_URL`;
//   * the Supabase HTTP API target, via `assertSupabaseApiOperationAllowed`,
//     which runs BEFORE `createClient` — creating auth users is a write, so
//     the check cannot come after the admin client exists.
//
// The service-role key is the only value still read from the environment:
// it is a secret and cannot be pinned in source. It is never printed.

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { createLocalDatabaseClient } from '../db/client';
import { assertSupabaseApiOperationAllowed } from '../db/safety/database-access';
import { LOCAL_API_PORT, LOCAL_SUPABASE_API_URL } from '../db/safety/local-stack';
import { describeError } from '../db/safety/redact-error';

// Loads the service-role key. Note that no connection TARGET is taken from
// this file any more — only the credential.
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Defaults to this worktree's pinned local API port; an explicitly provided
// value is still forced through the local-only guard below.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_SUPABASE_API_URL;

async function main() {
  if (!serviceRoleKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY (expected in .env.local).');
    process.exit(1);
  }

  // Guard the auth/API target BEFORE the admin client is constructed.
  const apiDecision = assertSupabaseApiOperationAllowed({
    url: supabaseUrl,
    capability: 'local_seed',
    expectedLocalPort: LOCAL_API_PORT,
  });
  console.log(`[seed-local] supabase-api ${apiDecision.auditLine}`);

  const client = createLocalDatabaseClient({ capability: 'local_seed' });
  const sql = client.sql;
  for (const warning of client.warnings) console.warn(`[seed-local] ${warning}`);
  console.log(`[seed-local] postgres ${client.decision.auditLine}`);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  console.log('Seeding organizations and users...');

  // 1. Upsert Organizations
  const [orgA] = await sql`
    INSERT INTO public.organizations (name, slug) 
    VALUES ('Organización A', 'organizacion-a') 
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name 
    RETURNING id;
  `;
  const [orgB] = await sql`
    INSERT INTO public.organizations (name, slug) 
    VALUES ('Organización B', 'organizacion-b') 
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name 
    RETURNING id;
  `;

  console.log('Orgs initialized:', { orgA: orgA.id, orgB: orgB.id });

  const testUsers = [
    { email: 'admin-a@test.com', isSuper: false, orgId: orgA.id, role: 'organization_admin' },
    { email: 'analyst-a@test.com', isSuper: false, orgId: orgA.id, role: 'analyst' },
    { email: 'reviewer-a@test.com', isSuper: false, orgId: orgA.id, role: 'reviewer' },
    { email: 'viewer-a@test.com', isSuper: false, orgId: orgA.id, role: 'viewer' },
    { email: 'admin-b@test.com', isSuper: false, orgId: orgB.id, role: 'organization_admin' },
    { email: 'analyst-b@test.com', isSuper: false, orgId: orgB.id, role: 'analyst' },
    { email: 'unassigned@test.com', isSuper: false, orgId: null, role: null },
    { email: 'superadmin@test.com', isSuper: true, orgId: null, role: null }
  ];

  for (const tu of testUsers) {
    console.log(`Processing auth user: ${tu.email}`);
    // Check if auth user exists
    const { data: { users } } = await supabase.auth.admin.listUsers();
    let authUser = users?.find(u => u.email === tu.email);

    if (!authUser) {
      const { data: { user }, error } = await supabase.auth.admin.createUser({
        email: tu.email,
        password: 'Password123!',
        email_confirm: true
      });
      if (error || !user) {
        console.error(`Failed to create ${tu.email}:`, error?.message);
        continue;
      }
      authUser = user;
    } else {
      // Reset password
      await supabase.auth.admin.updateUserById(authUser.id, { password: 'Password123!' });
    }

    const userId = authUser.id;

    // Update public.users (inserted by auth trigger)
    await sql`
      UPDATE public.users 
      SET is_super_admin = ${tu.isSuper}
      WHERE id = ${userId};
    `;

    // Manage organization membership
    if (tu.orgId && tu.role) {
      await sql`
        INSERT INTO public.organization_members (user_id, organization_id, role, status)
        VALUES (${userId}, ${tu.orgId}, ${tu.role}, 'active')
        ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status;
      `;
    } else {
      // Remove any active membership if none specified
      await sql`
        DELETE FROM public.organization_members WHERE user_id = ${userId};
      `;
    }
  }

  console.log('Seeding completed successfully!');
  await client.close();
}

main().catch((err) => {
  console.error('[seed-local] Failed:', describeError(err));
  process.exit(1);
});
