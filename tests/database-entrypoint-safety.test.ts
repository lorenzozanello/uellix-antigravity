// tests/database-entrypoint-safety.test.ts
//
// Entry-point coverage: proves that every dangerous script and config refuses
// a non-local target BEFORE it connects, and that importing db/client has no
// connection side effect.
//
// NOTHING HERE TOUCHES A DATABASE.
//   * The in-process suites mock `postgres` and `drizzle`, so "did it try to
//     connect?" is an assertion on a spy rather than on a socket.
//   * The child-process suites only exercise REFUSAL paths — a script that
//     aborts never reaches its query. The success paths of seeds are
//     deliberately not executed here; running them would write fixtures.
//
// Every URL is fictional (RFC 5737 documentation ranges, example.com, an
// invented Supabase project reference). No real credential appears.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as dotenv from 'dotenv'
import {
  assertDatabaseOperationAllowed,
  DatabaseSafetyError,
} from '@/db/safety/database-access'
import { LOCAL_DATABASE_URL, LOCAL_DB_PORT } from '@/db/safety/local-stack'
import { describeError } from '@/db/safety/redact-error'
import { resolveLocalDatabaseUrl } from '@/db/safety/resolve-local-database-url'
import { resolveRuntimeDatabaseUrl } from '@/db/safety/resolve-capability-database-url'
import { mergeGuardedConnectionOptions } from '@/db/client'

const ROOT = process.cwd()
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const FAKE_REMOTE_URL =
  'postgresql://seeduser:nOt-a-ReAl-p4ssw0rd@db.projectref123.supabase.co:5432/postgres'
const FAKE_REMOTE_API_URL = 'https://projectref123.supabase.co'

/**
 * A syntactically valid, loopback-only, synthetic `UELLIX_RUNTIME_DATABASE_URL`
 * for spawning `vitest list` against the integration config in isolation.
 *
 * `vitest.setup.integration.ts` and `tests/integration/_guard.ts` both run
 * `resolveRuntimeDatabaseUrl()` and `assertDatabaseOperationAllowed()` at
 * COLLECTION time (vitest evaluates setup files before it can even list a
 * file's test names), so a subprocess that inherits this repo's real
 * environment — which has no `.env.local` and no exported
 * `UELLIX_RUNTIME_DATABASE_URL` in CI or a clean checkout — aborts before
 * listing anything: `process.exit(1)`, zero tests collected. That is a gap in
 * this SUITE's own environment, not a defect the guard is supposed to catch;
 * the guard is validating a URL shape (role `uellix_app`, loopback, this
 * worktree's db port), never opening a socket, so a well-formed fake target
 * satisfies it without a running database, `.env.local`, or any real
 * credential. The guard itself stays fully exercised — a wrong role or a
 * remote host here would still abort collection, which is exactly what
 * `tests/database-target-safety.test.ts` and the in-process refusal tests
 * below already pin down.
 */
const SYNTHETIC_LOCAL_RUNTIME_URL_FOR_COLLECTION = `postgresql://uellix_app:not-a-real-password@127.0.0.1:${LOCAL_DB_PORT}/postgres`

const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

/**
 * Strip comments before asserting on source.
 *
 * These files document the hazards they close, so their prose legitimately
 * mentions `DATABASE_URL`, `dotenv` and `postgres()`. Asserting on raw text
 * would make the comments themselves fail the test.
 */
const code = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/* -------------------------------------------------------------------------- */
/* 1. Static properties of the dangerous entry points                         */
/* -------------------------------------------------------------------------- */

const SEED_AND_FIXTURE_SCRIPTS = [
  'scripts/seed-local.ts',
  'scripts/seed-stella-local.ts',
  'scripts/seed-proxies.ts',
  'scripts/seed-taxonomies.ts',
  'scripts/create-test-user.ts',
  'scripts/db-audit-readonly.ts',
]

describe('no entry point resolves its database target from DATABASE_URL', () => {
  it.each([...SEED_AND_FIXTURE_SCRIPTS, 'drizzle.config.ts', 'drizzle.local.config.ts'])(
    '%s never reads process.env.DATABASE_URL',
    (relative) => {
      // The historical failure mode: `import 'dotenv/config'` plus
      // `import { db }` meant the destination came from whatever `.env`
      // happened to hold. These files now derive it from db/safety/local-stack.
      expect(code(relative)).not.toMatch(/process\.env\.DATABASE_URL/)
    }
  )

  it.each(['scripts/seed-proxies.ts', 'scripts/seed-taxonomies.ts'])(
    '%s no longer imports dotenv for its connection target',
    (relative) => {
      expect(code(relative)).not.toMatch(/dotenv/)
    }
  )

  it.each(SEED_AND_FIXTURE_SCRIPTS)('%s goes through the central safety layer', (relative) => {
    expect(code(relative)).toMatch(
      /createLocalDatabaseClient|createDatabaseClient|assertDatabaseOperationAllowed|assertSupabaseApiOperationAllowed/
    )
  })
})

