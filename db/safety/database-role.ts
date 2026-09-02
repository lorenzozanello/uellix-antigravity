// db/safety/database-role.ts
//
// The role model, as CODE rather than as documentation.
//
// Until the runtime cutover, `DATABASE_URL` resolved to `postgres`: a role
// that owns nothing in `public` any more (stella_0004 moved ownership to
// `uellix_owner`) but still carries BYPASSRLS, CREATEROLE and CREATE on
// `public` through `pg_database_owner`. The reaudit
// (STELLA_DATABASE_PRIVILEGE_REAUDIT_BLOCKED_DDL_ESCALATION) showed the
// consequence: the least-privilege model existed, was correct when exercised
// directly, and governed no real traffic at all, because the traffic never
// used it.
//
// These constants are the vocabulary the rest of the cutover speaks. They are
// deliberately NOT strings scattered through call sites: the bootstrap check
// in db/runtime-bootstrap.ts, the migration wrapper, and the test suites all
// have to agree on one spelling, and a typo in any of them would weaken a
// check while leaving it looking green.

/** Least-privilege role the Next.js runtime connects as. */
export const RUNTIME_DATABASE_ROLE = 'uellix_app'

/** Owns every Uellix object in `public`. NOLOGIN — reachable only via SET ROLE. */
export const OWNER_DATABASE_ROLE = 'uellix_owner'

/** LOGIN role that may `SET ROLE uellix_owner`. Never handed to the runtime. */
export const MIGRATOR_DATABASE_ROLE = 'uellix_migrator'

/** Read-only role (`default_transaction_read_only=on`) for audit entry points. */
export const AUDITOR_DATABASE_ROLE = 'uellix_auditor'

/** NOLOGIN grant bundle the runtime inherits its DML privileges from. */
export const WRITER_DATABASE_ROLE = 'uellix_writer'

/**
 * The pre-cutover runtime role. Retained ONLY so checks can name what they
 * are refusing — nothing in this repository may connect as it for
 * application traffic again.
 */
export const LEGACY_ADMIN_DATABASE_ROLE = 'postgres'

/**
 * Roles a runtime connection must NEVER authenticate as. `postgres` and
 * `supabase_admin` are the two local identities that can escalate to
 * `uellix_owner`; `service_role` carries BYPASSRLS.
 */
export const FORBIDDEN_RUNTIME_DATABASE_ROLES: readonly string[] = Object.freeze([
  LEGACY_ADMIN_DATABASE_ROLE,
  'supabase_admin',
  'service_role',
  'authenticator',
  OWNER_DATABASE_ROLE,
  MIGRATOR_DATABASE_ROLE,
])
