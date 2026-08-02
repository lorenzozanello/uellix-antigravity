// tests/database-runtime-identity.test.ts
//
// WHO DOES THE APPLICATION ACTUALLY CONNECT AS?
//
// This is the test whose absence let the pre-cutover state persist. The role
// model was verified, the policies were verified, the prepared SQL was
// verified — and nothing ever asked the running application which role it
// authenticated as. It was `postgres`, with BYPASSRLS, for the entire period
// the model was believed to be in force.
//
// So the live half of this file opens a connection through
// `getDefaultDatabaseClient()` — the exact factory `db/client.ts` uses to serve
// requests — and asks the SERVER. Not the configuration, not a constant: the
// server.

import { describe, it, expect } from 'vitest'
import {
  assertRuntimeIdentity,
  readRuntimeIdentity,
  RuntimeIdentityError,
  type RuntimeIdentity,
} from '@/db/runtime-bootstrap'
import {
  RUNTIME_DATABASE_ROLE,
  FORBIDDEN_RUNTIME_DATABASE_ROLES,
  LEGACY_ADMIN_DATABASE_ROLE,
} from '@/db/safety/database-role'
import {
  parseDeclaredRole,
  resolveRuntimeDatabaseUrl,
  resolveMigratorDatabaseUrl,
  RUNTIME_DATABASE_URL_ENV_VAR,
  MIGRATOR_DATABASE_URL_ENV_VAR,
  LEGACY_SHARED_DATABASE_URL_ENV_VAR,
  CapabilityDatabaseUrlError,
} from '@/db/safety/resolve-capability-database-url'
import { RUNTIME_CONNECTION, runtimeSql } from './helpers/local-runtime'

const SAFE: RuntimeIdentity = {
  sessionUser: RUNTIME_DATABASE_ROLE,
  currentUser: RUNTIME_DATABASE_ROLE,
  isSuperuser: false,
  bypassesRls: false,
  canCreateRole: false,
  canSetOwnerRole: false,
  canCreateInPublic: false,
}

