// db/safety/database-access.ts
//
// AUTHORIZATION LAYER of the database access safety architecture.
//
// Classification (db/safety/database-target.ts) says *what* a URL points at.
// This module says whether a *specific operation* may run against it. The two
// are separate on purpose: `local_loopback` is not a permission, and
// `managed_remote` is not by itself "production".
//
// FAIL-CLOSED CONTRACT
//
//  * Every capability enumerates the target kinds it accepts. `unknown` and
//    `invalid` appear in none of them.
//  * Local capabilities (seed, integration test, reset, migration, read-only
//    audit) accept ONLY local targets. There is no environment variable,
//    flag, or argument that lets a seed reach a remote database.
//  * Remote capabilities each require their OWN authorization token, compared
//    with `===` against an exact literal. There is deliberately no
//    `ALLOW_REMOTE=true`: authorising a controlled remote migration does not
//    authorise a controlled remote write, and vice versa.
//  * Confirmations are compared exactly. Different case, surrounding
//    whitespace, or a truncated token all fail.
//  * No error message, ever, contains the URL, its credentials, its query
//    string, or an unredacted remote hostname.

import {
  classifyDatabaseTarget,
  classifySupabaseApiTarget,
  redactHost,
  type ClassifyOptions,
  type DatabaseTarget,
  type DatabaseTargetKind,
  type EnvironmentSource,
} from './database-target'
import { LOCAL_CONTAINER_HOSTS } from './local-stack'
import { runtimeProjectPinFor } from './runtime-project-pins'

/* -------------------------------------------------------------------------- */
/* Capabilities and environments                                              */
/* -------------------------------------------------------------------------- */

export type DatabaseCapability =
  /** Normal Next.js request/serverless path. May be remote. Never destructive-gated. */
  | 'app_runtime'
  /** Local, read-only inspection. Callers must open a read-only transaction. */
  | 'readonly_audit'
  /** Synthetic fixtures. Local only, no bypass. */
  | 'local_seed'
  /** Vitest integration suites. Local only, no bypass. */
  | 'local_integration_test'
  /** Destructive local rebuild. Local only + project id + exact confirmation. */
  | 'local_reset'
  /**
   * Sets the LOGIN passwords of the local `uellix_*` roles. Local only +
   * project id + exact confirmation, because it is the one operation that
   * mints the credentials every other capability then authenticates with.
   */
  | 'local_role_credential_rotation'
  /** drizzle-kit against the local stack. Local only. */
  | 'local_migration'
  /** Schema change against a designated remote. Blocked unless every signal is present. */
  | 'controlled_remote_migration'
  /** Read-only query against a designated remote. */
  | 'controlled_remote_read'
  /** Data write against a designated remote. Never satisfies a seed or a reset. */
  | 'controlled_remote_write'

export type DeploymentEnvironment = 'development' | 'test' | 'ci' | 'staging' | 'production'

export type DatabaseSafetyErrorCode =
  | 'DB_TARGET_URL_MISSING'
  | 'DB_TARGET_URL_INVALID'
  | 'DB_TARGET_UNKNOWN'
  | 'DB_URL_UNSAFE_PARAMETERS'
  | 'DB_OPERATION_NOT_ALLOWED'
  | 'DB_LOCAL_PORT_REQUIRED'
  | 'DB_LOCAL_PORT_MISMATCH'
  | 'DB_PROJECT_ID_REQUIRED'
  | 'DB_PROJECT_ID_MISMATCH'
  | 'DB_REMOTE_AUTHORIZATION_MISSING'
  | 'DB_ENVIRONMENT_NOT_ALLOWED'
  | 'DB_CONFIRMATION_REQUIRED'
  | 'DB_CONFIRMATION_MISMATCH'
  | 'DB_OPERATION_DECLARATION_REQUIRED'
  | 'DB_OPERATION_DECLARATION_MISMATCH'
  /* SYS-02 — runtime target identity. */
  /** A hosted environment was given a target that is not a managed remote. */
  | 'DB_RUNTIME_TARGET_NOT_HOSTED'
  /** A non-hosted environment (development/test/ci) was given a managed remote. */
  | 'DB_RUNTIME_REMOTE_NOT_ALLOWED'
  /** The connection proves no project, so it cannot be compared with the pin. */
  | 'DB_RUNTIME_PROJECT_UNPINNED'
  /** The connection proves a project, and it is not this environment's. */
  | 'DB_RUNTIME_PROJECT_MISMATCH'
  /** UELLIX_APP_ENV was set to something no environment is called. */
  | 'DB_RUNTIME_ENVIRONMENT_UNRECOGNISED'

