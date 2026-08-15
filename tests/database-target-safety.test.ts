// tests/database-target-safety.test.ts
//
// Unit coverage for the database access safety layer (db/safety/*).
//
// Fully offline: classification and authorization never open a connection, so
// nothing here touches a database. Every URL below is fictional — RFC 5737 /
// RFC 3849 documentation ranges, example.com, and an invented Supabase
// project reference. No real host, credential or project id appears.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  classifyDatabaseTarget,
  classifySupabaseApiTarget,
  isLocalTarget,
  redactHost,
} from '@/db/safety/database-target'
import {
  assertDatabaseOperationAllowed,
  CAPABILITY_POLICIES,
  DatabaseSafetyError,
  resolveEnvironment,
  type DatabaseCapability,
} from '@/db/safety/database-access'
import {
  LOCAL_API_PORT,
  LOCAL_DATABASE_URL,
  LOCAL_DB_PORT,
  LOCAL_PROJECT_ID,
  LOCAL_RESET_CONFIRMATION,
} from '@/db/safety/local-stack'
import {
  LOCAL_DATABASE_URL_ENV_VAR,
  LocalDatabaseUrlResolutionError,
  resolveLocalDatabaseUrl,
} from '@/db/safety/resolve-local-database-url'

/* -------------------------------------------------------------------------- */
/* Fictional fixtures                                                         */
/* -------------------------------------------------------------------------- */

const FAKE_PASSWORD = 'nOt-a-ReAl-p4ssw0rd'
const FAKE_USER = 'seeduser'
const FAKE_PROJECT_REF = 'projectref123'
const REMOTE_HOST = `db.${FAKE_PROJECT_REF}.supabase.co`

const pg = (host: string, port?: number, extra = '', user = FAKE_USER) =>
  `postgresql://${user}:${FAKE_PASSWORD}@${host}${port ? `:${port}` : ''}/postgres${extra}`

const LOCAL_OK = pg('127.0.0.1', LOCAL_DB_PORT)
const REMOTE_SUPABASE = pg(REMOTE_HOST, 5432)
const CONTAINER_HOSTS = ['supabase_db_rehearsal'] as const

/* -------------------------------------------------------------------------- */
/* Pinned constants vs supabase/config.toml                                   */
/* -------------------------------------------------------------------------- */

describe('local-stack constants match supabase/config.toml', () => {
  const configToml = readFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8')

  const sectionPort = (section: string): number => {
    const body = configToml.split(`[${section}]`)[1] ?? ''
    const match = /^port\s*=\s*(\d+)/m.exec(body.split('\n[')[0])
    return Number(match?.[1])
  }

  it('pins the project id declared by the Supabase CLI', () => {
    expect(configToml).toMatch(new RegExp(`project_id\\s*=\\s*"${LOCAL_PROJECT_ID}"`))
  })

  it('pins the db port', () => {
    expect(sectionPort('db')).toBe(LOCAL_DB_PORT)
  })

  it('pins the api port', () => {
    expect(sectionPort('api')).toBe(LOCAL_API_PORT)
  })

  it('the pinned URL is loopback and carries the pinned port', () => {
    const target = classifyDatabaseTarget(LOCAL_DATABASE_URL)
    expect(target.kind).toBe('local_loopback')
    expect(target.port).toBe(LOCAL_DB_PORT)
  })
})

/* -------------------------------------------------------------------------- */
/* Classification — local                                                     */
/* -------------------------------------------------------------------------- */

describe('classifyDatabaseTarget — local targets', () => {
  it.each([
    ['localhost', pg('localhost', LOCAL_DB_PORT)],
    ['127.0.0.1', pg('127.0.0.1', LOCAL_DB_PORT)],
    ['127.0.0.2 (all of 127.0.0.0/8)', pg('127.0.0.2', LOCAL_DB_PORT)],
    ['::1', pg('[::1]', LOCAL_DB_PORT)],
    ['0:0:0:0:0:0:0:1', pg('[0:0:0:0:0:0:0:1]', LOCAL_DB_PORT)],
  ])('classifies %s as local_loopback', (_label, url) => {
    const target = classifyDatabaseTarget(url)
    expect(target.kind).toBe('local_loopback')
    expect(isLocalTarget(target)).toBe(true)
  })

  it('classifies an allow-listed container hostname as local_container', () => {
    const target = classifyDatabaseTarget(pg('supabase_db_rehearsal', 5432), {
      containerHosts: CONTAINER_HOSTS,
    })
    expect(target.kind).toBe('local_container')
    expect(isLocalTarget(target)).toBe(true)
  })

  it('does NOT treat an un-listed container hostname as local', () => {
    const target = classifyDatabaseTarget(pg('supabase_db_rehearsal', 5432))
    expect(target.kind).toBe('unknown')
    expect(isLocalTarget(target)).toBe(false)
  })

  it('records the port, and records null when the URL omits one', () => {
    expect(classifyDatabaseTarget(pg('127.0.0.1', LOCAL_DB_PORT)).port).toBe(LOCAL_DB_PORT)
    expect(classifyDatabaseTarget(pg('127.0.0.1')).port).toBeNull()
  })

  it('lowercases an opaque host, which WHATWG parsing leaves in its original case', () => {
    // Non-special schemes keep the host verbatim: `new URL(...).hostname` is
    // literally "LOCALHOST" here. A naive `=== 'localhost'` check would miss it.
    const target = classifyDatabaseTarget(
      `POSTGRESQL://${FAKE_USER}:${FAKE_PASSWORD}@LOCALHOST:${LOCAL_DB_PORT}/postgres`
    )
    expect(target.kind).toBe('local_loopback')
    expect(target.hostname).toBe('localhost')
  })
})