function capture(run: () => void): { code?: string; message: string } {
  try {
    run()
    throw new Error('expected a throw')
  } catch (error) {
    if (error instanceof RuntimeIdentityError) return { code: error.code, message: error.message }
    if (error instanceof CapabilityDatabaseUrlError) {
      return { code: error.code, message: error.message }
    }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Offline: the assertion logic itself                                        */
/* -------------------------------------------------------------------------- */

describe('assertRuntimeIdentity — every divergence is refused', () => {
  it('accepts the least-privilege runtime role', () => {
    expect(() => assertRuntimeIdentity(SAFE)).not.toThrow()
  })

  it.each([
    ['a different session_user', { sessionUser: 'postgres' }, 'DB_RUNTIME_IDENTITY_WRONG_ROLE'],
    ['a different current_user', { currentUser: 'uellix_owner' }, 'DB_RUNTIME_IDENTITY_WRONG_ROLE'],
    ['superuser', { isSuperuser: true }, 'DB_RUNTIME_IDENTITY_SUPERUSER'],
    ['BYPASSRLS', { bypassesRls: true }, 'DB_RUNTIME_IDENTITY_BYPASSRLS'],
    ['CREATEROLE', { canCreateRole: true }, 'DB_RUNTIME_IDENTITY_CREATEROLE'],
    ['SET ROLE to the owner', { canSetOwnerRole: true }, 'DB_RUNTIME_IDENTITY_CAN_SET_OWNER'],
    ['CREATE on public', { canCreateInPublic: true }, 'DB_RUNTIME_IDENTITY_CAN_CREATE_PUBLIC'],
  ])('refuses %s', (_label, override, expectedCode) => {
    const error = capture(() => assertRuntimeIdentity({ ...SAFE, ...override }))
    expect(error.code).toBe(expectedCode)
  })

  it('names no credential in any refusal', () => {
    const overrides = [
      { sessionUser: 'postgres' },
      { isSuperuser: true },
      { bypassesRls: true },
      { canCreateRole: true },
      { canSetOwnerRole: true },
      { canCreateInPublic: true },
    ]
    for (const override of overrides) {
      const { message } = capture(() => assertRuntimeIdentity({ ...SAFE, ...override }))
      expect(message).not.toMatch(/postgresql:\/\//)
      expect(message).not.toMatch(/@127\.0\.0\.1/)
      expect(message).not.toMatch(/password/i)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Offline: one variable per capability                                       */
/* -------------------------------------------------------------------------- */

describe('capability URL resolution — DATABASE_URL no longer means three things', () => {
  const RUNTIME_URL = `postgresql://${RUNTIME_DATABASE_ROLE}:pw@127.0.0.1:56322/postgres`
  const ADMIN_URL = `postgresql://${LEGACY_ADMIN_DATABASE_ROLE}:pw@127.0.0.1:56322/postgres`

  it('reads the runtime URL from its own variable', () => {
    const resolved = resolveRuntimeDatabaseUrl({ [RUNTIME_DATABASE_URL_ENV_VAR]: RUNTIME_URL })
    expect(resolved.declaredRole).toBe(RUNTIME_DATABASE_ROLE)
  })

  it('does NOT fall back to DATABASE_URL when the runtime variable is absent', () => {
    const error = capture(() =>
      resolveRuntimeDatabaseUrl({ [LEGACY_SHARED_DATABASE_URL_ENV_VAR]: RUNTIME_URL })
    )
    expect(error.code).toBe('DB_CAPABILITY_URL_MISSING')
  })

  it('refuses an administrative role in the runtime variable', () => {
    const error = capture(() => resolveRuntimeDatabaseUrl({ [RUNTIME_DATABASE_URL_ENV_VAR]: ADMIN_URL }))
    expect(error.code).toBe('DB_CAPABILITY_URL_WRONG_ROLE')
    expect(error.message).toContain(LEGACY_ADMIN_DATABASE_ROLE)
  })

  it('refuses the MIGRATOR credential in the runtime variable, and vice versa', () => {
    const migratorUrl = `postgresql://uellix_migrator:pw@127.0.0.1:56322/postgres`
    expect(
      capture(() => resolveRuntimeDatabaseUrl({ [RUNTIME_DATABASE_URL_ENV_VAR]: migratorUrl })).code
    ).toBe('DB_CAPABILITY_URL_WRONG_ROLE')
    expect(
      capture(() => resolveMigratorDatabaseUrl({ [MIGRATOR_DATABASE_URL_ENV_VAR]: RUNTIME_URL })).code
    ).toBe('DB_CAPABILITY_URL_WRONG_ROLE')
  })

  it('refuses a URL that names no role at all', () => {
    const error = capture(() =>
      resolveRuntimeDatabaseUrl({
        [RUNTIME_DATABASE_URL_ENV_VAR]: 'postgresql://127.0.0.1:56322/postgres',
      })
    )
    expect(error.code).toBe('DB_CAPABILITY_URL_NO_ROLE')
  })

  it('never echoes the URL or the password in a resolution error', () => {
    const leaky = `postgresql://${LEGACY_ADMIN_DATABASE_ROLE}:sup3r-s3cret@db.example.com:5432/postgres`
    const { message } = capture(() => resolveRuntimeDatabaseUrl({ [RUNTIME_DATABASE_URL_ENV_VAR]: leaky }))
    expect(message).not.toContain('sup3r-s3cret')
    expect(message).not.toContain('db.example.com')
    expect(message).not.toContain('postgresql://')
  })

  it('parses the role without ever surfacing the password', () => {
    expect(parseDeclaredRole('postgresql://uellix_app:hunter2@127.0.0.1:56322/postgres')).toBe(
      'uellix_app'
    )
    expect(parseDeclaredRole('not a url')).toBeNull()
  })

  it('lists every administrative identity as forbidden for the runtime', () => {
    expect(FORBIDDEN_RUNTIME_DATABASE_ROLES).toContain('postgres')
    expect(FORBIDDEN_RUNTIME_DATABASE_ROLES).toContain('supabase_admin')
    expect(FORBIDDEN_RUNTIME_DATABASE_ROLES).toContain('service_role')
    expect(FORBIDDEN_RUNTIME_DATABASE_ROLES).toContain('uellix_owner')
    expect(FORBIDDEN_RUNTIME_DATABASE_ROLES).toContain('uellix_migrator')
    expect(FORBIDDEN_RUNTIME_DATABASE_ROLES).not.toContain(RUNTIME_DATABASE_ROLE)
  })
})

/* -------------------------------------------------------------------------- */
/* Live: what the running application actually is                             */
/* -------------------------------------------------------------------------- */

describe.skipIf(!RUNTIME_CONNECTION.available)(
  `live runtime identity (stack ${RUNTIME_CONNECTION.available ? 'reachable' : `unreachable: ${RUNTIME_CONNECTION.reason}`})`,
  () => {
    it('the application factory authenticates as the least-privilege role', async () => {
      const identity = await readRuntimeIdentity(runtimeSql)

      expect(identity.sessionUser).toBe(RUNTIME_DATABASE_ROLE)
      expect(identity.currentUser).toBe(RUNTIME_DATABASE_ROLE)
      expect(identity.isSuperuser).toBe(false)
      expect(identity.bypassesRls).toBe(false)
      expect(identity.canCreateRole).toBe(false)
      expect(identity.canSetOwnerRole).toBe(false)
      expect(identity.canCreateInPublic).toBe(false)
    })

    it('passes its own bootstrap assertion', async () => {
      const identity = await readRuntimeIdentity(runtimeSql)
      expect(() => assertRuntimeIdentity(identity)).not.toThrow()
    })

    it('row level security is ACTIVE for this connection', async () => {
      const [row] = await runtimeSql<{ projects: boolean; interactions: boolean }[]>`
        SELECT row_security_active('public.projects')            AS projects,
               row_security_active('public.stella_interactions') AS interactions
      `
      expect(row.projects).toBe(true)
      expect(row.interactions).toBe(true)
    })

    it('carries the hardened session settings from stella_0005b', async () => {
      const [row] = await runtimeSql<{ search_path: string; idle_timeout: string }[]>`
        SELECT current_setting('search_path')                            AS search_path,
               current_setting('idle_in_transaction_session_timeout')    AS idle_timeout
      `
      // `"$user"` is gone: no schema named after the role can shadow public.
      expect(row.search_path).toBe('public')
      expect(row.idle_timeout).not.toBe('0')
    })
  }
)