export class DatabaseSafetyError extends Error {
  readonly name = 'DatabaseSafetyError'
  readonly code: DatabaseSafetyErrorCode
  readonly capability: DatabaseCapability
  readonly targetKind: DatabaseTargetKind
  readonly redactedHost: string
  readonly port: number | null

  constructor(params: {
    code: DatabaseSafetyErrorCode
    capability: DatabaseCapability
    targetKind: DatabaseTargetKind
    redactedHost: string
    port: number | null
    detail: string
  }) {
    // The message is assembled here and nowhere else, from values that are
    // known-safe: a stable code, a capability name, a classification, a
    // redacted host, a port, and a caller-supplied detail that must never
    // interpolate a URL.
    super(
      `[${params.code}] capability "${params.capability}" refused: ${params.detail} ` +
        `(target=${params.targetKind}, host=${params.redactedHost}, port=${params.port ?? 'unset'})`
    )
    this.code = params.code
    this.capability = params.capability
    this.targetKind = params.targetKind
    this.redactedHost = params.redactedHost
    this.port = params.port
  }
}

/* -------------------------------------------------------------------------- */
/* Policy table                                                               */
/* -------------------------------------------------------------------------- */

interface CapabilityPolicy {
  readonly allowedKinds: readonly DatabaseTargetKind[]
  readonly allowedEnvironments: readonly DeploymentEnvironment[]
  readonly requiresExpectedLocalPort: boolean
  readonly requiresProjectId: boolean
  readonly requiresOperation: boolean
  /** Exact env var that authorises this capability. Per-capability by design. */
  readonly authorizationEnvVar: string | null
  /** Exact value the env var must hold. A truthy string is not enough. */
  readonly authorizationToken: string | null
  /** Builds the exact confirmation string the caller must supply. */
  readonly confirmation: ((ctx: { projectId: string; operation: string }) => string) | null
  /** Callers must run inside a read-only transaction. */
  readonly readOnly: boolean
  /**
   * Refuse a URL whose query would be forwarded into the startup packet.
   *
   * True everywhere except `app_runtime`.
   *
   * BE PRECISE ABOUT WHAT THAT EXEMPTION COSTS. It is not that a parameter
   * has nothing to override — `?options=-c row_security=off` does not
   * override anything, it ADDS server configuration to the runtime's startup
   * packet. The exemption is accepted for two reasons:
   *
   *   1. Deployment reality. Managed connection strings legitimately carry
   *      parameters — Supabase's shared pooler uses
   *      `?options=reference%3D<ref>` — and refusing them would take the
   *      product down at startup. This layer must not change the production
   *      runtime's behaviour.
   *   2. No privilege escalation. `DATABASE_URL` is deployment configuration.
   *      Anyone who can set it can simply point it at a database they
   *      control, so the ability to append `-c` settings grants nothing they
   *      did not already have.
   *
   * Tracked as an accepted residual risk in
   * docs/ops/DATABASE_TARGET_SAFETY.md; narrowing it to a value-shaped
   * allow-list requires knowing the real production connection string.
   *
   * Every other capability either pins its URL (local_*) or depends on a
   * session setting the guard applies (readonly_audit,
   * controlled_remote_read), so for those a URL that can reconfigure the
   * session is refused outright.
   */
  readonly refusesParameterInjection: boolean
  /**
   * Force TLS regardless of what the URL says.
   *
   * postgres-js defaults to `ssl: false` and lets `?sslmode=disable` set it,
   * so without this a controlled remote read against production would happily
   * run in cleartext and the guard would classify the target as clean. When
   * true, db/client.ts pins `ssl` in the OPTIONS object, which beats the URL.
   *
   * False for `app_runtime`: its TLS posture is deployment configuration that
   * this change must not silently alter. See the residual risk noted in
   * docs/ops/DATABASE_TARGET_SAFETY.md.
   */
  readonly requiresTls: boolean
  /**
   * SYS-02. The target must positively prove it is THIS environment's project.
   *
   * Only `app_runtime` sets it, and only `app_runtime` needs it: every other
   * capability either pins a loopback port (local_*) or already demands an
   * operator-declared project id plus a per-capability token and an exact
   * confirmation (controlled_*). `app_runtime` is the one capability that may
   * reach a managed remote on nothing but deployment configuration, so it is
   * the one capability where "the role and the shape look right" was the whole
   * check — and the role is identical on both projects.
   */
  readonly requiresPinnedProjectIdentity: boolean
}