/* -------------------------------------------------------------------------- */
/* Classification — remote and adversarial                                    */
/* -------------------------------------------------------------------------- */

describe('classifyDatabaseTarget — remote and private targets', () => {
  it('classifies a Supabase host as managed_remote and detects the provider', () => {
    const target = classifyDatabaseTarget(REMOTE_SUPABASE)
    expect(target.kind).toBe('managed_remote')
    expect(target.provider).toBe('supabase')
    expect(target.projectRef).toBe(FAKE_PROJECT_REF)
  })

  it('classifies an arbitrary public domain as managed_remote', () => {
    expect(classifyDatabaseTarget(pg('db.example.com', 5432)).kind).toBe('managed_remote')
  })

  it('classifies a public IPv4 as managed_remote', () => {
    expect(classifyDatabaseTarget(pg('203.0.113.10', 5432)).kind).toBe('managed_remote')
  })

  it('classifies a public IPv6 as managed_remote', () => {
    expect(classifyDatabaseTarget(pg('[2001:db8::1]', 5432)).kind).toBe('managed_remote')
  })

  it.each([
    ['10.0.0.5', pg('10.0.0.5', 5432)],
    ['172.16.4.9', pg('172.16.4.9', 5432)],
    ['192.168.1.20', pg('192.168.1.20', 5432)],
    ['169.254.10.1 (link-local)', pg('169.254.10.1', 5432)],
    ['100.64.0.1 (CGNAT)', pg('100.64.0.1', 5432)],
    ['fd00::1 (IPv6 ULA)', pg('[fd00::1]', 5432)],
    ['fe80::1 (IPv6 link-local)', pg('[fe80::1]', 5432)],
  ])('classifies %s as private_network — private is NOT authorised', (_label, url) => {
    const target = classifyDatabaseTarget(url)
    expect(target.kind).toBe('private_network')
    expect(isLocalTarget(target)).toBe(false)
  })

  it('normalises a fully-qualified trailing dot instead of failing closed on it', () => {
    // `db.<ref>.supabase.co.` resolves to the same host. Dropping it into
    // `unknown` would make app_runtime refuse a legitimate production URL.
    const target = classifyDatabaseTarget(pg(`${REMOTE_HOST}.`, 5432))
    expect(target.kind).toBe('managed_remote')
    expect(target.hostname).toBe(REMOTE_HOST)
  })

  it('accepts underscores in a remote hostname rather than failing closed', () => {
    // Only ever moves a host from `unknown` to `managed_remote` — still
    // refused by every local capability, so local safety is unchanged.
    expect(classifyDatabaseTarget(pg('my_db.example.com', 5432)).kind).toBe('managed_remote')
  })

  it('a trailing dot on a local hostname is still local', () => {
    expect(classifyDatabaseTarget(pg('localhost.', LOCAL_DB_PORT)).kind).toBe('local_loopback')
  })

  it('is not fooled by a hostname that merely starts with "localhost"', () => {
    const target = classifyDatabaseTarget(pg('localhost.example.com', 5432))
    expect(target.kind).toBe('managed_remote')
  })

  it('is not fooled by a USERNAME called localhost', () => {
    const target = classifyDatabaseTarget(pg(REMOTE_HOST, 5432, '', 'localhost'))
    expect(target.kind).toBe('managed_remote')
    expect(target.hostname).toBe(REMOTE_HOST)
  })

  it('is not fooled by a query parameter containing a loopback address', () => {
    const target = classifyDatabaseTarget(pg(REMOTE_HOST, 5432, '?host=127.0.0.1&sslmode=require'))
    expect(target.kind).toBe('managed_remote')
  })

  it('is not fooled by a fragment containing a loopback address', () => {
    const target = classifyDatabaseTarget(pg(REMOTE_HOST, 5432, '#127.0.0.1'))
    expect(target.kind).toBe('managed_remote')
  })

  it('refuses a multihost authority: the driver dials the FIRST host, we classify the last', () => {
    // BLOCKER found in adversarial review, verified against postgres@3.4.9.
    // `new URL()` ends userinfo at the LAST `@` (giving 127.0.0.1:56322, which
    // every local capability would accept); postgres-js re-parses the raw
    // string with indexOf('@') and treats the comma as a MULTIHOST list, so
    // its first socket goes to the remote host.
    const target = classifyDatabaseTarget(
      `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@${REMOTE_HOST}:5432,127.0.0.1@127.0.0.1:${LOCAL_DB_PORT}/postgres`
    )
    expect(target.kind).toBe('unknown')
    expect(target.reason).toBe('ambiguous_authority')
  })

  it('refuses a shorter multihost form', () => {
    const target = classifyDatabaseTarget(
      `postgresql://a@evil.example.com,x@127.0.0.1:${LOCAL_DB_PORT}/postgres`
    )
    expect(target.kind).toBe('unknown')
    expect(target.reason).toBe('ambiguous_authority')
  })

  it('refuses a "#" in the authority — URL calls it a fragment, the driver does not', () => {
    // Round-2 BLOCKER: the first fix cut the authority at `[/?#]` while
    // postgres-js cuts at `[?/]` only, so one character restored the bypass.
    // Guard saw 127.0.0.1:56322; driver dialled evil.example.com first.
    const target = classifyDatabaseTarget(
      // secret-scan-ok: a port number and a '#' — the parser disagreement under test, not a credential.
      `postgresql://127.0.0.1:${LOCAL_DB_PORT}#@evil.example.com,127.0.0.1/postgres`
    )
    expect(target.kind).toBe('unknown')
    expect(target.reason).toBe('ambiguous_authority')
  })

  it.each([
    ['comma-only form', `postgresql://127.0.0.1:${LOCAL_DB_PORT}#,evil.example.com/db`],
    ['uppercase scheme', `POSTGRESQL://127.0.0.1:${LOCAL_DB_PORT}#@evil.example.com,127.0.0.1/db`],
    // secret-scan-ok: a port number and a '#' in both rows below, not credentials.
    ['surrounding whitespace', `  postgresql://127.0.0.1:${LOCAL_DB_PORT}#@evil.example.com,127.0.0.1/db  `],
    // secret-scan-ok: a port number and a '#', not a credential.
    ['bracketed IPv6', `postgresql://[::1]:${LOCAL_DB_PORT}#@evil.example.com,127.0.0.1/db`],
  ])('refuses the "#" bypass variant: %s', (_label, url) => {
    expect(classifyDatabaseTarget(url).kind).toBe('unknown')
  })

  it('refuses an authority with a second "@", where WHATWG and the driver disagree', () => {
    const target = classifyDatabaseTarget(
      `postgresql://user@${REMOTE_HOST}@127.0.0.1:${LOCAL_DB_PORT}/postgres`
    )
    expect(target.kind).toBe('unknown')
    expect(target.reason).toBe('ambiguous_authority')
  })

  it('the multihost bypass is refused by every local capability', () => {
    const bypass = `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@${REMOTE_HOST}:5432,127.0.0.1@127.0.0.1:${LOCAL_DB_PORT}/postgres`
    for (const capability of LOCAL_ONLY_CAPABILITIES) {
      const error = capture(() =>
        assertDatabaseOperationAllowed({
          url: bypass,
          capability,
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
        })
      )
      expect(error.code).toBe('DB_TARGET_UNKNOWN')
    }
  })

  it('refuses to decode a percent-encoded host instead of guessing', () => {
    // The driver runs decodeURIComponent over the host and we deliberately do
    // not, so the authority check catches this before the host-level `%` check
    // does. Both land on `unknown`; what matters is that neither guesses.
    const target = classifyDatabaseTarget(
      `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1%2eevil.example.com:5432/db`
    )
    expect(target.kind).toBe('unknown')
    expect(['ambiguous_authority', 'percent_encoded_host']).toContain(target.reason)
  })

  it('refuses a percent-encoded spelling of localhost', () => {
    const target = classifyDatabaseTarget(
      `postgresql://${FAKE_USER}@%6c%6f%63%61%6c%68%6f%73%74:${LOCAL_DB_PORT}/db`
    )
    expect(target.kind).toBe('unknown')
    expect(['ambiguous_authority', 'percent_encoded_host']).toContain(target.reason)
  })

  it('refuses ambiguous octal-looking IPv4 octets', () => {
    const target = classifyDatabaseTarget(pg('127.0.0.01', LOCAL_DB_PORT))
    expect(target.kind).toBe('unknown')
    expect(target.reason).toBe('ambiguous_ipv4_octets')
  })

  it('refuses the wildcard address and IPv4-mapped IPv6', () => {
    expect(classifyDatabaseTarget(pg('0.0.0.0', LOCAL_DB_PORT)).kind).toBe('unknown')
    expect(classifyDatabaseTarget(pg('[::ffff:127.0.0.1]', LOCAL_DB_PORT)).kind).toBe('unknown')
  })
})

