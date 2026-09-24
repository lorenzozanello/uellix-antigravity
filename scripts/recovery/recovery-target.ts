// scripts/recovery/recovery-target.ts — recovery identity classes
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-8).
//
// Two classes, and only two:
//
//   HOSTED_STAGING    — the future capture SOURCE. Constructible ONLY from an ok
//                       verdict of db/hosted/target-identity.ts verifyStagingTarget
//                       (authority TARGET_IDENTITY_ESTABLISHMENT.required_function:
//                       "No re-implementation, no inlined copy"). That function
//                       evaluates the production veto FIRST over every ref any
//                       source names. Nothing here contacts anything: the input
//                       is the same structural HostedTargetInput the hosted
//                       runner uses, and this module only classifies it.
//
//   LOCAL_DISPOSABLE  — a container THIS run created, identified by its full
//                       docker id and the run label it was created with. Only
//                       scripts/recovery/substrate.ts constructs one.
//
// PROVIDER NAMES ARE NEVER IDENTIFIERS (authority TARGET.PROVIDER_NAME_IS_NEVER_AN_IDENTIFIER,
// OF-5). Measured live: the VETOED production project carries the provider name
// 'uellix-staging' while the authorized one is 'Uellix Staging'. A selector that
// carries any name-like key is refused even when every structural signal is
// valid — the name is not ignored, it is disqualifying, because a tool that
// accepts a name "for display" is one refactor away from selecting by it.

import {
  verifyStagingTarget,
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  type HostedTargetInput,
  type ProductionIdentifiers,
  type SentinelPolicy,
} from '../../db/hosted/target-identity'

export type HostedStagingIdentity = {
  readonly identityClass: 'HOSTED_STAGING'
  readonly projectRef: string
  readonly signals: readonly string[]
  readonly sentinelDeferred: boolean
}

export type LocalDisposableIdentity = {
  readonly identityClass: 'LOCAL_DISPOSABLE'
  /** Full 64-hex docker container id. */
  readonly containerId: string
  readonly containerName: string
  readonly runId: string
  readonly role: SubstrateRole
  readonly imageId: string
}

export type SubstrateRole = 'source-fixture' | 'restore-substrate'

export type RecoveryIdentity = HostedStagingIdentity | LocalDisposableIdentity

export type RecoveryTargetRefusalCode =
  | 'RECOVERY_TARGET_SELECTOR_NOT_AN_OBJECT'
  | 'RECOVERY_TARGET_SELECTED_BY_NAME'
  | 'RECOVERY_TARGET_UNKNOWN_SELECTOR_KEY'
  | 'RECOVERY_TARGET_IDENTITY_REFUSED'

export type HostedIdentityVerdict =
  | { ok: true; identity: HostedStagingIdentity }
  | { ok: false; code: RecoveryTargetRefusalCode; detail: string; identityCode?: string }

const HOSTED_SELECTOR_KEYS = new Set(['declaredEnvironment', 'declaredProjectRef', 'connectionHost', 'poolerUser', 'connectionPort', 'sentinel'])

/** Any key whose NAME suggests a human-facing label. Matched case-insensitively. */
const NAME_LIKE_KEY = /name|label|title|display|slug|alias/i

/**
 * Classify a hosted SOURCE selector. Order is deliberate and mirrors
 * verifyStagingTarget: the production veto runs over the structural fields
 * BEFORE the name check, so a production ref is always refused AS production,
 * never with a secondary reason.
 */
export function hostedStagingIdentity(
  selector: unknown,
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
  sentinelPolicy: SentinelPolicy = 'required',
  expectedProjectRef: string = KNOWN_STAGING_PROJECT_REF,
): HostedIdentityVerdict {
  if (typeof selector !== 'object' || selector === null || Array.isArray(selector)) {
    return { ok: false, code: 'RECOVERY_TARGET_SELECTOR_NOT_AN_OBJECT', detail: 'a target selector is a structural HostedTargetInput object' }
  }
  const record = selector as Record<string, unknown>
  const input: HostedTargetInput = {
    declaredEnvironment: String(record.declaredEnvironment ?? ''),
    declaredProjectRef: String(record.declaredProjectRef ?? ''),
    connectionHost: String(record.connectionHost ?? ''),
    poolerUser: typeof record.poolerUser === 'string' ? record.poolerUser : null,
    connectionPort: typeof record.connectionPort === 'number' ? record.connectionPort : null,
    sentinel: isSentinel(record.sentinel) ? record.sentinel : null,
  }

  const verdict = verifyStagingTarget(input, production, sentinelPolicy, expectedProjectRef)
  if (!verdict.ok && verdict.code === 'HOSTED_TARGET_IS_PRODUCTION') {
    return { ok: false, code: 'RECOVERY_TARGET_IDENTITY_REFUSED', identityCode: verdict.code, detail: verdict.message }
  }

  const nameKeys = Object.keys(record).filter((k) => NAME_LIKE_KEY.test(k))
  if (nameKeys.length > 0) {
    return {
      ok: false,
      code: 'RECOVERY_TARGET_SELECTED_BY_NAME',
      detail: `refused: selector carries name-like key(s) ${nameKeys.join(', ')}. A provider project NAME is never a target identifier; only the structurally derived project ref is.`,
    }
  }
  const unknownKeys = Object.keys(record).filter((k) => !HOSTED_SELECTOR_KEYS.has(k))
  if (unknownKeys.length > 0) {
    return { ok: false, code: 'RECOVERY_TARGET_UNKNOWN_SELECTOR_KEY', detail: `refused: unknown selector key(s) ${unknownKeys.join(', ')}` }
  }

  if (!verdict.ok) {
    return { ok: false, code: 'RECOVERY_TARGET_IDENTITY_REFUSED', identityCode: verdict.code, detail: verdict.message }
  }
  return {
    ok: true,
    identity: { identityClass: 'HOSTED_STAGING', projectRef: verdict.projectRef, signals: verdict.signals, sentinelDeferred: verdict.sentinelDeferred },
  }
}

function isSentinel(value: unknown): value is { environment: string; projectRef: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).environment === 'string' &&
    typeof (value as Record<string, unknown>).projectRef === 'string'
  )
}