const LOCAL_KINDS: readonly DatabaseTargetKind[] = ['local_loopback', 'local_container']
const LOCAL_ENVIRONMENTS: readonly DeploymentEnvironment[] = ['development', 'test', 'ci']
const ALL_ENVIRONMENTS: readonly DeploymentEnvironment[] = [
  'development',
  'test',
  'ci',
  'staging',
  'production',
]

const localPolicy = (overrides: Partial<CapabilityPolicy> = {}): CapabilityPolicy => ({
  allowedKinds: LOCAL_KINDS,
  allowedEnvironments: LOCAL_ENVIRONMENTS,
  requiresExpectedLocalPort: true,
  requiresProjectId: false,
  requiresOperation: false,
  authorizationEnvVar: null,
  authorizationToken: null,
  confirmation: null,
  readOnly: false,
  refusesParameterInjection: true,
  requiresTls: false,
  requiresPinnedProjectIdentity: false,
  ...overrides,
})

export const CAPABILITY_POLICIES: Readonly<Record<DatabaseCapability, CapabilityPolicy>> =
  Object.freeze({
    app_runtime: {
      // The only capability that may reach a remote database without an
      // explicit token: it is the product itself running. It still refuses
      // `unknown` and `invalid`, so a malformed DATABASE_URL fails at the
      // guard rather than inside the driver.
      //
      // The kind list stays WIDE on purpose and the narrowing happens in step
      // 3b instead, because which kinds are acceptable depends on the
      // environment: a hosted environment accepts only a managed remote whose
      // project is proven, while development accepts loopback and a private
      // network and no remote at all. A single static list cannot say that.
      allowedKinds: ['local_loopback', 'local_container', 'private_network', 'managed_remote'],
      allowedEnvironments: ALL_ENVIRONMENTS,
      requiresExpectedLocalPort: false,
      requiresProjectId: false,
      requiresOperation: false,
      authorizationEnvVar: null,
      authorizationToken: null,
      confirmation: null,
      readOnly: false,
      refusesParameterInjection: false,
      requiresTls: false,
      requiresPinnedProjectIdentity: true,
    },

    readonly_audit: localPolicy({ readOnly: true }),
    local_seed: localPolicy(),
    local_integration_test: localPolicy(),
    local_migration: localPolicy(),
    // The confirmation binds to the project id the caller declared, so a
    // token minted for one local stack cannot confirm a reset of another.
    local_reset: localPolicy({
      requiresProjectId: true,
      confirmation: ({ projectId }) => `reset-local:${projectId}`,
    }),

    // Gated exactly like `local_reset`, and for the same reason: both are
    // operations whose blast radius is the whole stack rather than one table.
    // A rotation run against the wrong local stack would leave that stack's
    // runtime unable to authenticate, so the project id is pinned and the
    // confirmation token binds to it.
    local_role_credential_rotation: localPolicy({
      requiresProjectId: true,
      confirmation: ({ projectId }) => `rotate-local-credentials:${projectId}`,
    }),

    controlled_remote_migration: {
      allowedKinds: ['managed_remote'],
      allowedEnvironments: ['staging'],
      requiresExpectedLocalPort: false,
      requiresProjectId: true,
      requiresOperation: true,
      authorizationEnvVar: 'UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION',
      authorizationToken: 'controlled_remote_migration',
      confirmation: ({ projectId, operation }) =>
        `controlled_remote_migration:${projectId}:${operation}`,
      readOnly: false,
      refusesParameterInjection: true,
      requiresTls: true,
      requiresPinnedProjectIdentity: false,
    },

    controlled_remote_read: {
      allowedKinds: ['managed_remote'],
      allowedEnvironments: ['staging', 'production'],
      requiresExpectedLocalPort: false,
      requiresProjectId: true,
      requiresOperation: false,
      authorizationEnvVar: 'UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ',
      authorizationToken: 'controlled_remote_read',
      confirmation: null,
      readOnly: true,
      refusesParameterInjection: true,
      requiresTls: true,
      requiresPinnedProjectIdentity: false,
    },

    controlled_remote_write: {
      allowedKinds: ['managed_remote'],
      allowedEnvironments: ['staging'],
      requiresExpectedLocalPort: false,
      requiresProjectId: true,
      requiresOperation: true,
      authorizationEnvVar: 'UELLIX_DB_ALLOW_CONTROLLED_REMOTE_WRITE',
      authorizationToken: 'controlled_remote_write',
      confirmation: ({ projectId, operation }) => `controlled_remote_write:${projectId}:${operation}`,
      readOnly: false,
      refusesParameterInjection: true,
      requiresTls: true,
      requiresPinnedProjectIdentity: false,
    },
  })

