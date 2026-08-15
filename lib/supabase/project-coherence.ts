// lib/supabase/project-coherence.ts
//
// SYS-03 — AUTH AND POSTGRES MUST BE THE SAME SUPABASE PROJECT.
//
// ---------------------------------------------------------------------------
// THE INVARIANT
// ---------------------------------------------------------------------------
//     EXPECTED_PROJECT_REF(environment)
//       == AUTH_PROJECT_REF(NEXT_PUBLIC_SUPABASE_URL)
//       == POSTGRES_PROJECT_REF(the identity SYS-02 already proved)
//
// SYS-02 established the third term and pinned it to the first. It could not
// establish the second, because Supabase Auth is configured through a separate
// variable that the database safety layer deliberately never reads. So the
// runtime could be — and on 4a6a34f was — in this state without any check
// objecting:
//
//     UELLIX_APP_ENV              = staging
//     NEXT_PUBLIC_SUPABASE_URL    -> https://<production-ref>.supabase.co
//     UELLIX_RUNTIME_DATABASE_URL -> db.<staging-ref>.supabase.co
//
// SYS-02 passes: the database IS staging. And a user authenticating against
// production GoTrue receives a verified `sub` from the production project,
// which lib/auth/identity.ts hands to db/identity-context.ts as
// `request.jwt.claims`, which every RLS policy reads through `auth.uid()`. The
// policies are not bypassed — they are evaluated correctly, for a subject that
// belongs to a different database. Cross-resource incoherence does not need a
// broken policy to become a data-access defect.
//
// ---------------------------------------------------------------------------
// ONE REGISTRY, ONE PARSER PER SIDE
// ---------------------------------------------------------------------------
// The expectation comes from `runtimeProjectPinFor` — SYS-02's registry, not a
// copy. The Postgres identity comes from `classifyDatabaseTarget().provenIdentity`
// — SYS-02's derivation, not a second parse. The Auth identity comes from
// lib/supabase/project-identity.ts, which is the only new parser and exists
// because an HTTPS API URL is a different shape from a Postgres DSN.
//
// ---------------------------------------------------------------------------
// SERVER ONLY
// ---------------------------------------------------------------------------
// This module resolves `UELLIX_RUNTIME_DATABASE_URL`, so it must never reach a
// browser bundle. The browser's half of the contract lives in
// lib/supabase/project-identity.ts, which imports nothing from here.
//
// NO MESSAGE EVER CARRIES A URL, A PASSWORD OR A KEY. Refusals name the
// environment and a stable code. The project refs are public, and are still not
// printed: this layer follows db/safety's stricter rule, because a refusal at
// startup is exactly the text that ends up pasted into an issue.

import {
  resolveEnvironmentDecision,
  type DeploymentEnvironment,
} from '@/db/safety/database-access'
import { classifyDatabaseTarget, type EnvironmentSource } from '@/db/safety/database-target'
import { runtimeProjectPinFor } from '@/db/safety/runtime-project-pins'
import { resolveRuntimeDatabaseUrl } from '@/db/safety/resolve-capability-database-url'
import { deriveSupabaseApiIdentity } from './project-identity'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type SupabaseCoherenceCode =
  /** `UELLIX_APP_ENV` names no environment, so nothing is pinned. */
  | 'SUPABASE_ENVIRONMENT_UNRECOGNISED'
  /** The Auth URL structurally names no project. */
  | 'SUPABASE_AUTH_IDENTITY_UNPROVEN'
  /** A hosted environment was given a loopback Auth URL. */
  | 'SUPABASE_AUTH_LOCAL_IN_HOSTED_ENV'
  /** development/test/ci were given a hosted Auth URL. */
  | 'SUPABASE_AUTH_HOSTED_WITHOUT_PIN'
  /** The Auth project is not the one pinned for this environment. */
  | 'SUPABASE_AUTH_PROJECT_MISMATCH'
  /** The database proves no project, so it cannot be compared. */
  | 'SUPABASE_DB_IDENTITY_UNPROVEN'
  /** The database project is not the one pinned for this environment. */
  | 'SUPABASE_DB_PROJECT_MISMATCH'
  /** Auth and Postgres each matched something, and not each other. */
  | 'SUPABASE_AUTH_DB_PROJECT_DIVERGENCE'

export class SupabaseProjectCoherenceError extends Error {
  readonly name = 'SupabaseProjectCoherenceError'
  readonly code: SupabaseCoherenceCode
  readonly environment: DeploymentEnvironment

  constructor(params: {
    code: SupabaseCoherenceCode
    environment: DeploymentEnvironment
    detail: string
  }) {
    super(
      `[${params.code}] Supabase project coherence refused for environment ` +
        `"${params.environment}": ${params.detail}`
    )
    this.code = params.code
    this.environment = params.environment
  }
}

