import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: pnpm tsx scripts/create-test-user.ts <email> <password>');
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  // --- Production safety guard ---
  let isLocal = false;
  try {
    const url = new URL(supabaseUrl);
    isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    // Fallback string matching if URL parsing fails
    isLocal = supabaseUrl.includes('localhost') || supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('[::1]') || supabaseUrl.includes('::1');
  }

  if (!isLocal || process.env.NODE_ENV === 'production') {
    console.error(
      '🚨 SAFETY VIOLATION: This script is restricted to LOCAL loopback instances only.\n' +
      `   Rejected URL: ${supabaseUrl}\n` +
      `   NODE_ENV: ${process.env.NODE_ENV || '(not set)'}\n` +
      '   Operation refused. You can only execute this script against localhost, 127.0.0.1, or ::1.'
    );
    process.exit(1);
  }
  // --- End production safety guard ---

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

main().catch(console.error);