describe('classifyDatabaseTarget — invalid input', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('classifies %s as invalid/missing', (_label, url) => {
    const target = classifyDatabaseTarget(url)
    expect(target.kind).toBe('invalid')
    expect(target.reason).toBe('missing')
  })

  it('classifies an unparseable string as invalid', () => {
    expect(classifyDatabaseTarget('not a url').reason).toBe('unparseable')
  })

  it('classifies a URL with no protocol as invalid', () => {
    // `localhost:5432/postgres` parses with the scheme "localhost:" and an
    // EMPTY host — the exact shape that a substring check would call local.
    const target = classifyDatabaseTarget('localhost:5432/postgres')
    expect(target.kind).toBe('invalid')
  })

  it('classifies a non-postgres scheme as invalid', () => {
    expect(classifyDatabaseTarget('https://127.0.0.1:56322/postgres').reason).toBe(
      'unsupported_scheme'
    )
  })

  it('classifies a hostless (unix socket) URL as invalid', () => {
    expect(classifyDatabaseTarget('postgresql:///var/run/postgresql').reason).toBe('no_hostname')
  })
})

describe('classifySupabaseApiTarget', () => {
  it('accepts http/https and classifies the loopback API as local', () => {
    expect(classifySupabaseApiTarget(`http://127.0.0.1:${LOCAL_API_PORT}`).kind).toBe(
      'local_loopback'
    )
  })

  it('classifies a hosted Supabase API as managed_remote with its project ref', () => {
    const target = classifySupabaseApiTarget(`https://${FAKE_PROJECT_REF}.supabase.co`)
    expect(target.kind).toBe('managed_remote')
    expect(target.projectRef).toBe(FAKE_PROJECT_REF)
  })

  it('rejects a postgres URL', () => {
    expect(classifySupabaseApiTarget(LOCAL_OK).reason).toBe('unsupported_scheme')
  })
})

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

