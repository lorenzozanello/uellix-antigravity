// db/custody/production-custody.ts
//
// N30, THE GOVERNED DEPOSIT, OVER THE CERTIFIED WCM PRIMITIVE.
//
// N30's act: deposit the credential N11 minted into the Windows Credential
// Manager entry the N29 mechanism reads. Its exit: the value is in EXACTLY ONE
// custody-store entry, that entry is the one the mechanism reads, and the value
// exists in no other store, file, variable or transcript.
//
// This module is the production core of that act. It never generates a value
// (the authority forbids a repository script from generating or minting one),
// never reaches a hosted target, and never removes anything: removal is N24's
// and N28's act and lives on its own path (scripts/custody/d1-wcm-remove.ts).
//
// THE TARGET LOCATOR. The entry name is DERIVED here from the capability and
// the pinned staging ref, so the depositor and the reader agree without either
// being configured. OF-DAG-6 bars a retrievable handle from the custody
// INVENTORY and the evidence artifact; it is therefore never written into any
// governance record, only computed at run time by the code that needs it. The
// name alone retrieves nothing: CredReadW requires the custodian's own logon
// and DPAPI context.

import { KNOWN_STAGING_PROJECT_REF } from '../hosted/target-identity'
import {
  CustodyError,
  SWEEPABLE_TARGET_PREFIXES,
  depositCredential,
  probeCredential,
  retrieveCredential,
} from './wcm-credential-store'

/** The one real custody entry for the D-1 auditor credential. Never in a sweepable namespace. */
export function d1AuditorWcmTarget(): string {
  return `UELLIX-D1-AUDITOR-${KNOWN_STAGING_PROJECT_REF}`
}

const AUDITOR_ROLE_PREFIXES = ['postgresql://uellix_auditor:', 'postgres://uellix_auditor:'].map((s) => Buffer.from(s, 'ascii'))

/**
 * The shape a deposited value must have, checked on BYTES so no JavaScript
 * string of the value is created. `production` requires the direct host of
 * the pinned staging project; `synthetic` requires an RFC 6761 `.invalid` host,
 * so a demonstration value can never be mistaken for, or used as, a real one.
 */
export type DepositShape = 'production' | 'synthetic'

export function checkDsnShape(value: Buffer, shape: DepositShape): string | null {
  if (!AUDITOR_ROLE_PREFIXES.some((p) => value.subarray(0, p.length).equals(p))) {
    return 'The value is not a postgres URL whose userinfo role is uellix_auditor.'
  }
  for (const byte of value) {
    if (byte <= 0x20 || byte === 0x7f) return 'The value contains whitespace or a control byte.'
  }
  let at = 0
  for (const byte of value) if (byte === 0x40) at += 1
  if (at !== 1) return 'The value must contain exactly one @ separating userinfo from host.'
  const hostMarker =
    shape === 'production'
      ? Buffer.from(`@db.${KNOWN_STAGING_PROJECT_REF}.supabase.co`, 'ascii')
      : Buffer.from('.invalid', 'ascii')
  if (!value.includes(hostMarker)) {
    return shape === 'production'
      ? 'The value does not name the direct host of the pinned staging project.'
      : 'A synthetic value must name an RFC 6761 .invalid host.'
  }
  if (shape === 'production' && value.includes(Buffer.from('.invalid', 'ascii'))) {
    return 'A production value may not name an .invalid host.'
  }
  return null
}

export interface DepositDeps {
  readonly probe: (target: string) => Promise<boolean>
  readonly deposit: (p: { target: string; username: string; secret: Buffer }) => Promise<void>
  readonly retrieve: (target: string) => Promise<Buffer | null>
}

const defaultDeps: DepositDeps = {
  probe: probeCredential,
  deposit: depositCredential,
  retrieve: retrieveCredential,
}

export interface DepositRecord {
  readonly shapeValid: true
  readonly preWriteEntryAbsent: true
  readonly deposited: true
  readonly postWriteProbePresent: boolean
  readonly roundTripEqual: boolean
  /** N30's exit, as far as the store can show it: present AND the same bytes. */
  readonly n30ExitMet: boolean
}

const inSweepableNamespace = (target: string): boolean => SWEEPABLE_TARGET_PREFIXES.some((p) => target.startsWith(`${p}-`))

/**
 * Deposit ONE value into ONE entry and prove it landed. The caller owns
 * `value` and zeroes it. Nothing here echoes, logs or returns the value.
 */
export async function depositGovernedCredential(params: {
  readonly value: Buffer
  readonly target: string
  readonly shape: DepositShape
  readonly deps?: DepositDeps
}): Promise<DepositRecord> {
  const deps = params.deps ?? defaultDeps
  if (params.shape === 'production') {
    if (params.target !== d1AuditorWcmTarget()) {
      throw new CustodyError('CUSTODY_TARGET_INVALID', 'A production deposit may only write the D-1 auditor entry.')
    }
    if (inSweepableNamespace(params.target)) {
      throw new CustodyError('CUSTODY_TARGET_INVALID', 'The production entry must never sit in a sweepable namespace.')
    }
  } else if (!inSweepableNamespace(params.target)) {
    throw new CustodyError('CUSTODY_TARGET_INVALID', 'A synthetic deposit may only write inside the sentinel namespace.')
  }
  const shapeProblem = checkDsnShape(params.value, params.shape)
  if (shapeProblem !== null) throw new CustodyError('CUSTODY_DEPOSIT_FAILED', `N30 refused the value: ${shapeProblem}`)

  // EXACTLY ONE ENTRY: a pre-existing entry is a previous attempt nobody closed,
  // and overwriting it silently would erase the evidence that it existed.
  if (await deps.probe(params.target)) {
    throw new CustodyError(
      'CUSTODY_DEPOSIT_FAILED',
      'STOP_N30_ENTRY_ALREADY_PRESENT: the custody entry already exists. Remove it through the governed removal path and record why before depositing again.'
    )
  }

  await deps.deposit({ target: params.target, username: 'uellix_auditor', secret: params.value })

  // N30 is not closed by a write call returning. It is closed by a READ of the
  // same scope that shows the entry present and carrying the same bytes.
  const postWriteProbePresent = await deps.probe(params.target)
  let roundTripEqual = false
  const back = postWriteProbePresent ? await deps.retrieve(params.target) : null
  try {
    roundTripEqual = back !== null && back.equals(params.value)
  } finally {
    back?.fill(0)
  }
  return {
    shapeValid: true,
    preWriteEntryAbsent: true,
    deposited: true,
    postWriteProbePresent,
    roundTripEqual,
    n30ExitMet: postWriteProbePresent && roundTripEqual,
  }
}
