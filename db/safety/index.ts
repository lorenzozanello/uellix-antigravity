// db/safety/index.ts — public surface of the database access safety layer.
//
// Layering (each depends only on the one above it):
//
//   local-stack.ts                 pinned facts about THIS worktree's stack
//   database-target.ts             classification: what kind of host is this?
//   redact-error.ts                credential-free rendering of any failure
//   resolve-local-database-url.ts  which URL does a local entry point use?
//   database-access.ts             authorization: may this capability run here?
//
// db/client.ts is the only module that turns an authorised decision into an
// actual postgres-js connection.

export {
  LOCAL_API_PORT,
  LOCAL_CONTAINER_HOSTS,
  LOCAL_DATABASE_URL,
  LOCAL_DB_PORT,
  LOCAL_PROJECT_ID,
  LOCAL_RESET_CONFIRMATION,
  LOCAL_SUPABASE_API_URL,
} from './local-stack'

export {
  classifyDatabaseTarget,
  classifySupabaseApiTarget,
  isLocalTarget,
  redactHost,
  type ClassifyOptions,
  type DatabaseTarget,
  type DatabaseTargetKind,
  type DatabaseTargetProvider,
  type DatabaseTargetReason,
} from './database-target'

export { describeError } from './redact-error'

export {
  LOCAL_DATABASE_URL_ENV_VAR,
  LocalDatabaseUrlResolutionError,
  resolveLocalDatabaseUrl,
  type LocalDatabaseUrlSource,
  type ResolvedLocalDatabaseUrl,
} from './resolve-local-database-url'

export {
  assertDatabaseOperationAllowed,
  assertSupabaseApiOperationAllowed,
  CAPABILITY_POLICIES,
  DatabaseSafetyError,
  resolveEnvironment,
  type AssertDatabaseOperationInput,
  type DatabaseCapability,
  type DatabaseOperationDecision,
  type DatabaseSafetyErrorCode,
  type DeploymentEnvironment,
} from './database-access'