describe('redactHost', () => {
  it('passes loopback through verbatim — it identifies nothing', () => {
    expect(redactHost('127.0.0.1')).toBe('127.0.0.1')
    expect(redactHost('localhost')).toBe('localhost')
    expect(redactHost('::1')).toBe('::1')
  })

  it('never reveals a Supabase project reference', () => {
    const redacted = redactHost(REMOTE_HOST)
    expect(redacted).toBe('***.supabase.co')
    expect(redacted).not.toContain(FAKE_PROJECT_REF)
  })

  it('never returns a registrable domain verbatim, even with only two labels', () => {
    // Regression: keeping the last two labels returned `acme-prod.com`
    // unchanged, leaking an organisation-identifying domain into error
    // messages, audit lines and committed run reports.
    expect(redactHost('acme-prod.com')).toBe('***.com')
    expect(redactHost('internal.acme-prod.io')).toBe('***.io')
  })

  it('keeps a known managed-provider suffix — it names a service, not a customer', () => {
    expect(redactHost('aws-0-us-east-1.pooler.supabase.com')).toBe('***.supabase.com')
  })

  it('masks the host-identifying octets of public and private IPv4', () => {
    expect(redactHost('203.0.113.10')).toBe('203.0.x.x')
    expect(redactHost('10.1.2.3')).toBe('10.1.x.x')
  })

  it('masks all but the leading hextet of IPv6', () => {
    expect(redactHost('2001:db8::1')).toBe('2001:***')
  })

  it('handles a missing host', () => {
    expect(redactHost(null)).toBe('(no host)')
  })
})

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

const LOCAL_ONLY_CAPABILITIES = [
  'local_seed',
  'local_integration_test',
  'local_migration',
  'readonly_audit',
] as const satisfies readonly DatabaseCapability[]