describe('db/client.ts has no import-time connection', () => {
  const source = code('db/client.ts')

  it('does not build a client at module scope', () => {
    // Module-scope statements are the ones with no leading indentation.
    const moduleScopeLines = source
      .split('\n')
      .filter((line) => line.length > 0 && !/^\s/.test(line))
      .join('\n')
    expect(moduleScopeLines).not.toMatch(/postgres\(/)
    expect(moduleScopeLines).not.toMatch(/drizzle\(/)
  })

  it('exposes an explicit factory and a lazily built default', () => {
    expect(source).toMatch(/export function createDatabaseClient/)
    expect(source).toMatch(/export function createLocalDatabaseClient/)
    expect(source).toMatch(/new Proxy/)
  })

  it('there is exactly one place a connection is created, and it is guarded', () => {
    expect(source.match(/=\s*postgres\(/g) ?? []).toHaveLength(1)
    const guardIndex = source.indexOf('assertDatabaseOperationAllowed({')
    const connectIndex = source.indexOf('postgres(connectionString')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(connectIndex).toBeGreaterThan(guardIndex)
  })
})

describe('the integration suites cannot be run ungated', () => {
  // BLOCKER found in adversarial review: the `local_integration_test`
  // guarantee lived only in vitest.setup.integration.ts, which ONLY
  // vitest.integration.config.ts loads. The base config matched
  // tests/integration/** too (that is why `test:unit` needed an explicit
  // --exclude), so `pnpm test` — and `pnpm vitest run tests/integration/...` —
  // executed suites that create auth users and write fixtures with no target
  // check at all, with the shared `db` still on `app_runtime`.
  // BEHAVIOURAL, not a grep. The first version of this suite only asserted
  // that the base config mentions the exclusion — and that is exactly how the
  // opposite defect shipped green: `mergeConfig` CONCATENATES arrays, so the
  // integration config inherited the exclusion, collected ZERO files, and
  // would have turned the CI integration and RLS steps red. Both directions
  // are now asserted by actually resolving the two configs.
  const collect = (configPath: string): string[] => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'list',
        '--filesOnly',
        '--config',
        configPath,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: 'true',
          UELLIX_RUNTIME_DATABASE_URL: SYNTHETIC_LOCAL_RUNTIME_URL_FOR_COLLECTION,
        },
      }
    )
    return (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/\\/g, '/'))
      .filter((line) => line.endsWith('.test.ts') || line.endsWith('.test.tsx'))
  }

  it('the DEFAULT config collects no file under tests/integration', () => {
    const files = collect('vitest.config.ts')
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter((f) => f.startsWith('tests/integration/'))).toEqual([])
  }, 120_000)

  it('the INTEGRATION config still collects both integration files', () => {
    const files = collect('vitest.integration.config.ts').sort()
    expect(files).toEqual([
      'tests/integration/investments.service.test.ts',
      'tests/integration/rls.test.ts',
    ])
  }, 120_000)

  it.each(['tests/integration/rls.test.ts', 'tests/integration/investments.service.test.ts'])(
    '%s imports the per-file guard FIRST, so the gate does not depend on the config',
    (relative) => {
      const source = code(relative)
      const guardIndex = source.indexOf("import './_guard'")
      expect(guardIndex).toBeGreaterThan(-1)
      // No other import may precede it — in particular not @/db/client.
      const firstImport = source.indexOf('import ')
      expect(guardIndex).toBe(firstImport)
    }
  )

  it('the per-file guard asserts both targets and narrows the shared client', () => {
    const guard = read('tests/integration/_guard.ts')
    expect(guard).toMatch(/capability: 'local_integration_test'/)
    expect(guard).toMatch(/assertSupabaseApiOperationAllowed/)
    expect(guard).toMatch(/restrictDefaultDatabaseClient/)
    expect(guard).toMatch(/process\.exit\(1\)/)
  })

  it.each(['tests/integration/_guard.ts', 'vitest.setup.integration.ts'])(
    '%s resolves the capability variable and never DATABASE_URL (reaudit M2)',
    (relative) => {
      // The historical defect: after the capability split nothing provisions
      // DATABASE_URL, so a gate that read it aborted unconditionally and the
      // 49 integration tests became unrunnable. The gate must vet the URL the
      // shared client will actually use.
      const source = code(relative)
      expect(source).toMatch(/resolveRuntimeDatabaseUrl\(/)
      expect(source).not.toMatch(/process\.env\.DATABASE_URL/)
      // The resolved URL — not some other variable — feeds the target guard.
      expect(source).toMatch(/url:\s*resolved\.url/)
      expect(source).toMatch(/expectedLocalPort:\s*LOCAL_DB_PORT/)
    }
  )

  it('the integration suite still collects its 49 tests — zero collection is a failure', () => {
    // "The config collects the two files" (asserted above) is necessary but
    // not sufficient: a file whose guard aborts at import time collects zero
    // TESTS while still being listed. Count the tests themselves.
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'list',
        '--config',
        'vitest.integration.config.ts',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: 'true',
          UELLIX_RUNTIME_DATABASE_URL: SYNTHETIC_LOCAL_RUNTIME_URL_FOR_COLLECTION,
        },
      }
    )
    const tests = (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(' > '))
    expect(tests.length).toBe(49)
  }, 120_000)
})

describe('the integration gate refuses each misconfiguration before any connection', () => {
  // The gate is two layers applied in order — role, then target. These are the
  // same calls tests/integration/_guard.ts makes, exercised in-process with an
  // explicit env so each refusal is observable as a typed error rather than as
  // a child process's exit code.
  const gate = (runtimeUrl: string | undefined) => {
    const env: Record<string, string | undefined> = {}
    if (runtimeUrl !== undefined) env.UELLIX_RUNTIME_DATABASE_URL = runtimeUrl
    const resolved = resolveRuntimeDatabaseUrl(env)
    return assertDatabaseOperationAllowed({
      url: resolved.url,
      capability: 'local_integration_test',
      expectedLocalPort: LOCAL_DB_PORT,
      env,
    })
  }

  it('refuses when the capability variable is missing', () => {
    expect(() => gate(undefined)).toThrowError(
      expect.objectContaining({ code: 'DB_CAPABILITY_URL_MISSING' })
    )
  })

  it('refuses when the variable is present but empty', () => {
    expect(() => gate('   ')).toThrowError(
      expect.objectContaining({ code: 'DB_CAPABILITY_URL_MISSING' })
    )
  })

  it('refuses an administrative role even on the right local target', () => {
    expect(() => gate(`postgresql://postgres:pw@127.0.0.1:${LOCAL_DB_PORT}/postgres`)).toThrowError(
      expect.objectContaining({ code: 'DB_CAPABILITY_URL_WRONG_ROLE' })
    )
  })

  it('refuses a remote target even with the right role', () => {
    expect(() => gate('postgresql://uellix_app:pw@db.projectref123.supabase.co:5432/postgres')).toThrowError(
      expect.objectContaining({ code: 'DB_OPERATION_NOT_ALLOWED' })
    )
  })

  it("refuses another stack's loopback port with the port-specific code", () => {
    expect(() => gate('postgresql://uellix_app:pw@127.0.0.1:55322/postgres')).toThrowError(
      expect.objectContaining({ code: 'DB_LOCAL_PORT_MISMATCH' })
    )
  })

  it('accepts exactly this worktree: uellix_app on loopback port 56322', () => {
    const decision = gate(`postgresql://uellix_app:pw@127.0.0.1:${LOCAL_DB_PORT}/postgres`)
    expect(decision.targetKind).toBe('local_loopback')
    expect(LOCAL_DB_PORT).toBe(56322)
  })
})