export interface SupabaseCoherenceDecision {
  readonly environment: DeploymentEnvironment
  /** The exact Auth URL that was validated. Callers must dial THIS value. */
  readonly authUrl: string
  /** The single project every source agreed on, or null for a local stack. */
  readonly projectRef: string | null
  /** Credential-free, ref-free one-line summary suitable for a startup log. */
  readonly auditLine: string
}

export interface AssertSupabaseProjectCoherenceInput {
  /** Injectable for tests; defaults to `process.env`. */
  readonly env?: EnvironmentSource
  /**
   * The Auth URL to judge.
   *
   * Injectable so the matrix can be exercised offline, and — more importantly —
   * so the CALLER can hand in the same expression it will dial. See the note on
   * build-time inlining in `readInlinedAuthUrl`.
   */
  readonly authUrl?: string | null
}

/* -------------------------------------------------------------------------- */
/* The Auth URL, read the way the client reads it                             */
/* -------------------------------------------------------------------------- */

/**
 * Read `NEXT_PUBLIC_SUPABASE_URL` as a STATIC member expression.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ACCESS FORM IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * Measured against next@16.2.9: `getDefineEnv` spreads every `NEXT_PUBLIC_*`
 * variable into the DefinePlugin map unconditionally — for the client, the Node
 * server and the edge compilations alike (dist/build/define-env.js). So
 * `process.env.NEXT_PUBLIC_SUPABASE_URL` written out literally is replaced with
 * a BUILD-TIME constant in all three bundles, while a dynamic lookup such as
 * `env.NEXT_PUBLIC_SUPABASE_URL` survives into the output and reads the RUNTIME
 * environment.
 *
 * Those are different values in exactly the situation SYS-03 is about: a Vercel
 * deployment BUILT against one project and RUN with another project's variables.
 * A guard that validated the runtime value while `createServerClient` dialled
 * the inlined one would be checking a string nobody uses — the same class of
 * defect as db/safety's "the guard classified one destination while the driver
 * dialled another".
 *
 * So the guard reads the inlined form, and the factories pass
 * `decision.authUrl` into the client rather than reading the variable a second
 * time. One read, one validation, one destination.
 */
function readInlinedAuthUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL
}

/* -------------------------------------------------------------------------- */
/* The assertion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Prove that Auth, Postgres and the environment all name ONE Supabase project.
 *
 * Throws `SupabaseProjectCoherenceError` before any Supabase client is
 * constructed and before any socket is opened. A configuration error crashing
 * the request is the intended outcome: the alternative is serving it against
 * two different projects.
 */