describe('capabilities — local-only capabilities never reach a remote target', () => {
  it.each([...LOCAL_ONLY_CAPABILITIES])('%s accepts the local stack', (capability) => {
    const decision = assertDatabaseOperationAllowed({
      url: LOCAL_OK,
      capability,
      environment: 'test',
      expectedLocalPort: LOCAL_DB_PORT,
      env: {},
    })
    expect(decision.targetKind).toBe('local_loopback')
  })

  it.each([...LOCAL_ONLY_CAPABILITIES])('%s refuses a managed remote target', (capability) => {
    expect(() =>
      assertDatabaseOperationAllowed({
        url: REMOTE_SUPABASE,
        capability,
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    ).toThrow(DatabaseSafetyError)
  })

  it.each([...LOCAL_ONLY_CAPABILITIES])('%s refuses a private-network target', (capability) => {
    expect(() =>
      assertDatabaseOperationAllowed({
        url: pg('10.0.0.5', LOCAL_DB_PORT),
        capability,
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    ).toThrow(DatabaseSafetyError)
  })

  it('no local capability can be unlocked by ANY environment variable', () => {
    // The exhaustive claim: every authorization token the policy table knows
    // about, all set at once, plus the generic names an operator might reach
    // for. A local capability must still refuse a remote target.
    const everyToken: Record<string, string | undefined> = {
      ALLOW_REMOTE: 'true',
      FORCE: 'true',
      UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION: 'controlled_remote_migration',
      UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read',
      UELLIX_DB_ALLOW_CONTROLLED_REMOTE_WRITE: 'controlled_remote_write',
      UELLIX_DB_LOCAL_RESET_CONFIRM: LOCAL_RESET_CONFIRMATION,
    }
    for (const capability of LOCAL_ONLY_CAPABILITIES) {
      expect(() =>
        assertDatabaseOperationAllowed({
          url: REMOTE_SUPABASE,
          capability,
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: everyToken,
        })
      ).toThrow(DatabaseSafetyError)
    }
  })

  it('refuses a local target on the WRONG port — another stack is not this stack', () => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({
        url: pg('127.0.0.1', 55322),
        capability: 'local_seed',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    )
    expect(error.code).toBe('DB_LOCAL_PORT_MISMATCH')
  })

  it('refuses a local capability that does not declare which port it expects', () => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({
        url: LOCAL_OK,
        capability: 'local_seed',
        environment: 'test',
        env: {},
      })
    )
    expect(error.code).toBe('DB_LOCAL_PORT_REQUIRED')
  })

  it('refuses local capabilities in a production environment', () => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({
        url: LOCAL_OK,
        capability: 'local_seed',
        environment: 'production',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    )
    expect(error.code).toBe('DB_ENVIRONMENT_NOT_ALLOWED')
  })
})

describe('capabilities — a URL may not override our own connection settings', () => {
  // MAJOR found in adversarial review, verified against postgres@3.4.9:
  // parseOptions spreads the URL's query parameters AFTER the caller's
  // `connection` object, so `?options=` wins over the
  // `default_transaction_read_only=on` this repository sets for read-only
  // capabilities. `options` is arbitrary server configuration (`-c anything`).
  const WITH_OPTIONS = `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1:${LOCAL_DB_PORT}/postgres?options=-c%20default_transaction_read_only%3Doff`
  // The shorter path to the same result: any key the driver does not consume
  // is forwarded into the startup packet, and Postgres applies startup GUCs
  // in packet order, so this lands AFTER ours and wins.
  const WITH_DIRECT_GUC = `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1:${LOCAL_DB_PORT}/postgres?default_transaction_read_only=off`

  it('flags every forwarded parameter during classification, not just "options"', () => {
    expect(classifyDatabaseTarget(WITH_OPTIONS).injectedConnectionParameters).toEqual(['options'])
    expect(classifyDatabaseTarget(WITH_DIRECT_GUC).injectedConnectionParameters).toEqual([
      'default_transaction_read_only',
    ])
    expect(classifyDatabaseTarget(LOCAL_OK).injectedConnectionParameters).toEqual([])
  })

  it('does not flag parameters the driver consumes as its own options', () => {
    const target = classifyDatabaseTarget(`${REMOTE_SUPABASE}?sslmode=require&connect_timeout=10`)
    expect(target.injectedConnectionParameters).toEqual([])
  })

  it('flags a case variant, because the driver matches its option names exactly', () => {
    const target = classifyDatabaseTarget(`${REMOTE_SUPABASE}?SSLMODE=require`)
    expect(target.injectedConnectionParameters).toEqual(['SSLMODE'])
  })

  it.each([
    ['an options payload', WITH_OPTIONS],
    ['a direct GUC parameter', WITH_DIRECT_GUC],
  ])('refuses %s for the read-only capability it would defeat', (_label, url) => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({
        url,
        capability: 'readonly_audit',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    )
    expect(error.code).toBe('DB_URL_UNSAFE_PARAMETERS')
  })

  it('refuses it for every capability whose guarantees a URL could reconfigure', () => {
    for (const capability of LOCAL_ONLY_CAPABILITIES) {
      const error = capture(() =>
        assertDatabaseOperationAllowed({
          url: WITH_DIRECT_GUC,
          capability,
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
        })
      )
      expect(error.code).toBe('DB_URL_UNSAFE_PARAMETERS')
    }
  })

  it('does NOT refuse them for app_runtime — managed pooler URLs carry them legitimately', () => {
    // Supabase's shared pooler uses `?options=reference%3D<ref>`. Refusing it
    // here would break the product at startup, and app_runtime sets no
    // connection options of its own for a URL parameter to override.
    const decision = assertDatabaseOperationAllowed({
      url: `${REMOTE_SUPABASE}?options=reference%3D${FAKE_PROJECT_REF}`,
      capability: 'app_runtime',
      environment: 'production',
      env: {},
    })
    expect(decision.targetKind).toBe('managed_remote')
  })

  it('flags "sslrootcert" as forwarded — empirically NOT one of the driver\'s own options', () => {
    // Reaudit gap (sslrootcert): verified against the installed postgres@3.4.9
    // (node_modules/postgres/src/index.js `parseOptions`) that `sslrootcert`
    // is absent from the driver's own `defaults` object, so the `k in
    // defaults` filter that builds the startup-packet `connection` object
    // does NOT consume it — it is forwarded like any other unrecognised query
    // key. `DRIVER_CONSUMED_QUERY_KEYS` in database-target.ts deliberately
    // omits it for exactly this reason; this test pins the classification
    // that depends on that omission.
    const target = classifyDatabaseTarget(`${REMOTE_SUPABASE}?sslrootcert=%2Fpath%2Fto%2Fca.pem`)
    expect(target.injectedConnectionParameters).toEqual(['sslrootcert'])
  })

  it('refuses a URL carrying "sslrootcert" for every capability a URL could reconfigure', () => {
    const url = `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1:${LOCAL_DB_PORT}/postgres?sslrootcert=%2Fpath%2Fto%2Fca.pem`
    for (const capability of LOCAL_ONLY_CAPABILITIES) {
      const error = capture(() =>
        assertDatabaseOperationAllowed({
          url,
          capability,
          environment: 'test',
          expectedLocalPort: LOCAL_DB_PORT,
          env: {},
        })
      )
      expect(error.code).toBe('DB_URL_UNSAFE_PARAMETERS')
    }
  })

  it('the refusal message names the parameters but never their values', () => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({
        url: WITH_OPTIONS,
        capability: 'readonly_audit',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    )
    expect(error.message).toContain('options')
    expect(error.message).not.toContain('default_transaction_read_only=off')
    expect(error.message).not.toContain(FAKE_PASSWORD)
  })
})

describe('capabilities — local_reset', () => {
  const base = {
    url: LOCAL_OK,
    capability: 'local_reset' as const,
    environment: 'test' as const,
    expectedLocalPort: LOCAL_DB_PORT,
    expectedProjectId: LOCAL_PROJECT_ID,
    env: {},
  }

  it('accepts the exact confirmation for this project', () => {
    const decision = assertDatabaseOperationAllowed({
      ...base,
      confirmation: LOCAL_RESET_CONFIRMATION,
    })
    expect(decision.capability).toBe('local_reset')
  })

  it('requires a confirmation', () => {
    expect(capture(() => assertDatabaseOperationAllowed(base)).code).toBe('DB_CONFIRMATION_REQUIRED')
  })

  it.each([
    ['trailing whitespace', `${LOCAL_RESET_CONFIRMATION} `],
    ['leading whitespace', ` ${LOCAL_RESET_CONFIRMATION}`],
    ['different case', LOCAL_RESET_CONFIRMATION.toUpperCase()],
    ['truncated', LOCAL_RESET_CONFIRMATION.slice(0, -1)],
    ['a different project', 'reset-local:some-other-stack'],
    ['a generic yes', 'yes'],
  ])('rejects a confirmation with %s', (_label, confirmation) => {
    expect(capture(() => assertDatabaseOperationAllowed({ ...base, confirmation })).code).toBe(
      'DB_CONFIRMATION_MISMATCH'
    )
  })

  it('never reaches a remote target even with a valid-looking confirmation', () => {
    expect(() =>
      assertDatabaseOperationAllowed({
        ...base,
        url: REMOTE_SUPABASE,
        confirmation: LOCAL_RESET_CONFIRMATION,
      })
    ).toThrow(DatabaseSafetyError)
  })
})

describe('capabilities — app_runtime', () => {
  it('permits a managed remote target without any destructive flag', () => {
    const decision = assertDatabaseOperationAllowed({
      url: REMOTE_SUPABASE,
      capability: 'app_runtime',
      environment: 'production',
      env: {},
    })
    expect(decision.targetKind).toBe('managed_remote')
    expect(decision.environment).toBe('production')
    expect(decision.readOnly).toBe(false)
  })

  it('permits local and private targets too', () => {
    expect(
      assertDatabaseOperationAllowed({
        url: LOCAL_OK,
        capability: 'app_runtime',
        environment: 'development',
        env: {},
      }).targetKind
    ).toBe('local_loopback')
    expect(
      assertDatabaseOperationAllowed({
        url: pg('10.0.0.5', 5432),
        capability: 'app_runtime',
        environment: 'production',
        env: {},
      }).targetKind
    ).toBe('private_network')
  })

  it('still fails closed on a missing, invalid or unknown URL', () => {
    expect(
      capture(() =>
        assertDatabaseOperationAllowed({ url: undefined, capability: 'app_runtime', env: {} })
      ).code
    ).toBe('DB_TARGET_URL_MISSING')
    expect(
      capture(() =>
        assertDatabaseOperationAllowed({ url: 'not a url', capability: 'app_runtime', env: {} })
      ).code
    ).toBe('DB_TARGET_URL_INVALID')
    expect(
      capture(() =>
        assertDatabaseOperationAllowed({
          url: pg('127.0.0.01', 5432),
          capability: 'app_runtime',
          env: {},
        })
      ).code
    ).toBe('DB_TARGET_UNKNOWN')
  })
})

describe('capabilities — controlled remote operations', () => {
  const migrationBase = {
    url: REMOTE_SUPABASE,
    capability: 'controlled_remote_migration' as const,
    environment: 'staging' as const,
    expectedProjectId: FAKE_PROJECT_REF,
    operation: 'stella_0003',
    confirmation: `controlled_remote_migration:${FAKE_PROJECT_REF}:stella_0003`,
    env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION: 'controlled_remote_migration' },
  }

  it('allows the operation only when every signal is present', () => {
    const decision = assertDatabaseOperationAllowed(migrationBase)
    expect(decision.capability).toBe('controlled_remote_migration')
    expect(decision.targetKind).toBe('managed_remote')
  })

  const MISSING_SIGNALS: {
    label: string
    override: Partial<Parameters<typeof assertDatabaseOperationAllowed>[0]>
    expectedCode: string
  }[] = [
    { label: 'the authorization token', override: { env: {} }, expectedCode: 'DB_REMOTE_AUTHORIZATION_MISSING' },
    {
      label: 'a token that is merely truthy',
      override: { env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION: 'true' } },
      expectedCode: 'DB_REMOTE_AUTHORIZATION_MISSING',
    },
    { label: 'the expected project id', override: { expectedProjectId: undefined }, expectedCode: 'DB_PROJECT_ID_REQUIRED' },
    { label: 'a matching project id', override: { expectedProjectId: 'other-project' }, expectedCode: 'DB_PROJECT_ID_MISMATCH' },
    { label: 'the operation name', override: { operation: undefined }, expectedCode: 'DB_OPERATION_DECLARATION_REQUIRED' },
    { label: 'a confirmation', override: { confirmation: undefined }, expectedCode: 'DB_CONFIRMATION_REQUIRED' },
    { label: 'a matching confirmation', override: { confirmation: 'yes' }, expectedCode: 'DB_CONFIRMATION_MISMATCH' },
    { label: 'an allowed environment', override: { environment: 'production' }, expectedCode: 'DB_ENVIRONMENT_NOT_ALLOWED' },
  ]

  for (const { label, override, expectedCode } of MISSING_SIGNALS) {
    it(`refuses when it is missing ${label}`, () => {
      const error = capture(() =>
        assertDatabaseOperationAllowed({ ...migrationBase, ...override })
      )
      expect(error.code).toBe(expectedCode)
    })
  }

  it('a confirmation minted for another operation does not authorise this one', () => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({
        ...migrationBase,
        operation: 'grounding_0001',
        confirmation: `controlled_remote_migration:${FAKE_PROJECT_REF}:stella_0003`,
      })
    )
    expect(error.code).toBe('DB_CONFIRMATION_MISMATCH')
  })

  it('refuses a LOCAL target — controlled_remote_* is not a general-purpose escape hatch', () => {
    const error = capture(() =>
      assertDatabaseOperationAllowed({ ...migrationBase, url: LOCAL_OK, expectedProjectId: 'x' })
    )
    expect(error.code).toBe('DB_OPERATION_NOT_ALLOWED')
  })

  it('controlled_remote_read is read-only and does not need a confirmation', () => {
    const decision = assertDatabaseOperationAllowed({
      url: REMOTE_SUPABASE,
      capability: 'controlled_remote_read',
      environment: 'production',
      expectedProjectId: FAKE_PROJECT_REF,
      env: { UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ: 'controlled_remote_read' },
    })
    expect(decision.readOnly).toBe(true)
  })
})

