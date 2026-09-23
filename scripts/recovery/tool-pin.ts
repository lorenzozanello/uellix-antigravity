// scripts/recovery/tool-pin.ts — the recovery tool pin and its skew refusals
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-7, TOOL_PINNING_DECISION).
//
// THE SKEW THIS RESOLVES. The clean-room recert found the governed rehearsal
// image (scripts/baseline-rehearsal-local.ts, 17.6.1.143) is not the build the
// authorized staging target was measured at (17.6.1.155). The authority recorded
// it and declined to move THAT pin. This module does not move it either: it is a
// SEPARATE pin for recovery, set to the measured target build, and it refuses —
// never warns — on any difference in:
//
//   - the local image id behind the image reference (a re-tagged or re-pulled
//     image is a different tool even under the same name);
//   - pg_dump and pg_restore versions;
//   - the source server and the restore substrate server version;
//   - the version the artifact header says dumped it and was dumped from.
//
// EXACT, NOT "COMPATIBLE". A logical dump is portable across patch releases in
// principle; the authority's words are that "tolerable in principle" is not a
// measurement. The first staging engine upgrade therefore makes this fail
// closed, and the pin is moved by a governed act rather than absorbed.

export const RECOVERY_TOOL_PIN = {
  imageRef: 'public.ecr.aws/supabase/postgres:17.6.1.155',
  /** `docker image inspect -f '{{.Id}}'`, measured 2026-09-23 on this host. */
  imageId: 'sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b',
  pgVersion: '17.6',
  serverVersionNum: 170006,
} as const

export type RecoveryToolPin = {
  readonly imageRef: string
  readonly imageId: string
  readonly pgVersion: string
  readonly serverVersionNum: number
}

/**
 * The cluster role set a FRESH container of the pinned image carries, measured
 * 2026-09-23 (`select rolname from pg_roles`, 29 roles). A substrate is
 * role-pristine only if its roles at start are EXACTLY this set: an extra role
 * is the masking hazard scripts/baseline-rehearsal-local.ts records (a borrowed
 * cluster already carrying an application role made policy statements pass and
 * hid the real first failure); a missing one means the image is not the pin.
 */
export const PINNED_IMAGE_BASELINE_ROLES: readonly string[] = [
  'anon',
  'authenticated',
  'authenticator',
  'dashboard_user',
  'pg_checkpoint',
  'pg_create_subscription',
  'pg_database_owner',
  'pg_execute_server_program',
  'pg_maintain',
  'pg_monitor',
  'pg_read_all_data',
  'pg_read_all_settings',
  'pg_read_all_stats',
  'pg_read_server_files',
  'pg_signal_backend',
  'pg_stat_scan_tables',
  'pg_use_reserved_connections',
  'pg_write_all_data',
  'pg_write_server_files',
  'pgbouncer',
  'postgres',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_etl_admin',
  'supabase_privileged_role',
  'supabase_read_only_user',
  'supabase_replication_admin',
  'supabase_storage_admin',
]

/** What a stage actually observed. Every field is a raw observation, never a default. */
export interface ToolObservation {
  imageId?: string | null
  /** Raw first line of `pg_dump --version`. */
  pgDumpVersionLine?: string | null
  /** Raw first line of `pg_restore --version`. */
  pgRestoreVersionLine?: string | null
  sourceServerVersionNum?: number | null
  substrateServerVersionNum?: number | null
  /** `; Dumped by pg_dump version: X` from `pg_restore --list`. */
  artifactDumpedBy?: string | null
  /** `; Dumped from database version: X` from `pg_restore --list`. */
  artifactDumpedFrom?: string | null
}

export type ToolObservationField = keyof ToolObservation

export type ToolRefusalCode =
  | 'TOOL_OBSERVATION_MISSING'
  | 'TOOL_IMAGE_ID_MISMATCH'
  | 'TOOL_PG_DUMP_VERSION_SKEW'
  | 'TOOL_PG_RESTORE_VERSION_SKEW'
  | 'TOOL_SOURCE_SERVER_VERSION_SKEW'
  | 'TOOL_SUBSTRATE_SERVER_VERSION_SKEW'
  | 'TOOL_ARTIFACT_DUMPED_BY_SKEW'
  | 'TOOL_ARTIFACT_DUMPED_FROM_SKEW'

export interface ToolRefusal {
  code: ToolRefusalCode
  field: ToolObservationField
}

export type ToolPinVerdict = { ok: true } | { ok: false; refusals: ToolRefusal[] }

/** `pg_dump (PostgreSQL) 17.6` -> `17.6`; anything else -> null (a refusal, never a guess). */
export function parseToolVersion(line: string | null | undefined, tool: 'pg_dump' | 'pg_restore'): string | null {
  if (typeof line !== 'string') return null
  const match = line.trim().match(new RegExp(`^${tool} \\(PostgreSQL\\) (\\d+\\.\\d+)(?:\\s.*)?$`))
  return match ? match[1] : null
}

/**
 * Evaluate the pin over the fields a stage REQUIRES. A required field that was
 * not observed is itself a refusal: absence of a measurement is never a pass.
 */
export function evaluateToolPin(
  observation: ToolObservation,
  required: readonly ToolObservationField[],
  pin: RecoveryToolPin = RECOVERY_TOOL_PIN,
): ToolPinVerdict {
  const refusals: ToolRefusal[] = []
  for (const field of required) {
    const value = observation[field]
    if (value === undefined || value === null || value === '') {
      refusals.push({ code: 'TOOL_OBSERVATION_MISSING', field })
      continue
    }
    switch (field) {
      case 'imageId':
        if (value !== pin.imageId) refusals.push({ code: 'TOOL_IMAGE_ID_MISMATCH', field })
        break
      case 'pgDumpVersionLine':
        if (parseToolVersion(value as string, 'pg_dump') !== pin.pgVersion) refusals.push({ code: 'TOOL_PG_DUMP_VERSION_SKEW', field })
        break
      case 'pgRestoreVersionLine':
        if (parseToolVersion(value as string, 'pg_restore') !== pin.pgVersion) refusals.push({ code: 'TOOL_PG_RESTORE_VERSION_SKEW', field })
        break
      case 'sourceServerVersionNum':
        if (value !== pin.serverVersionNum) refusals.push({ code: 'TOOL_SOURCE_SERVER_VERSION_SKEW', field })
        break
      case 'substrateServerVersionNum':
        if (value !== pin.serverVersionNum) refusals.push({ code: 'TOOL_SUBSTRATE_SERVER_VERSION_SKEW', field })
        break
      case 'artifactDumpedBy':
        if (value !== pin.pgVersion) refusals.push({ code: 'TOOL_ARTIFACT_DUMPED_BY_SKEW', field })
        break
      case 'artifactDumpedFrom':
        if (value !== pin.pgVersion) refusals.push({ code: 'TOOL_ARTIFACT_DUMPED_FROM_SKEW', field })
        break
    }
  }
  return refusals.length === 0 ? { ok: true } : { ok: false, refusals }
}
