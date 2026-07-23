import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import path from 'path';

// Resolve the path to .env.local in the root
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

async function main() {
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing env vars: URL=', supabaseUrl, 'Key=', serviceRoleKey ? 'loaded' : 'missing');
    process.exit(1);
  }

  // Safety guard
  const url = new URL(supabaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    console.error('Safety violation: Not running on local host.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const sql = postgres(dbUrl);

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
  await sql.end();
}

main().catch(console.error);
