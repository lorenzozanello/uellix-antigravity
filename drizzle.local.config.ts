import { defineConfig } from 'drizzle-kit';
import { URL } from 'url';

// CHANGED for the G2/G3 local rehearsal worktree: 55322 is the already-running
// uellix-antigravity stack's port on this host. Using it here would silently
// migrate against ANOTHER worktree's live local database instead of this
// worktree's isolated stack. See docs/ops/LOCAL_STAGING_G2_REHEARSAL.md.
const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:56322/postgres';

// Strict safety check for local environment
function validateLocalUrl(urlString: string) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname;
    const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
    
    if (!allowedHosts.includes(hostname)) {
      throw new Error(`DATABASE PROTECTION TRIGGERED: Hostname "${hostname}" is not allowed. Only local connections (127.0.0.1, localhost, ::1) are permitted.`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('\n================================================================');
    console.error('CRITICAL DATABASE SAFETY ERROR:');
    console.error(errMsg);
    console.error('================================================================\n');
    process.exit(1);
  }
}

// Validate our defined local URL
validateLocalUrl(LOCAL_DB_URL);

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: LOCAL_DB_URL,
  },
});
