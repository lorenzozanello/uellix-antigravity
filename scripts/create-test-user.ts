// scripts/create-test-user.ts
//
// LOCAL ONLY, FAIL-CLOSED. Creates or resets a synthetic auth user.
//
// The previous guard parsed the URL but fell back to substring matching when
// parsing failed (`supabaseUrl.includes('localhost')`) — which is exactly the
// bypass the central classifier exists to remove: `https://localhost.attacker
// .example/` contains "localhost" and would have been accepted. The guard now
// delegates to `assertSupabaseApiOperationAllowed`, which fails closed on any
// URL it cannot classify and additionally pins the local API port.

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { assertSupabaseApiOperationAllowed } from '../db/safety/database-access';
import { LOCAL_API_PORT, LOCAL_SUPABASE_API_URL } from '../db/safety/local-stack';
import { describeError } from '../db/safety/redact-error';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: pnpm tsx scripts/create-test-user.ts <email> <password>');
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_SUPABASE_API_URL;

  // The target is checked FIRST — before the credential is even read, and
  // long before the admin client exists. Creating a user is a write.
  // Throws DatabaseSafetyError (redacted host, stable code) on any non-local
  // target, an unparseable URL, or a production environment.
  const decision = assertSupabaseApiOperationAllowed({
    url: supabaseUrl,
    capability: 'local_seed',
    expectedLocalPort: LOCAL_API_PORT,
  });
  console.log(`[create-test-user] ${decision.auditLine}`);

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  console.log(`Checking if user ${email} exists...`);
  const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers();
  
  if (listError) {
    console.error('Error listing users:', listError.message);
    process.exit(1);
  }

  const existingUser = users?.find(u => u.email === email);

  if (existingUser) {
    console.log(`User exists. Resetting password...`);
    const { error } = await adminClient.auth.admin.updateUserById(existingUser.id, { password });
    if (error) {
      console.error('Error updating user:', error.message);
      process.exit(1);
    }
    console.log('Password reset successfully.');
  } else {
    console.log(`Creating new user...`);
    const { error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      console.error('Error creating user:', error.message);
      process.exit(1);
    }
    console.log('User created successfully.');
  }
}

main().catch((err) => {
  // Must exit non-zero: a refused target has to fail the caller's `&&` chain
  // and any CI step, not just print to stderr.
  console.error('[create-test-user] Failed:', describeError(err));
  process.exit(1);
});