describe('capability isolation — one authorization never enables another', () => {
  const REMOTE_CAPABILITIES = [
    'controlled_remote_migration',
    'controlled_remote_read',
    'controlled_remote_write',
  ] as const

  it.each([...REMOTE_CAPABILITIES])('%s has its own dedicated authorization variable', (capability) => {
    const policy = CAPABILITY_POLICIES[capability]
    expect(policy.authorizationEnvVar).toBeTruthy()
    const others = REMOTE_CAPABILITIES.filter((c) => c !== capability).map(
      (c) => CAPABILITY_POLICIES[c].authorizationEnvVar
    )
    expect(others).not.toContain(policy.authorizationEnvVar)
  })

  it.each([...REMOTE_CAPABILITIES])(
    'granting every OTHER capability does not grant %s',
    (capability) => {
      const env: Record<string, string | undefined> = {}
      for (const other of REMOTE_CAPABILITIES) {
        if (other === capability) continue
        const policy = CAPABILITY_POLICIES[other]
        env[policy.authorizationEnvVar as string] = policy.authorizationToken as string
      }
      const error = capture(() =>
        assertDatabaseOperationAllowed({
          url: REMOTE_SUPABASE,
          capability,
          environment: 'staging',
          expectedProjectId: FAKE_PROJECT_REF,
          operation: 'stella_0003',
          confirmation: `${capability}:${FAKE_PROJECT_REF}:stella_0003`,
          env,
        })
      )
      expect(error.code).toBe('DB_REMOTE_AUTHORIZATION_MISSING')
    }
  )

  it('no local capability declares an authorization variable at all', () => {
    for (const capability of LOCAL_ONLY_CAPABILITIES) {
      expect(CAPABILITY_POLICIES[capability].authorizationEnvVar).toBeNull()
    }
    expect(CAPABILITY_POLICIES.local_reset.authorizationEnvVar).toBeNull()
  })

  it('no capability accepts an unknown or invalid target', () => {
    for (const policy of Object.values(CAPABILITY_POLICIES)) {
      expect(policy.allowedKinds).not.toContain('unknown')
      expect(policy.allowedKinds).not.toContain('invalid')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Message safety                                                             */
/* -------------------------------------------------------------------------- */

describe('error messages never leak credentials or the URL', () => {
  const LEAKY_URL = `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@${REMOTE_HOST}:5432/postgres?sslmode=require&options=-csearch_path%3Dsecret`

  const errors = [
    capture(() =>
      assertDatabaseOperationAllowed({
        url: LEAKY_URL,
        capability: 'local_seed',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    ),
    capture(() =>
      assertDatabaseOperationAllowed({
        url: LEAKY_URL,
        capability: 'controlled_remote_migration',
        environment: 'staging',
        expectedProjectId: FAKE_PROJECT_REF,
        operation: 'stella_0003',
        env: {},
      })
    ),
    capture(() =>
      assertDatabaseOperationAllowed({
        url: `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@127.0.0.1:55322/postgres`,
        capability: 'local_integration_test',
        environment: 'test',
        expectedLocalPort: LOCAL_DB_PORT,
        env: {},
      })
    ),
  ]

  it.each([
    ['the password', FAKE_PASSWORD],
    ['the username', FAKE_USER],
    ['the query string', 'sslmode=require'],
    ['connection options', 'search_path'],
    ['the full URL', LEAKY_URL],
    ['the scheme+credential prefix', 'postgresql://'],
  ])('no message contains %s', (_label, needle) => {
    for (const error of errors) {
      expect(error.message).not.toContain(needle)
    }
  })

  it('no message contains the unredacted remote hostname or project ref', () => {
    for (const error of errors) {
      if (error.targetKind !== 'managed_remote') continue
      expect(error.message).not.toContain(REMOTE_HOST)
      expect(error.message).not.toContain(FAKE_PROJECT_REF)
      expect(error.message).toContain('***.supabase.co')
    }
  })

  it('every message carries a stable machine-readable code', () => {
    for (const error of errors) {
      expect(error.name).toBe('DatabaseSafetyError')
      expect(error.message).toContain(`[${error.code}]`)
      expect(error.code).toMatch(/^DB_[A-Z_]+$/)
    }
  })

  it('the audit line of an allowed decision is equally credential-free', () => {
    const decision = assertDatabaseOperationAllowed({
      url: `postgresql://${FAKE_USER}:${FAKE_PASSWORD}@${REMOTE_HOST}:5432/postgres?sslmode=require`,
      capability: 'app_runtime',
      environment: 'production',
      env: {},
    })
    expect(decision.auditLine).not.toContain(FAKE_PASSWORD)
    expect(decision.auditLine).not.toContain(FAKE_USER)
    expect(decision.auditLine).not.toContain(FAKE_PROJECT_REF)
    expect(decision.auditLine).not.toContain('sslmode')
    expect(decision.auditLine).toContain('***.supabase.co')
  })
})

/* -------------------------------------------------------------------------- */
/* Environment resolution                                                     */
/* -------------------------------------------------------------------------- */

describe('resolveEnvironment', () => {
  it('prefers an explicit UELLIX_APP_ENV', () => {
    expect(resolveEnvironment({ UELLIX_APP_ENV: 'staging', NODE_ENV: 'development' })).toBe(
      'staging'
    )
  })

  it('detects CI and test explicitly', () => {
    expect(resolveEnvironment({ CI: 'true' })).toBe('ci')
    expect(resolveEnvironment({ NODE_ENV: 'test' })).toBe('test')
  })

  it('falls back to production — the most restrictive answer — for anything unrecognised', () => {
    expect(resolveEnvironment({ NODE_ENV: 'staging-ish' })).toBe('production')
    expect(resolveEnvironment({ UELLIX_APP_ENV: 'whatever' })).toBe('production')
  })

  it('does not accept a truthy-but-wrong CI value as CI', () => {
    expect(resolveEnvironment({ CI: 'false', NODE_ENV: 'production' })).toBe('production')
  })
})

/* -------------------------------------------------------------------------- */
/* Local URL resolution (dotenv hazard)                                       */
/* -------------------------------------------------------------------------- */

describe('resolveLocalDatabaseUrl', () => {
  it('ignores DATABASE_URL entirely and warns that it did', () => {
    const resolved = resolveLocalDatabaseUrl({ DATABASE_URL: REMOTE_SUPABASE })
    expect(resolved.url).toBe(LOCAL_DATABASE_URL)
    expect(resolved.source).toBe('pinned_local_stack')
    expect(resolved.warnings.join(' ')).toContain('IGNORED')
  })

  it('never echoes the ignored URL back in the warning', () => {
    const warning = resolveLocalDatabaseUrl({ DATABASE_URL: REMOTE_SUPABASE }).warnings.join(' ')
    expect(warning).not.toContain(FAKE_PASSWORD)
    expect(warning).not.toContain(FAKE_PROJECT_REF)
    expect(warning).toContain('***.supabase.co')
  })

  it('accepts an explicit LOCAL override on the expected port', () => {
    const url = `postgresql://postgres:postgres@localhost:${LOCAL_DB_PORT}/postgres`
    const resolved = resolveLocalDatabaseUrl({ [LOCAL_DATABASE_URL_ENV_VAR]: url })
    expect(resolved.source).toBe('explicit_local_override')
    expect(resolved.url).toBe(url)
  })

  it('rejects a REMOTE override', () => {
    expect(() =>
      resolveLocalDatabaseUrl({ [LOCAL_DATABASE_URL_ENV_VAR]: REMOTE_SUPABASE })
    ).toThrow(LocalDatabaseUrlResolutionError)
  })

  it('rejects a local override on another stack\'s port', () => {
    expect(() =>
      resolveLocalDatabaseUrl({ [LOCAL_DATABASE_URL_ENV_VAR]: pg('127.0.0.1', 55322) })
    ).toThrow(LocalDatabaseUrlResolutionError)
  })

  it('rejects an override the classifier cannot categorise', () => {
    expect(() => resolveLocalDatabaseUrl({ [LOCAL_DATABASE_URL_ENV_VAR]: 'not a url' })).toThrow(
      LocalDatabaseUrlResolutionError
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Helper                                                                     */
/* -------------------------------------------------------------------------- */

function capture(run: () => unknown): DatabaseSafetyError {
  try {
    run()
  } catch (error) {
    if (error instanceof DatabaseSafetyError) return error
    throw error
  }
  throw new Error('expected the operation to be refused, but it was allowed')
}