describe('vitest integration setup gates before any test module loads', () => {
  const source = read('vitest.setup.integration.ts')

  it('asserts the local_integration_test capability for db and api targets', () => {
    expect(source).toMatch(/capability: 'local_integration_test'/)
    expect(source).toMatch(/assertSupabaseApiOperationAllowed/)
  })

  it('narrows the shared client away from app_runtime', () => {
    expect(source).toMatch(/restrictDefaultDatabaseClient\(/)
  })

  it('aborts the process rather than failing a single file', () => {
    expect(source).toMatch(/process\.exit\(1\)/)
  })

  it('is the setup file the integration config actually uses', () => {
    expect(read('vitest.integration.config.ts')).toMatch(/vitest\.setup\.integration/)
  })
})

describe('package.json declares the environment in every database command', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

  it.each([
    'db:seed:local',
    'db:seed:local:proxies',
    'db:seed:local:taxonomies',
    'db:migrate:local',
    'db:test:integration:local',
    'db:audit:readonly',
    'db:guard:local-reset',
  ])('%s exists', (name) => {
    expect(pkg.scripts[name]).toBeTruthy()
  })

  it.each(['db:seed:proxies', 'db:seed:taxonomies', 'db:migrate'])(
    'the ambiguous command %s is blocked, not silently repurposed',
    (name) => {
      expect(pkg.scripts[name]).toMatch(/blocked-command/)
    }
  )

  it('the destructive local reset runs its guard first', () => {
    expect(pkg.scripts['db:reset:local']).toMatch(/^pnpm db:guard:local-reset &&/)
  })

  it('no script passes a raw DATABASE_URL to drizzle-kit or tsx', () => {
    for (const command of Object.values(pkg.scripts)) {
      expect(command).not.toMatch(/DATABASE_URL/)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 2. In-process: the guard fires before postgres() is ever called            */
/* -------------------------------------------------------------------------- */

const spies = vi.hoisted(() => ({
  postgresCalls: [] as string[],
  // The OPTIONS the driver would receive. The first version of this mock
  // discarded them, which meant the read-only enforcement had no test that
  // could observe it: the only assertion read `decision.readOnly` back out of
  // the policy table, so deleting the enforcement in db/client.ts left the
  // whole suite green while every audit connection became writable.
  postgresOptions: [] as Record<string, unknown>[],
}))

vi.mock('postgres', () => ({
  default: (connectionString: string, options: Record<string, unknown>) => {
    spies.postgresCalls.push(connectionString)
    spies.postgresOptions.push(options ?? {})
    return { end: async () => undefined }
  },
}))

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: () => ({ select: () => 'select()', marker: 'fake-drizzle' }),
}))

/**
 * Assert a refusal by SHAPE, not by `instanceof`.
 *
 * `vi.resetModules()` gives the re-imported db/client its own copy of the
 * safety module, so the `DatabaseSafetyError` it throws is a different class
 * object than the one this file imported at the top and `instanceof` is
 * false. The stable error `code` is the contract these tests care about
 * anyway — that is exactly why it exists.
 */
function expectRefusal(run: () => unknown, expectedCode: string): void {
  try {
    run()
  } catch (error) {
    const refusal = error as { name?: string; code?: string }
    expect(refusal.name).toBe('DatabaseSafetyError')
    expect(refusal.code).toBe(expectedCode)
    return
  }
  throw new Error(`expected a refusal with code ${expectedCode}, but the operation was allowed`)
}

/**
 * A local URL that declares the RUNTIME role.
 *
 * The default client no longer reads `DATABASE_URL`, and no longer accepts a
 * URL whose userinfo names `postgres` — that pairing is exactly what the
 * cutover removed. `LOCAL_DATABASE_URL` still names `postgres` because local
 * seeds, resets and the read-only audit legitimately use it, so these
 * runtime-path tests need their own.
 *
 * The password is a placeholder: every test in this block is intercepted by the
 * `postgres()` spy and never opens a socket.
 */
const LOCAL_RUNTIME_URL = `postgresql://uellix_app:not-a-real-password@127.0.0.1:${LOCAL_DB_PORT}/postgres`

describe('db/client — the guard runs before the driver', () => {
  let client: typeof import('@/db/client')
  const originalDatabaseUrl = process.env.DATABASE_URL
  const originalRuntimeUrl = process.env.UELLIX_RUNTIME_DATABASE_URL

  beforeEach(async () => {
    spies.postgresCalls.length = 0
    spies.postgresOptions.length = 0
    vi.resetModules()
    client = await import('@/db/client')
  })

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
    if (originalRuntimeUrl === undefined) delete process.env.UELLIX_RUNTIME_DATABASE_URL
    else process.env.UELLIX_RUNTIME_DATABASE_URL = originalRuntimeUrl
  })

  it('importing the module opens nothing', () => {
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('INSPECTING the default export opens nothing either', () => {
    // Vitest's automocker enumerates a module's exports when a suite writes
    // `vi.mock('@/db/client')` with no factory. If enumeration built a
    // client, every such suite would need a live DATABASE_URL. Inspection
    // must stay inert; only use may connect.
    expect(Object.keys(client.db)).toEqual([])
    expect(Object.getOwnPropertyNames(client.db)).toEqual([])
    expect('select' in client.db).toBe(false)
    // The exact read the automocker performs: a well-known symbol.
    expect(Object.prototype.toString.call(client.db)).toBe('[object Object]')
    expect(spies.postgresCalls).toHaveLength(0)

    // NOTE: `JSON.stringify` is NOT inert — it performs a string `get` for
    // `toJSON`, which counts as use and does build the client.
  })

  it('a string-keyed read still builds the client — inertness is scoped, not blanket', () => {
    process.env.UELLIX_RUNTIME_DATABASE_URL = LOCAL_RUNTIME_URL
    void client.db.select
    expect(spies.postgresCalls).toEqual([LOCAL_RUNTIME_URL])
  })

  it('DATABASE_URL alone no longer builds anything — it is inert, not preferred', () => {
    // The single most important regression this file can catch. Before the
    // cutover this variable WAS the runtime connection, and it resolved to
    // `postgres`. A fallback to it "just in case the new one is missing" would
    // silently restore BYPASSRLS the first time somebody forgot to set the new
    // variable.
    delete process.env.UELLIX_RUNTIME_DATABASE_URL
    process.env.DATABASE_URL = LOCAL_DATABASE_URL
    try {
      void client.db.select
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('DB_CAPABILITY_URL_MISSING')
    }
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('refuses an administrative role in the runtime variable, without connecting', () => {
    process.env.UELLIX_RUNTIME_DATABASE_URL = LOCAL_DATABASE_URL // declares `postgres`
    try {
      void client.db.select
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('DB_CAPABILITY_URL_WRONG_ROLE')
    }
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('refuses a remote target for local_seed without calling postgres()', () => {
    expectRefusal(
      () =>
        client.createDatabaseClient({
          connectionString: FAKE_REMOTE_URL,
          capability: 'local_seed',
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
        }),
      'DB_OPERATION_NOT_ALLOWED'
    )
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('refuses an invalid URL without calling postgres()', () => {
    expectRefusal(
      () =>
        client.createDatabaseClient({
          connectionString: 'not a url',
          capability: 'app_runtime',
          environment: 'development',
          env: {},
        }),
      'DB_TARGET_URL_INVALID'
    )
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('allows the local stack and connects exactly once', () => {
    const created = client.createDatabaseClient({
      connectionString: LOCAL_DATABASE_URL,
      capability: 'local_seed',
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
    })
    expect(spies.postgresCalls).toEqual([LOCAL_DATABASE_URL])
    expect(created.decision.targetKind).toBe('local_loopback')
  })

  it('the default `db` export does not connect until it is used', () => {
    process.env.UELLIX_RUNTIME_DATABASE_URL = LOCAL_RUNTIME_URL
    expect(spies.postgresCalls).toHaveLength(0)
    // Touching a property is what triggers the lazy build.
    void client.db.select
    expect(spies.postgresCalls).toEqual([LOCAL_RUNTIME_URL])
  })

  it('a restricted default client refuses a remote runtime URL on first use', () => {
    client.restrictDefaultDatabaseClient({
      capability: 'local_integration_test',
      expectedLocalPort: LOCAL_DB_PORT,
    })
    // Remote AND correctly-roled: the target guard must refuse it on its own,
    // without help from the role pre-check.
    process.env.UELLIX_RUNTIME_DATABASE_URL = FAKE_REMOTE_URL.replace(
      /\/\/[^:]+:/,
      '//uellix_app:'
    )
    expectRefusal(() => client.db.select, 'DB_OPERATION_NOT_ALLOWED')
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('the restriction cannot be applied after a client exists', () => {
    process.env.UELLIX_RUNTIME_DATABASE_URL = LOCAL_RUNTIME_URL
    void client.db.select
    expect(() =>
      client.restrictDefaultDatabaseClient({ capability: 'local_integration_test' })
    ).toThrow(/already created/)
  })

  it('the restriction is one-shot — a second call cannot re-open what the first closed', () => {
    // MAJOR found in adversarial review: the original implementation only
    // refused calls made AFTER a client existed, so any module loading later
    // could overwrite a narrow restriction with a wide one before the first
    // query ran.
    client.restrictDefaultDatabaseClient({
      capability: 'local_integration_test',
      expectedLocalPort: LOCAL_DB_PORT,
    })
    expect(() =>
      client.restrictDefaultDatabaseClient({ capability: 'local_seed' })
    ).toThrow(/one-shot/)
  })

  it('the restriction cannot select app_runtime — restricting must never widen', () => {
    expect(() => client.restrictDefaultDatabaseClient({ capability: 'app_runtime' })).toThrow(
      /cannot select "app_runtime"/
    )
  })

  it('there is no exported escape hatch that clears the restriction', () => {
    // `resetDefaultDatabaseClientForTests` used to be exported from this
    // module — which 65 production files import — and it set the restriction
    // back to null, silently returning the shared client to `app_runtime`.
    expect(client).not.toHaveProperty('resetDefaultDatabaseClientForTests')
  })

  it('refuses postgresOptions that could redirect the connection', () => {
    // postgres-js resolves `o.hostname || o.host || ... || url.hostname`, so
    // an options object BEATS the connection string — the guard would have
    // classified the local URL while the driver dialled elsewhere.
    for (const key of ['host', 'hostname', 'port', 'socket', 'path']) {
      expect(() =>
        client.createDatabaseClient({
          connectionString: LOCAL_DATABASE_URL,
          capability: 'local_seed',
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
          postgresOptions: { [key]: 'anything' } as never,
        })
      ).toThrow(/postgresOptions may not contain/)
    }
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('a read-only capability reaches the DRIVER with the read-only flag set', () => {
    // Asserts what is actually handed to postgres-js, not what the policy
    // table says. Delete the enforcement in db/client.ts and this fails.
    const created = client.createDatabaseClient({
      connectionString: LOCAL_DATABASE_URL,
      capability: 'readonly_audit',
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
    })
    expect(created.decision.readOnly).toBe(true)
    const connection = spies.postgresOptions.at(-1)?.connection as Record<string, unknown>
    expect(connection?.default_transaction_read_only).toBe('on')
  })

  it('a writing capability does NOT get the read-only flag', () => {
    client.createDatabaseClient({
      connectionString: LOCAL_DATABASE_URL,
      capability: 'local_seed',
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
    })
    const connection = spies.postgresOptions.at(-1)?.connection as Record<string, unknown> | undefined
    expect(connection?.default_transaction_read_only).toBeUndefined()
  })

  it('refuses postgresOptions.connection keys that carry the guard\'s own settings', () => {
    for (const key of ['options', 'default_transaction_read_only']) {
      expect(() =>
        client.createDatabaseClient({
          connectionString: LOCAL_DATABASE_URL,
          capability: 'readonly_audit',
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
          postgresOptions: { connection: { [key]: 'off' } } as never,
        })
      ).toThrow(/postgresOptions\.connection may not contain/)
    }
  })

  it.each([
    ['DEFAULT_TRANSACTION_READ_ONLY', 'default_transaction_read_only'],
    ['Default_Transaction_Read_Only', 'default_transaction_read_only'],
    ['dEfAuLt_TrAnSaCtIoN_rEaD_oNlY', 'default_transaction_read_only'],
    ['OPTIONS', 'options'],
    ['Options', 'options'],
  ])(
    'refuses a case-varied spelling of a guard-owned key: %s',
    // Reaudit gap (GUC-CASE): the check compared `suppliedConnection[key]` against
    // the exact-lowercase literal, so `DEFAULT_TRANSACTION_READ_ONLY` sailed
    // through untouched — and Postgres GUC names are case-insensitive, so the
    // server would have honoured it exactly like the lowercase form the guard
    // already refuses.
    (suppliedKey) => {
      expect(() =>
        client.createDatabaseClient({
          connectionString: LOCAL_DATABASE_URL,
          capability: 'readonly_audit',
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
          postgresOptions: { connection: { [suppliedKey]: 'off' } } as never,
        })
      ).toThrow(/postgresOptions\.connection may not contain/)
      expect(spies.postgresCalls).toHaveLength(0)
    }
  )

  it('still refuses multiple case-varied guard-owned keys supplied together', () => {
    expect(() =>
      client.createDatabaseClient({
        connectionString: LOCAL_DATABASE_URL,
        capability: 'readonly_audit',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
        postgresOptions: {
          connection: { OPTIONS: '-c anything', Default_Transaction_Read_Only: 'off' },
        } as never,
      })
    ).toThrow(/postgresOptions\.connection may not contain/)
  })

  it('does not reject an allowed key merely because its case differs from a guard-owned one', () => {
    // The normalisation must only widen what is REFUSED, never narrow what a
    // caller may legitimately pass — application_name is not guard-owned in
    // any case.
    const created = client.createDatabaseClient({
      connectionString: LOCAL_DATABASE_URL,
      capability: 'readonly_audit',
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
      postgresOptions: { connection: { APPLICATION_NAME: 'audit-test' } } as never,
    })
    expect(created.decision.readOnly).toBe(true)
  })

  it('an empty postgresOptions.connection is never treated as carrying a guard-owned key', () => {
    expect(() =>
      client.createDatabaseClient({
        connectionString: LOCAL_DATABASE_URL,
        capability: 'readonly_audit',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
        postgresOptions: { connection: {} } as never,
      })
    ).not.toThrow()
  })

  it('does not mutate the caller-supplied connection object while validating its keys', () => {
    // "no modificar las claves originales del caller salvo para validación":
    // normalisation must happen on a derived copy, not on the object the
    // caller still holds a reference to.
    const callerConnection = { APPLICATION_NAME: 'audit-test' }
    client.createDatabaseClient({
      connectionString: LOCAL_DATABASE_URL,
      capability: 'readonly_audit',
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
      postgresOptions: { connection: callerConnection } as never,
    })
    expect(Object.keys(callerConnection)).toEqual(['APPLICATION_NAME'])
  })

  it('a safe caller connection key reaches the driver alongside the protected read-only flag', () => {
    // Reaudit gap (connection merge order): proves the ACTUAL object handed to
    // postgres() preserves a caller-supplied safe key AND ends with the
    // protected flag on — not just that the policy table says `readOnly: true`.
    const created = client.createDatabaseClient({
      connectionString: LOCAL_DATABASE_URL,
      capability: 'readonly_audit',
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
      postgresOptions: { connection: { application_name: 'audit-test' } } as never,
    })
    expect(created.decision.readOnly).toBe(true)
    const connection = spies.postgresOptions.at(-1)?.connection as Record<string, unknown>
    expect(connection?.application_name).toBe('audit-test')
    expect(connection?.default_transaction_read_only).toBe('on')
  })

  it('a controlled remote capability pins VERIFIED TLS, where the URL cannot undo it', () => {
    // postgres-js defaults to `ssl: false` and honours `?sslmode=disable`, so
    // without pinning, a controlled remote read against production could run
    // in cleartext while the guard reported the target as clean.
    //
    // It must be `verify-full`, NOT `require`: in postgres-js,
    // `require`/`allow`/`prefer` set `rejectUnauthorized = false`, i.e.
    // encryption with no server authentication — which an on-path attacker
    // defeats by presenting any certificate.
    client.createDatabaseClient({
      connectionString: `postgresql://postgres.projectref123:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=disable`,
      capability: 'controlled_remote_read',
      environment: 'production',
      expectedProjectId: 'projectref123',
      env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read' },
    })
    expect(spies.postgresOptions.at(-1)?.ssl).toBe('verify-full')
    expect(spies.postgresOptions.at(-1)?.ssl).not.toBe('require')
  })

  it('does not replace a caller-supplied ssl OBJECT — that would weaken it', () => {
    // A private CA can only be supplied as an object. Overriding it with the
    // string pin would turn a verified configuration into a weaker one.
    const callerSsl = { rejectUnauthorized: true, ca: 'PEM' }
    client.createDatabaseClient({
      connectionString: `postgresql://postgres.projectref123:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
      capability: 'controlled_remote_read',
      environment: 'production',
      expectedProjectId: 'projectref123',
      env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read' },
      postgresOptions: { ssl: callerSsl } as never,
    })
    expect(spies.postgresOptions.at(-1)?.ssl).toEqual(callerSsl)
  })

  it.each([
    ['false (plaintext)', false],
    ['"require" (unauthenticated)', 'require'],
    ['an object with verification off', { rejectUnauthorized: false }],
  ])('refuses a caller ssl of %s for a capability that requires TLS', (_label, callerSsl) => {
    // `?? 'verify-full'` alone only guarded nullish, so any of these won —
    // and the audit line still said `tls=verified`. ssl may be RAISED, never
    // lowered.
    expect(() =>
      client.createDatabaseClient({
        connectionString: `postgresql://postgres.projectref123:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
        capability: 'controlled_remote_read',
        environment: 'production',
        expectedProjectId: 'projectref123',
        env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read' },
        postgresOptions: { ssl: callerSsl } as never,
      })
    ).toThrow(/requires verified TLS/)
    expect(spies.postgresCalls).toHaveLength(0)
  })

  it('sslrootcert reaching postgresOptions.connection never influences the pinned TLS decision', () => {
    // Reaudit gap (sslrootcert): verified empirically against the installed
    // postgres@3.4.9 (node_modules/postgres/src/connection.js `secure()`) that
    // TLS is built ONLY from the top-level `ssl` option — `sslrootcert` is
    // never read there, in any form. This pins that invariant so a future
    // change that started reading it for certificate material would have to
    // break this test first.
    client.createDatabaseClient({
      connectionString: `postgresql://postgres.projectref123:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
      capability: 'controlled_remote_read',
      environment: 'production',
      expectedProjectId: 'projectref123',
      env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read' },
      postgresOptions: { connection: { sslrootcert: 'attacker-supplied-path-or-pem' } } as never,
    })
    expect(spies.postgresOptions.at(-1)?.ssl).toBe('verify-full')
    const connection = spies.postgresOptions.at(-1)?.connection as Record<string, unknown>
    // Forwarded like any other connection key the driver does not special-case
    // for TLS — present, but inert for certificate verification.
    expect(connection?.sslrootcert).toBe('attacker-supplied-path-or-pem')
  })

  it('the audit line names forwarded URL parameters, without their values', () => {
    const created = client.createDatabaseClient({
      connectionString: `${FAKE_REMOTE_URL}?options=reference%3Dprojectref123&application_name=uellix`,
      capability: 'app_runtime',
      environment: 'production',
      env: {},
    })
    expect(created.decision.auditLine).toContain('urlParams=[options,application_name]')
    expect(created.decision.auditLine).not.toContain('projectref123')
    expect(created.decision.auditLine).not.toContain('uellix')
  })

  it('a parameter name shaped like a hostname is not echoed into the audit line', () => {
    const created = client.createDatabaseClient({
      connectionString: `${FAKE_REMOTE_URL}?db.projectref123.supabase.co=1`,
      capability: 'app_runtime',
      environment: 'production',
      env: {},
    })
    expect(created.decision.auditLine).toContain('urlParams=[(unnamed)]')
    expect(created.decision.auditLine).not.toContain('projectref123')
  })

  it('the audit line says "verified", not something that merely sounds strong', () => {
    const created = client.createDatabaseClient({
      connectionString: `postgresql://postgres.projectref123:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
      capability: 'controlled_remote_read',
      environment: 'production',
      expectedProjectId: 'projectref123',
      env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read' },
    })
    expect(created.decision.auditLine).toContain('tls=verified')
  })

  it('app_runtime does not have its TLS posture changed by this layer', () => {
    client.createDatabaseClient({
      connectionString: FAKE_REMOTE_URL,
      capability: 'app_runtime',
      environment: 'production',
      env: {},
    })
    expect(spies.postgresOptions.at(-1)?.ssl).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* 2a. Connection merge order — structural, independent of the earlier guard  */
/* -------------------------------------------------------------------------- */

describe('mergeGuardedConnectionOptions — the protected key always wins', () => {
  // Reaudit gap (connection merge order): `createDatabaseClient` already
  // refuses a caller who supplies `default_transaction_read_only` directly in
  // `postgresOptions.connection` (see GUARD_OWNED_CONNECTION_KEYS above), so
  // that value can never reach the merge in today's call graph. That refusal
  // is a SEPARATE layer from the merge order itself — defense in depth only
  // works if both layers are independently correct. This suite calls the
  // merge function directly, bypassing that earlier refusal entirely, so it
  // fails if the spread order in db/client.ts is ever inverted, regardless of
  // whether the upstream guard still exists.
  it('places the protected read-only flag AFTER the caller connection, so it cannot be overridden', () => {
    const merged = mergeGuardedConnectionOptions(
      { application_name: 'audit-test', default_transaction_read_only: 'off' },
      true
    )
    expect(merged.application_name).toBe('audit-test')
    expect(merged.default_transaction_read_only).toBe('on')
  })

  it('preserves every other caller-supplied key untouched', () => {
    const merged = mergeGuardedConnectionOptions(
      { application_name: 'audit-test', statement_timeout: '5000' },
      true
    )
    expect(merged).toEqual({
      application_name: 'audit-test',
      statement_timeout: '5000',
      default_transaction_read_only: 'on',
    })
  })

  it('adds no read-only key at all when the capability is not read-only', () => {
    const merged = mergeGuardedConnectionOptions({ application_name: 'seed' }, false)
    expect(merged).toEqual({ application_name: 'seed' })
    expect('default_transaction_read_only' in merged).toBe(false)
  })

  it('tolerates an undefined caller connection', () => {
    expect(mergeGuardedConnectionOptions(undefined, true)).toEqual({
      default_transaction_read_only: 'on',
    })
    expect(mergeGuardedConnectionOptions(undefined, false)).toEqual({})
  })

  it('does not mutate the caller-supplied object', () => {
    const callerConnection = { default_transaction_read_only: 'off' }
    mergeGuardedConnectionOptions(callerConnection, true)
    expect(callerConnection.default_transaction_read_only).toBe('off')
  })
})

/* -------------------------------------------------------------------------- */
/* 2b. Post-guard driver errors must not undo the redaction                   */
/* -------------------------------------------------------------------------- */

describe('describeError — the first failure AFTER the guard is redacted too', () => {
  // MAJOR found in adversarial review: postgres-js builds connection failures
  // as `'write ' + code + ' ' + host + ':' + port` and attaches `address`, so
  // a script doing `console.error('Failed:', err)` printed the full remote
  // host — and the Supabase project ref — despite every guard message being
  // careful not to.
  it('reduces a driver connection error to a code and a redacted host', () => {
    const driverError = Object.assign(
      new Error('write ECONNREFUSED db.projectref123.supabase.co:5432'),
      { code: 'ECONNREFUSED', address: 'db.projectref123.supabase.co', port: 5432 }
    )
    const rendered = describeError(driverError)
    expect(rendered).not.toContain('projectref123')
    expect(rendered).toContain('***.supabase.co')
    expect(rendered).toContain('ECONNREFUSED')
  })

  it('handles the ACTUAL shape postgres-js builds, where `address` is an ARRAY', () => {
    // src/errors.js: `address: options.path || host`, and `options.host` is an
    // array. A `typeof === 'string'` check never matched a real driver error,
    // so the whole path silently depended on the errno list instead.
    const real = Object.assign(new Error('write ECONNREFUSED db.projectref123.supabase.co:5432'), {
      code: 'ECONNREFUSED',
      errno: 'ECONNREFUSED',
      address: ['db.projectref123.supabase.co'],
      port: [5432],
    })
    const rendered = describeError(real)
    expect(rendered).not.toContain('projectref123')
    expect(rendered).toContain('***.supabase.co')
    expect(rendered).toContain('5432')
  })

  it('withholds the message for a network errno that is NOT in the known list', () => {
    const unlisted = Object.assign(new Error('connect EACCES db-prod.acme.xyz:5432'), {
      code: 'EACCES',
      errno: -13,
    })
    expect(describeError(unlisted)).not.toContain('acme.xyz')
  })

  it('does NOT claim a network failure for an ordinary syscall error', () => {
    // Every Node syscall error carries `errno`; treating that alone as
    // "network" reported a missing fixture file as a connection problem.
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
      errno: -2,
    })
    expect(describeError(enoent)).not.toContain('network failure')
  })

  it('searches `errors[]` even when `cause` is present', () => {
    const aggregate = Object.assign(new AggregateError([], 'all failed'), {
      cause: new Error('no host here'),
      errors: [Object.assign(new Error('x'), { address: 'db.projectref123.supabase.co', port: 5432 })],
    })
    expect(describeError(aggregate)).toContain('***.supabase.co')
  })

  it('never prints the SQL or the bound parameters of an ORM query error', () => {
    // DrizzleQueryError's own message is `Failed query: <sql>\nparams: <...>`.
    // It carries no address and no errno, so it used to fall through to the
    // generic branch — and bound parameters routinely contain personal data.
    const drizzleError = Object.assign(
      new Error("Failed query: select * from users where email = $1\nparams: person@example.org"),
      {
        query: 'select * from users where email = $1',
        params: ['person@example.org'],
        cause: Object.assign(new Error('permission denied for table users'), { code: '42501' }),
      }
    )
    const rendered = describeError(drizzleError)
    expect(rendered).not.toContain('person@example.org')
    expect(rendered).not.toContain('select * from users')
    expect(rendered).toContain('42501')
    expect(rendered).toContain('permission denied')
  })

  it('holds an ORM wrapper\'s cause to the SAME rules, not just its own message', () => {
    // A TLS or DNS failure surfaces on the first query and therefore arrives
    // wrapped. Reading the cause's message directly leaked the host that the
    // top-level branches take care to withhold.
    const wrapped = Object.assign(new Error('Failed query: select 1\nparams: '), {
      query: 'select 1',
      params: [],
      cause: Object.assign(
        new Error("Host: ep-abc-123.eu-central-1.example.tech. is not in the cert's altnames"),
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
      ),
    })
    const rendered = describeError(wrapped)
    expect(rendered).not.toContain('example.tech')
    expect(rendered).toContain('ERR_TLS_CERT_ALTNAME_INVALID')
  })

  it('unwraps a nested ORM wrapper instead of printing the inner SQL', () => {
    const inner = Object.assign(new Error('Failed query: select * from users where email = $1'), {
      query: 'select * from users where email = $1',
      params: ['person@example.org'],
      cause: Object.assign(new Error('permission denied'), { code: '42501' }),
    })
    const outer = Object.assign(new Error('Failed query: outer'), {
      query: 'outer',
      params: [],
      cause: inner,
    })
    const rendered = describeError(outer)
    expect(rendered).not.toContain('person@example.org')
    expect(rendered).not.toContain('select * from users')
    expect(rendered).toContain('42501')
  })

  it('keeps our own explanatory messages readable', () => {
    const ours = Object.assign(new Error('restriction applied too late; explain at length'), {
      code: 'DB_RESTRICTION_TOO_LATE',
    })
    expect(describeError(ours)).toContain('explain at length')
  })

  it('finds the address nested under `cause`, as fetch failures carry it', () => {
    // The Supabase client surfaces a network failure as
    // `TypeError: fetch failed` with the real ECONNREFUSED underneath.
    const nested = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
        address: 'projectref123.supabase.co',
        port: 443,
      }),
    })
    const rendered = describeError(nested)
    expect(rendered).not.toContain('projectref123')
    expect(rendered).toContain('***.supabase.co')
  })

  it('drops the message entirely for a network errno, whatever the TLD', () => {
    // A DNS failure carries `hostname`, not `address`, and its message is
    // BUILT from the host — so pattern-scrubbing it can never be exhaustive
    // (it cannot know every TLD). These are withheld instead.
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND ep-abc.example.tech'), {
      code: 'ENOTFOUND',
    })
    expect(describeError(dns)).not.toContain('example.tech')
    expect(describeError(dns)).toContain('ENOTFOUND')

    const v6 = Object.assign(new Error('connect ECONNREFUSED 2606:4700:4700::1111'), {
      code: 'ECONNREFUSED',
    })
    expect(describeError(v6)).not.toContain('2606:4700')
  })

  it('uses `hostname` when the error exposes that instead of `address`', () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
      hostname: 'db.projectref123.supabase.co',
    })
    const rendered = describeError(dns)
    expect(rendered).not.toContain('projectref123')
    expect(rendered).toContain('***.supabase.co')
  })

  it('scrubs a host embedded in free text, without mangling Postgres messages', () => {
    expect(describeError(new Error('request to https://projectref123.supabase.co/auth failed'))).not.toContain(
      'projectref123'
    )
    // A table reference is not a hostname; server errors must stay readable.
    const serverError = Object.assign(new Error('permission denied for table public.users'), {
      code: '42501',
    })
    expect(describeError(serverError)).toBe('[42501] permission denied for table public.users')
  })

  it('passes our own typed guard errors through unchanged', () => {
    const error = (() => {
      try {
        assertDatabaseOperationAllowed({
          url: FAKE_REMOTE_URL,
          capability: 'local_seed',
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
        })
      } catch (caught) {
        return caught
      }
      throw new Error('expected a refusal')
    })()
    expect(describeError(error)).toContain('DB_OPERATION_NOT_ALLOWED')
  })

  it.each(SEED_AND_FIXTURE_SCRIPTS)('%s routes its catch-all through describeError', (relative) => {
    const source = code(relative)
    expect(source).toMatch(/describeError\(/)
    // The raw-error prints that leaked the host are gone.
    expect(source).not.toMatch(/console\.error\((?:'[^']*',\s*)?err\)/)
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Dotenv regression                                                       */
/* -------------------------------------------------------------------------- */

describe('regression: a remote URL in .env can no longer steer a local seed', () => {
  // The historical incident: fixture scripts resolved DATABASE_URL through
  // `dotenv/config`. dotenv does not override an already-exported variable,
  // so whether a seed hit the laptop or a managed database depended on
  // whether the operator remembered to export first. The connection string
  // and password from that incident are NOT reproduced here — the scenario is
  // reconstructed with a fictional remote URL.
  let dir: string
  let envFile: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'uellix-dotenv-'))
    envFile = path.join(dir, '.env')
    writeFileSync(envFile, `DATABASE_URL=${FAKE_REMOTE_URL}\n`, 'utf8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('dotenv still injects the remote URL — the hazard is real, not hypothetical', () => {
    const env = {} as NodeJS.ProcessEnv
    dotenv.config({ path: envFile, processEnv: env })
    expect(env.DATABASE_URL).toBe(FAKE_REMOTE_URL)
  })

  it('an exported local URL survives dotenv — but only by luck, which is the point', () => {
    const env = { DATABASE_URL: LOCAL_DATABASE_URL } as unknown as NodeJS.ProcessEnv
    dotenv.config({ path: envFile, processEnv: env })
    expect(env.DATABASE_URL).toBe(LOCAL_DATABASE_URL)
  })

  it('local resolution ignores the dotenv-injected URL entirely', () => {
    const env = {} as NodeJS.ProcessEnv
    dotenv.config({ path: envFile, processEnv: env })

    const resolved = resolveLocalDatabaseUrl(env, { expectedLocalPort: LOCAL_DB_PORT })
    expect(resolved.url).toBe(LOCAL_DATABASE_URL)
    expect(resolved.source).toBe('pinned_local_stack')
    expect(resolved.warnings.join(' ')).toContain('IGNORED')
  })

  it('and even if a seed did read it, the capability guard refuses it', () => {
    const env = {} as NodeJS.ProcessEnv
    dotenv.config({ path: envFile, processEnv: env })

    const error = (() => {
      try {
        assertDatabaseOperationAllowed({
          url: env.DATABASE_URL,
          capability: 'local_seed',
          environment: 'development',
          expectedLocalPort: LOCAL_DB_PORT,
          env,
        })
      } catch (caught) {
        return caught as DatabaseSafetyError
      }
      throw new Error('expected the seed target to be refused')
    })()

    expect(error.code).toBe('DB_OPERATION_NOT_ALLOWED')
    expect(error.message).not.toContain('nOt-a-ReAl-p4ssw0rd')
    expect(error.message).not.toContain('projectref123')
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Child processes — real scripts, refusal paths only                      */
/* -------------------------------------------------------------------------- */

interface RunResult {
  status: number | null
  output: string
}

function runScript(relativeScript: string, env: Record<string, string>, args: string[] = []): RunResult {
  const result = spawnSync(process.execPath, [TSX_CLI, path.join(ROOT, relativeScript), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('child processes: dangerous scripts abort before connecting', () => {
  it(
    'seed-proxies refuses a remote local-override and never reaches the database',
    () => {
      const result = runScript('scripts/seed-proxies.ts', {
        UELLIX_LOCAL_DATABASE_URL: FAKE_REMOTE_URL,
      })
      expect(result.status).toBe(1)
      expect(result.output).toMatch(/does not point at a local stack|local_seed/)
      expect(result.output).not.toContain('Created source')
      expect(result.output).not.toContain('nOt-a-ReAl-p4ssw0rd')
    },
    60_000
  )

  it(
    'seed-taxonomies refuses a remote local-override',
    () => {
      const result = runScript('scripts/seed-taxonomies.ts', {
        UELLIX_LOCAL_DATABASE_URL: FAKE_REMOTE_URL,
      })
      expect(result.status).toBe(1)
      expect(result.output).not.toMatch(/codes upserted/)
    },
    60_000
  )

  it(
    'seed scripts also refuse a local override on another stack\'s port',
    () => {
      const result = runScript('scripts/seed-proxies.ts', {
        UELLIX_LOCAL_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
      })
      expect(result.status).toBe(1)
      expect(result.output).toMatch(/port/)
    },
    60_000
  )

  it(
    'create-test-user refuses a remote Supabase API and never creates a user',
    () => {
      const result = runScript(
        'scripts/create-test-user.ts',
        {
          NEXT_PUBLIC_SUPABASE_URL: FAKE_REMOTE_API_URL,
          SUPABASE_SERVICE_ROLE_KEY: 'fake-key-for-refusal-path',
        },
        ['someone@test.local', 'irrelevant']
      )
      expect(result.status).toBe(1)
      expect(result.output).not.toMatch(/User created successfully/)
      expect(result.output).not.toContain('projectref123')
    },
    60_000
  )

  it(
    'the local reset guard refuses without an exact confirmation',
    () => {
      const result = runScript('scripts/guard-local-reset.ts', {
        UELLIX_DB_LOCAL_RESET_CONFIRM: 'yes',
      })
      expect(result.status).toBe(1)
      expect(result.output).toMatch(/LOCAL RESET REFUSED/)
    },
    60_000
  )

  it(
    'the blocked aliases fail loudly and name their replacement',
    () => {
      const result = runScript('scripts/blocked-command.ts', {}, [
        'db:seed:proxies',
        'db:seed:local:proxies',
      ])
      expect(result.status).toBe(1)
      expect(result.output).toMatch(/BLOCKED COMMAND/)
      expect(result.output).toMatch(/db:seed:local:proxies/)
    },
    60_000
  )
})