/* -------------------------------------------------------------------------- */
/* Environment resolution                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How much authority the resolved environment carries.
 *
 * SYS-02 needs this distinction because `resolveEnvironment` answers
 * `production` in two very different situations: because somebody DECLARED
 * production, and because somebody declared `produciton` and the resolver
 * fell back to the most restrictive answer. Collapsing a typo into
 * "production" is the right default — but it must not also become AUTHORITY to
 * open the production database, or a mistyped variable becomes a credential.
 */
export type EnvironmentProvenance =
  /** `UELLIX_APP_ENV` named a known environment. */
  | 'declared'
  /** Derived from VERCEL_ENV / NODE_ENV / CI. Trustworthy, not declarative. */
  | 'inferred'
  /** `UELLIX_APP_ENV` was set to something no environment is called. */
  | 'unrecognised_declaration'

export interface EnvironmentDecision {
  readonly environment: DeploymentEnvironment
  readonly provenance: EnvironmentProvenance
}

/**
 * Resolve the deployment environment without boolean coercion, and say where
 * the answer came from.
 *
 * PRECEDENCE, most authoritative first:
 *
 *   1. `UELLIX_APP_ENV` — the explicit declaration.
 *   2. `NODE_ENV=test`  — a test process is a test process wherever it runs,
 *      and this is what stops a suite from resolving to a hosted environment
 *      and reaching a hosted database.
 *   3. `CI`             — same reasoning, one layer out.
 *   4. `VERCEL_ENV`     — the platform's own answer, added for SYS-02: without
 *      it a PREVIEW deployment falls through to NODE_ENV=production and
 *      resolves to `production`, so the project pin would demand the
 *      production project of a staging database. Fail-closed, but an outage.
 *   5. `NODE_ENV`.
 *
 * An unrecognised value resolves to `production`, the most restrictive answer
 * — never to `development` — and is reported as `unrecognised_declaration` so
 * the pinned capabilities can refuse a remote outright rather than treat a typo
 * as an intention.
 */
export function resolveEnvironmentDecision(
  env: EnvironmentSource = process.env
): EnvironmentDecision {
  const explicit = env.UELLIX_APP_ENV
  if (explicit !== undefined && explicit !== '') {
    return (ALL_ENVIRONMENTS as readonly string[]).includes(explicit)
      ? { environment: explicit as DeploymentEnvironment, provenance: 'declared' }
      : { environment: 'production', provenance: 'unrecognised_declaration' }
  }
  const inferred = (environment: DeploymentEnvironment): EnvironmentDecision => ({
    environment,
    provenance: 'inferred',
  })

  if (env.NODE_ENV === 'test') return inferred('test')
  if (env.CI === 'true' || env.CI === '1') return inferred('ci')

  // Vercel sets exactly one of these three. `preview` is the staging train's
  // deployment target, so it maps to `staging` rather than to production.
  if (env.VERCEL_ENV === 'production') return inferred('production')
  if (env.VERCEL_ENV === 'preview') return inferred('staging')
  if (env.VERCEL_ENV === 'development') return inferred('development')

  if (env.NODE_ENV === 'development' || env.NODE_ENV === undefined || env.NODE_ENV === '') {
    return inferred('development')
  }
  if (env.NODE_ENV === 'production') return inferred('production')
  return inferred('production')
}

/** The environment alone. Unchanged signature; see `resolveEnvironmentDecision`. */
export function resolveEnvironment(env: EnvironmentSource = process.env): DeploymentEnvironment {
  return resolveEnvironmentDecision(env).environment
}

/* -------------------------------------------------------------------------- */
/* Assertion                                                                  */
/* -------------------------------------------------------------------------- */

