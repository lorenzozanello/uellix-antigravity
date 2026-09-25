// tests/custody/n05-evidence-record.test.ts
//
// THE EVIDENCE RECORD CARRIES EVERY FIELD THE AUTHORITY REQUIRES, AND THE
// AUTHORITY REQUIRES EVERY FIELD THE RECORD CARRIES.
//
// The N05 readiness authority's EVIDENCE_CONTRACT opens with a rule that makes
// this checkable rather than aspirational: "Every field below is REQUIRED and
// is present AS A FIELD, so that its later absence is a HOLE rather than a
// silence." A record missing a field reports nothing where it should report a
// hole, and nothing is what a reader skims past.
//
// The check runs in BOTH directions. A one-way check would let the record grow
// fields the contract never asked for — which is how an evidence artifact
// quietly starts carrying something MUST_NEVER_CONTAIN forbids.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  N05_DEMONSTRATION_CONTROL_IDS,
  type N05ControlOutcomes,
  type N05EvidenceRecord,
} from '@/db/custody/n05-control-state'

const authority = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'docs',
      'ops',
      'release',
      'FIBDB053_D1_AUDITOR_N05_WCM_READINESS_AUTHORITY_v1.0.0.json'
    ),
    'utf8'
  )
) as {
  EVIDENCE_CONTRACT_FOR_THE_N05_DEMONSTRATION: {
    required_fields: string[]
    MUST_NEVER_CONTAIN: string
  }
}

const requiredFieldsText =
  authority.EVIDENCE_CONTRACT_FOR_THE_N05_DEMONSTRATION.required_fields.join(' | ')

/**
 * Every field the contract names, transcribed once and then checked against
 * the contract text, so a transcription slip cannot pass as agreement.
 *
 * `wcm_c2_processes_observed` is the one field carrying a name the contract
 * describes rather than spells: it requires "the enumeration of which
 * processes were observed" alongside the boolean, without naming the key.
 */
const CONTRACT_FIELDS = [
  'mechanism_named_by_behaviour',
  'sentinel_freshly_generated',
  'wcm_c1_fresh_shell_absent',
  'wcm_c2_external_command_line_observation_clean',
  'wcm_c3_history_sinks_enumerated',
  'wcm_c3_all_sinks_clean',
  'wcm_c3_invocation_contract_enforcement',
  'wcm_c4_success_path_removed',
  'wcm_c4_failure_path_removed',
  'wcm_c4_abrupt_termination_behaviour',
  'wcm_c5_check_returned_present_when_present',
  'wcm_c5_check_returned_absent_after_removal',
  'child_process_topology',
  'vault_read_audit_surface',
  'vault_read_audit_records_handle',
  'demonstration_preceded_MR_2',
  'working_directory_outside_the_repository_tree',
] as const

const DERIVED_FIELDS = ['wcm_c2_processes_observed', 'controls'] as const

const sampleOutcomes = Object.fromEntries(
  N05_DEMONSTRATION_CONTROL_IDS.map((id) => [id, 'NOT_RUN'])
) as N05ControlOutcomes

const sample: N05EvidenceRecord = {
  mechanism_named_by_behaviour: 'x',
  sentinel_freshly_generated: true,
  wcm_c1_fresh_shell_absent: true,
  wcm_c2_external_command_line_observation_clean: true,
  wcm_c2_processes_observed: [],
  wcm_c3_history_sinks_enumerated: [],
  wcm_c3_all_sinks_clean: true,
  wcm_c3_invocation_contract_enforcement: 'x',
  wcm_c4_success_path_removed: true,
  wcm_c4_failure_path_removed: true,
  wcm_c4_abrupt_termination_behaviour: 'x',
  wcm_c5_check_returned_present_when_present: true,
  wcm_c5_check_returned_absent_after_removal: true,
  child_process_topology: [],
  vault_read_audit_surface: 'x',
  vault_read_audit_records_handle: 'NOT_APPLICABLE',
  demonstration_preceded_MR_2: true,
  working_directory_outside_the_repository_tree: true,
  controls: sampleOutcomes,
}

describe('the record and the contract agree, in both directions', () => {
  it.each([...CONTRACT_FIELDS])('%s is named in the authority required_fields', (field) => {
    expect(requiredFieldsText).toContain(field)
  })

  it.each([...CONTRACT_FIELDS])('%s is present as a field on the record', (field) => {
    expect(Object.keys(sample)).toContain(field)
  })

  it('carries no field the contract did not ask for', () => {
    const allowed = new Set<string>([...CONTRACT_FIELDS, ...DERIVED_FIELDS])
    for (const key of Object.keys(sample)) {
      expect(allowed.has(key), `${key} is on the record but not in the contract`).toBe(true)
    }
  })
})

describe('NP7: the two removal paths and the two absence results stay separate', () => {
  it('records WCM-C4 as two booleans, not one', () => {
    // "A single combined boolean is a hole wearing a value."
    expect(typeof sample.wcm_c4_success_path_removed).toBe('boolean')
    expect(typeof sample.wcm_c4_failure_path_removed).toBe('boolean')
    expect(requiredFieldsText).toContain('two separate booleans')
  })

  it('records WCM-C5 as two booleans, so the negative exercise is recordable', () => {
    expect(typeof sample.wcm_c5_check_returned_present_when_present).toBe('boolean')
    expect(typeof sample.wcm_c5_check_returned_absent_after_removal).toBe('boolean')
  })

  it('has no combined field that could stand in for either pair', () => {
    for (const key of Object.keys(sample)) {
      expect(key).not.toMatch(/^wcm_c4_(both|removed)$/)
      expect(key).not.toMatch(/^wcm_c5_(absent|verified)$/)
    }
  })
})

describe('MUST_NEVER_CONTAIN is enforced structurally, not by care', () => {
  it('has no field that could hold a value, a handle or an entry key', () => {
    // The record's shape is the enforcement: there is no key here into which a
    // credential, sentinel, DSN, userinfo, host, hash, vault handle, entry key
    // or lookup token could be written without adding a field first.
    //
    // `vault_read_audit_records_handle` is the one key whose NAME mentions a
    // handle, and the contract requires it by that name. It is a claim ABOUT
    // handles, not a place to put one, so it is exempted from the name check
    // and constrained by type instead — which is the stronger check anyway.
    const exemptByType = new Set<string>(['vault_read_audit_records_handle'])
    for (const key of Object.keys(sample)) {
      if (exemptByType.has(key)) continue
      expect(key).not.toMatch(/value|secret|credential|dsn|userinfo|password|hash|handle|entry_key|token|host/i)
    }
  })

  it('constrains the one handle-named field to a verdict, so it cannot hold a handle', () => {
    const v = sample.vault_read_audit_records_handle
    expect(typeof v === 'boolean' || v === 'NOT_APPLICABLE').toBe(true)
  })

  it('records the sentinel only as a boolean about its freshness', () => {
    expect(typeof sample.sentinel_freshly_generated).toBe('boolean')
    expect(Object.keys(sample)).not.toContain('sentinel')
    expect(Object.keys(sample)).not.toContain('sentinel_value')
  })

  it('states the MUST_NEVER_CONTAIN rule the shape implements', () => {
    const rule = authority.EVIDENCE_CONTRACT_FOR_THE_N05_DEMONSTRATION.MUST_NEVER_CONTAIN
    expect(rule).toMatch(/vault handle, entry key or lookup token/i)
  })
})

describe('the controls block', () => {
  it('carries one entry per declared control and nothing else', () => {
    expect(Object.keys(sample.controls).sort()).toEqual([...N05_DEMONSTRATION_CONTROL_IDS].sort())
  })
})