export function assertSupabaseProjectCoherence(
  input: AssertSupabaseProjectCoherenceInput = {}
): SupabaseCoherenceDecision {
  const env = input.env ?? process.env
  const rawAuthUrl = input.authUrl !== undefined ? input.authUrl : readInlinedAuthUrl()

  const { environment, provenance } = resolveEnvironmentDecision(env)
  const pin = runtimeProjectPinFor(environment)
  const authIdentity = deriveSupabaseApiIdentity(rawAuthUrl)

  const fail: (code: SupabaseCoherenceCode, detail: string) => never = (code, detail) => {
    throw new SupabaseProjectCoherenceError({ code, environment, detail })
  }

  /* 1. A typo must not become authority. -----------------------------------
   *
   * `resolveEnvironmentDecision` collapses an unrecognised `UELLIX_APP_ENV` to
   * `production`, which is the right ENVIRONMENT default — most restrictive —
   * but must never also be authority to authenticate against the production
   * project. Gated on a hosted Auth URL for the same reason SYS-02 gates its
   * twin on a remote target: a local stack is unaffected by how the variable
   * was spelled. */
  if (authIdentity.kind === 'hosted' && provenance === 'unrecognised_declaration') {
    fail(
      'SUPABASE_ENVIRONMENT_UNRECOGNISED',
      'UELLIX_APP_ENV is set to a value no environment is called, so no project is pinned and a ' +
        'hosted Supabase project cannot be authorised. There is no normalization: a trailing ' +
        'space and a different case are both typos that would widen the set of projects accepted'
    )
  }

  /* 2. The Auth URL must name a project structurally. --------------------- */
  if (authIdentity.kind === 'unproven') {
    fail(
      'SUPABASE_AUTH_IDENTITY_UNPROVEN',
      `NEXT_PUBLIC_SUPABASE_URL does not structurally prove which Supabase project Auth points at ` +
        `(${authIdentity.code}), so it cannot be shown to be the same project as the database. ` +
        'Use exactly https://<project-ref>.supabase.co'
    )
  }

  /* 3. Environments with no hosted project. -------------------------------
   *
   * `development`, `test` and `ci` have no pin because they have no hosted
   * project, and SYS-02 turns that absence into "no managed remote at all".
   * The Auth side is symmetric: a suite that can reach hosted GoTrue can
   * create and confirm real users in a shared project, and it does not become
   * safe by aiming at staging rather than production.
   *
   * The database is deliberately NOT resolved here. Nothing hosted is
   * reachable in these environments, so requiring UELLIX_RUNTIME_DATABASE_URL
   * to construct an Auth client would couple `pnpm dev` and every unit test to
   * a variable they do not need, to guard a risk that only exists when a pin
   * exists. */
  if (pin === null) {
    if (authIdentity.kind === 'hosted') {
      fail(
        'SUPABASE_AUTH_HOSTED_WITHOUT_PIN',
        `environment "${environment}" has no hosted Supabase project, so a hosted Auth URL is never ` +
          'its target. Point NEXT_PUBLIC_SUPABASE_URL at the local stack, or declare the hosted ' +
          'environment you mean via UELLIX_APP_ENV'
      )
    }
    return decide(environment, authIdentity.hostname, rawAuthUrl, null, 'local')
  }

  /* 4. A hosted environment: Auth must BE the pinned project. -------------- */
  if (authIdentity.kind === 'local') {
    fail(
      'SUPABASE_AUTH_LOCAL_IN_HOSTED_ENV',
      `environment "${environment}" runs against its pinned hosted project, so a loopback Auth URL ` +
        'is not a valid destination for it. localhost is never a stand-in for a hosted project'
    )
  }
  if (authIdentity.projectRef !== pin) {
    fail(
      'SUPABASE_AUTH_PROJECT_MISMATCH',
      'NEXT_PUBLIC_SUPABASE_URL names a different Supabase project than the one pinned for this ' +
        'environment. A self-consistent identity for the wrong project is still the wrong project, ' +
        'and authenticating against it would hand this environment a subject from another database'
    )
  }

  /* 5. And Postgres must be the same project — via SYS-02's own derivation. */
  const databaseIdentity = provenDatabaseIdentity(env)
  if (databaseIdentity === null) {
    fail(
      'SUPABASE_DB_IDENTITY_UNPROVEN',
      'the runtime database connection does not structurally prove which Supabase project it points ' +
        'at, so it cannot be shown to be the same project Auth authenticates against. Use a ' +
        'db.<ref>.supabase.co host, a postgres.<ref> pooler login role, or the pooler reference ' +
        'parameter'
    )
  }
  if (databaseIdentity !== pin) {
    fail(
      'SUPABASE_DB_PROJECT_MISMATCH',
      'the runtime database proves a different Supabase project than the one pinned for this ' +
        'environment'
    )
  }

  /* 6. The equality the whole module is named after, asserted directly. -----
   *
   * Unreachable while steps 4 and 5 both compare against the same pin, and
   * written anyway: it is the invariant, and the two comparisons above are its
   * implementation. If either of them is ever relaxed — an environment gains a
   * second acceptable project, a pin becomes a list — this line is what still
   * refuses to authenticate against one project and read from another. */
  if (authIdentity.projectRef !== databaseIdentity) {
    fail(
      'SUPABASE_AUTH_DB_PROJECT_DIVERGENCE',
      'Supabase Auth and the runtime database prove DIFFERENT Supabase projects. Sessions verified ' +
        'by one project would be used as row-level-security subjects in another'
    )
  }

  return decide(environment, null, rawAuthUrl, databaseIdentity, 'hosted')
}

/**
 * The project the runtime database PROVES, using SYS-02's derivation verbatim.
 *
 * `classifyDatabaseTarget` is the same call `assertDatabaseOperationAllowed`
 * makes, and `provenIdentity` is the same field its step 3b compares against
 * the pin. Re-deriving a ref here with a second parser would create exactly the
 * drift db/safety/runtime-project-pins.ts refuses to create.
 *
 * Returns null — never throws — for every failure, including a missing or
 * wrong-role `UELLIX_RUNTIME_DATABASE_URL`. The caller turns that into one
 * fail-closed refusal, so a misconfiguration cannot surface as a raw error
 * whose message this module has not vetted.
 */
function provenDatabaseIdentity(env: EnvironmentSource): string | null {
  let url: string
  try {
    url = resolveRuntimeDatabaseUrl(env).url
  } catch {
    return null
  }
  const identity = classifyDatabaseTarget(url).provenIdentity
  return identity.proven ? identity.projectRef : null
}

function decide(
  environment: DeploymentEnvironment,
  localHost: string | null,
  authUrl: string | null | undefined,
  projectRef: string | null,
  mode: 'local' | 'hosted'
): SupabaseCoherenceDecision {
  return {
    environment,
    // Safe: every path that reaches here proved the URL parses, which requires
    // it to have been a non-empty string.
    authUrl: (authUrl as string).trim(),
    projectRef,
    // No ref, no host beyond loopback, no key, no URL. The environment and the
    // mode are what make this actionable; the project is deliberately implicit,
    // because it is fully determined by the environment once this line prints.
    auditLine:
      `supabase-coherence: env=${environment} mode=${mode} ` +
      `auth=${mode === 'local' ? (localHost ?? 'loopback') : 'pinned-project'} ` +
      `db=${mode === 'local' ? 'not-consulted' : 'pinned-project'} coherent=true`,
  }
}