export interface AssertDatabaseOperationInput {
  /** Connection URL. Never stored, logged or returned. */
  readonly url: string | null | undefined
  readonly capability: DatabaseCapability
  readonly environment?: DeploymentEnvironment
  /** Required for every local capability: the port of the intended stack. */
  readonly expectedLocalPort?: number
  /** Local project id (reset) or remote project ref (controlled remote). */
  readonly expectedProjectId?: string
  /** Exact confirmation token. Compared with `===`. */
  readonly confirmation?: string
  /** Exact operation name, e.g. `stella_0003`. Part of the confirmation. */
  readonly operation?: string
  /** Injectable for tests; defaults to `process.env`. */
  readonly env?: EnvironmentSource
  readonly containerHosts?: readonly string[]
}

export interface DatabaseOperationDecision {
  readonly capability: DatabaseCapability
  readonly targetKind: DatabaseTargetKind
  readonly redactedHost: string
  readonly port: number | null
  readonly environment: DeploymentEnvironment
  /** True when the caller must open the session read-only. */
  readonly readOnly: boolean
  /** Caller must connect over TLS; db/client.ts pins it. */
  readonly requiresTls: boolean
  /** One-line, credential-free summary suitable for a run log. */
  readonly auditLine: string
}

function assertTargetAllowed(
  target: DatabaseTarget,
  input: AssertDatabaseOperationInput
): DatabaseOperationDecision {
  const { capability } = input
  // Cast to `| undefined`: TypeScript trusts the Record, but this function is
  // also reachable from plain-JS callers and from `tsx` scripts where the
  // capability may arrive as an unvalidated string.
  const policy = CAPABILITY_POLICIES[capability] as CapabilityPolicy | undefined
  if (!policy) {
    throw new DatabaseSafetyError({
      code: 'DB_OPERATION_NOT_ALLOWED',
      capability,
      targetKind: 'invalid',
      redactedHost: '(no host)',
      port: null,
      detail: 'unknown capability',
    })
  }

  const env = input.env ?? process.env
  // Resolved once, with its provenance, so step 3b can tell "somebody declared
  // production" apart from "somebody mistyped and we defaulted to production".
  const resolvedEnvironment = resolveEnvironmentDecision(env)
  const environment = input.environment ?? resolvedEnvironment.environment
  const environmentProvenance = resolvedEnvironment.provenance
  const redactedHost = target.redactedHost
  // Explicitly annotated const so TypeScript treats `fail(...)` as a
  // never-returning call for control-flow analysis.
  const fail: (code: DatabaseSafetyErrorCode, detail: string) => never = (code, detail) => {
    throw new DatabaseSafetyError({
      code,
      capability,
      targetKind: target.kind,
      redactedHost,
      port: target.port,
      detail,
    })
  }

  /* 1. The URL itself. --------------------------------------------------- */
  if (target.kind === 'invalid') {
    if (target.reason === 'missing') {
      fail('DB_TARGET_URL_MISSING', 'no connection URL was provided')
    }
    fail('DB_TARGET_URL_INVALID', `the connection URL could not be classified (${target.reason})`)
  }
  if (target.kind === 'unknown') {
    fail(
      'DB_TARGET_UNKNOWN',
      `the host could not be categorised (${target.reason}); unknown targets are never authorised`
    )
  }

  /* 1b. Parameters that would reconfigure the session. --------------------
   *
   * postgres-js forwards EVERY query key it does not consume itself into the
   * startup packet, after the caller's own `connection` object. Refusing only
   * `options` was insufficient: `?default_transaction_read_only=off` is a
   * shorter path to the same result, because Postgres applies startup GUCs in
   * packet order and the later one wins. Verified against postgres@3.4.9.
   *
   * Only the parameter NAMES appear in the message — never their values. */
  if (policy.refusesParameterInjection && target.injectedConnectionParameters.length > 0) {
    fail(
      'DB_URL_UNSAFE_PARAMETERS',
      `the connection URL carries parameter(s) [${target.injectedConnectionParameters.join(', ')}] ` +
        'that the driver forwards into the session startup packet, overriding settings this ' +
        'guard applies (including read-only enforcement)'
    )
  }

  /* 2. Kind vs capability. ----------------------------------------------- */
  if (!policy.allowedKinds.includes(target.kind)) {
    fail(
      'DB_OPERATION_NOT_ALLOWED',
      `this capability only accepts [${policy.allowedKinds.join(', ')}] targets`
    )
  }

  /* 3. Environment. ------------------------------------------------------ */
  if (!policy.allowedEnvironments.includes(environment)) {
    fail(
      'DB_ENVIRONMENT_NOT_ALLOWED',
      `environment "${environment}" is not in [${policy.allowedEnvironments.join(', ')}]`
    )
  }

  /* 3b. SYS-02 — the target must BE this environment's project. -------------
   *
   * Runs only for a capability that opted in (today: `app_runtime`), and only
   * after the environment is known, because the question it asks is
   * environment-relative.
   *
   * The rule is a positive identity, not a denylist:
   *
   *   hosted environment  → managed remote, project PROVEN, project == pin
   *   non-hosted          → no managed remote at all
   *
   * The two halves are symmetric on purpose. Refusing only the production ref
   * would leave `pnpm test` free to reach hosted STAGING, and a suite that
   * TRUNCATEs an append-only table does not become safe by aiming at the
   * shared database everyone else is using. */
  if (policy.requiresPinnedProjectIdentity) {
    const pin = runtimeProjectPinFor(environment)
    const isRemote = target.kind === 'managed_remote'

    // A typo in UELLIX_APP_ENV resolves to `production` because that is the
    // most restrictive ENVIRONMENT — but it must not thereby become authority
    // to open the production DATABASE. Only checked when the caller did not
    // state its own environment, and only for a remote: a local stack is
    // unaffected by how the variable was spelled.
    if (isRemote && input.environment === undefined && environmentProvenance === 'unrecognised_declaration') {
      fail(
        'DB_RUNTIME_ENVIRONMENT_UNRECOGNISED',
        'UELLIX_APP_ENV is set to a value no environment is called, so no project is pinned and ' +
          'a managed remote cannot be authorised. Set it to one of ' +
          `[${ALL_ENVIRONMENTS.join(', ')}], exactly`
      )
    }

    if (pin === null) {
      if (isRemote) {
        fail(
          'DB_RUNTIME_REMOTE_NOT_ALLOWED',
          `environment "${environment}" has no hosted database, so a managed remote is never its ` +
            'target. Point this at the local stack, or declare the hosted environment you mean ' +
            'via UELLIX_APP_ENV'
        )
      }
    } else if (!isRemote) {
      fail(
        'DB_RUNTIME_TARGET_NOT_HOSTED',
        `environment "${environment}" runs against its pinned hosted project, so a ` +
          `${target.kind} target is not a valid destination for it`
      )
    } else if (!target.provenIdentity.proven) {
      // Fail CLOSED on an unprovable identity. This is the case that makes the
      // check worth having: an opaque pooler URL, a lookalike domain, or a
      // managed host that names no project cannot be compared with the pin, and
      // "cannot be compared" must never resolve to "allowed".
      fail(
        'DB_RUNTIME_PROJECT_UNPINNED',
        `the connection does not structurally prove which project it points at ` +
          `(${target.provenIdentity.code}), so it cannot be shown to be the one pinned for ` +
          `environment "${environment}". Use a db.<ref>.supabase.co host, a qualified <role>.<ref> ` +
          'pooler login role, or the pooler reference parameter'
      )
    } else if (target.provenIdentity.projectRef !== pin) {
      // Neither ref is printed. Both are public, but this layer's rule is that
      // nothing organisation-identifying reaches a message that a run report
      // might capture, and the environment name is what makes it actionable.
      fail(
        'DB_RUNTIME_PROJECT_MISMATCH',
        `the connection proves a different Supabase project than the one pinned for environment ` +
          `"${environment}". The runtime role is identical across projects, so a matching role ` +
          'is not evidence of a matching target'
      )
    }
  }

  /* 4. Local port pinning. ----------------------------------------------- */
  if (policy.requiresExpectedLocalPort) {
    if (typeof input.expectedLocalPort !== 'number' || !Number.isInteger(input.expectedLocalPort)) {
      fail(
        'DB_LOCAL_PORT_REQUIRED',
        'a local capability must declare the port of the stack it intends to reach'
      )
    }
    if (target.port !== input.expectedLocalPort) {
      fail(
        'DB_LOCAL_PORT_MISMATCH',
        `expected port ${input.expectedLocalPort}; another local stack on this host is not a valid target`
      )
    }
  }

  /* 5. Remote authorization token — one per capability, exact match. ------ */
  if (policy.authorizationEnvVar && policy.authorizationToken) {
    const provided = env[policy.authorizationEnvVar]
    if (provided !== policy.authorizationToken) {
      fail(
        'DB_REMOTE_AUTHORIZATION_MISSING',
        `${policy.authorizationEnvVar} must be set to the exact literal "${policy.authorizationToken}"; ` +
          'authorising one capability never authorises another'
      )
    }
  }

  /* 6. Project identity. -------------------------------------------------- */
  let projectId = ''
  if (policy.requiresProjectId) {
    if (typeof input.expectedProjectId !== 'string' || input.expectedProjectId === '') {
      fail('DB_PROJECT_ID_REQUIRED', 'this capability requires the expected project id')
    }
    projectId = input.expectedProjectId as string
    // For remote targets we can verify the claim against the URL itself.
    if (target.kind === 'managed_remote') {
      if (target.projectRef === null || target.projectRef !== projectId) {
        fail(
          'DB_PROJECT_ID_MISMATCH',
          'the project reference in the connection URL does not match the expected project id'
        )
      }
    }
  }

  /* 7. Operation declaration. --------------------------------------------- */
  let operation = ''
  if (policy.requiresOperation) {
    if (typeof input.operation !== 'string' || input.operation === '') {
      fail('DB_OPERATION_DECLARATION_REQUIRED', 'this capability requires an exact operation name')
    }
    operation = input.operation as string
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(operation)) {
      fail(
        'DB_OPERATION_DECLARATION_MISMATCH',
        'the operation name must be a lowercase slug (a-z, 0-9, "_", "-")'
      )
    }
  }

  /* 8. Human confirmation, compared exactly. ------------------------------ */
  if (policy.confirmation) {
    const expected = policy.confirmation({ projectId, operation })
    if (typeof input.confirmation !== 'string' || input.confirmation === '') {
      fail('DB_CONFIRMATION_REQUIRED', `an exact confirmation is required: "${expected}"`)
    }
    if (input.confirmation !== expected) {
      fail(
        'DB_CONFIRMATION_MISMATCH',
        `the confirmation must match exactly (no surrounding whitespace, no case changes): "${expected}"`
      )
    }
  }

  return {
    capability,
    targetKind: target.kind,
    redactedHost,
    port: target.port,
    environment,
    readOnly: policy.readOnly,
    requiresTls: policy.requiresTls,
    auditLine:
      `db-safety: capability=${capability} target=${target.kind} host=${redactedHost} ` +
      `port=${target.port ?? 'unset'} env=${environment} readOnly=${policy.readOnly} ` +
      // "verified" is the honest word: the pin is `verify-full`, so the
      // server certificate is actually checked. "pinned" would have read as
      // verified while postgres-js's `require` silently disables certificate
      // validation — encryption without authentication.
      `tls=${policy.requiresTls ? 'verified' : 'from-url'}` +
      // Surfaces the app_runtime parameter exemption instead of leaving it
      // silent. NAMES only, never values — and a name is only printed when it
      // is shaped like an identifier, because a query key is arbitrary text
      // and could itself be a hostname.
      (target.injectedConnectionParameters.length > 0
        ? ` urlParams=[${target.injectedConnectionParameters
            .map((name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '(unnamed)'))
            .join(',')}]`
        : ''),
  }
}

/**
 * Fail-closed gate for any Postgres connection. Throws `DatabaseSafetyError`
 * unless every signal the capability requires is present.
 */
export function assertDatabaseOperationAllowed(
  input: AssertDatabaseOperationInput
): DatabaseOperationDecision {
  const classifyOptions: ClassifyOptions = {
    containerHosts: input.containerHosts ?? LOCAL_CONTAINER_HOSTS,
  }
  return assertTargetAllowed(classifyDatabaseTarget(input.url, classifyOptions), input)
}

/**
 * Same gate for the Supabase HTTP API (GoTrue admin, PostgREST). Creating a
 * user is a write; it must be authorised before `createClient` is called.
 */
export function assertSupabaseApiOperationAllowed(
  input: AssertDatabaseOperationInput
): DatabaseOperationDecision {
  const classifyOptions = { containerHosts: input.containerHosts ?? LOCAL_CONTAINER_HOSTS }
  return assertTargetAllowed(classifySupabaseApiTarget(input.url, classifyOptions), input)
}

/** Re-exported so callers never hand-roll redaction in their own log lines. */
export { redactHost }
