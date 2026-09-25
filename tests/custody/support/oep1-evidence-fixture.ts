// tests/custody/support/oep1-evidence-fixture.ts
//
// A SYNTHETIC OEP-1 v3 evidence that satisfies OEP1_EVIDENCE_CONTRACT, bound to
// the pins, host, driver digest and trust anchor the repository carries NOW,
// with a synthetic channel certification event. It is a one-record chain
// (predecessor null, nothing to acknowledge), and its observation carries the
// connection the probe would have OBSERVED on the right session. It lets a
// positive control show PMR-14 able to say yes; every negative control changes
// one field. It is never written to the repository: PHASE 2 has not run.

import { OEP1_DERIVED_MATERIAL_SETTINGS, OEP1_EXPECTED_CLIENT_SETTINGS, classifyDerivedMaterialExposure } from '@/db/custody/mint-operator-channel'
import { ROUTE_B_DATABASE, ROUTE_B_PORT } from '@/db/custody/mint-route-b-contract'
import { OEP1_EVIDENCE_CLASS, sessionFingerprint, type Oep1EvidenceFacts, type Oep1RepoContext } from '@/scripts/custody/d1-mint-operator-evidence'
import { CANNED_DERIVED_ROWS, PROBE_HARNESS_PRINCIPAL } from '@/scripts/custody/d1-oep1-probe-harness'

export const FIXTURE_EVIDENCE_PATH = 'docs/ops/release/FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_v1.0.0.json'
/** A synthetic peer certificate fingerprint (what node:tls would report for the server's leaf). */
export const FIXTURE_PEER_SHA256 = 'e'.repeat(64)

export function goodOep1Evidence(ctx: Oep1RepoContext, observedAtUtc: string): Record<string, unknown> {
  const principal = PROBE_HARNESS_PRINCIPAL
  const anchor = ctx.binding?.tls?.ca_der_sha256 ?? 'a'.repeat(64)
  const connection = {
    host: ctx.targetHost,
    port: ROUTE_B_PORT,
    database: ROUTE_B_DATABASE,
    user: principal,
    tls: { verified: true, peer_sha256: FIXTURE_PEER_SHA256, anchor_sha256: anchor },
    driver_digest: ctx.driverDigest,
  }
  const observation = {
    identity: { current_user: principal, session_user: principal, database: ROUTE_B_DATABASE, server_version_num: '170006' },
    client_settings: OEP1_EXPECTED_CLIENT_SETTINGS,
    derived_settings: CANNED_DERIVED_ROWS,
    connection,
  }
  const b = ctx.binding!
  return {
    evidence_class: OEP1_EVIDENCE_CLASS,
    append_only: true,
    predecessor: null,
    acknowledged_non_closed: [],
    target_host: ctx.targetHost,
    target_port: ROUTE_B_PORT,
    target_database: ROUTE_B_DATABASE,
    operator_principal: principal,
    observation,
    sub_verdicts: {
      PLAINTEXT_NOT_SERVER_VISIBLE: 'PASS',
      TARGET_SESSION_BOUND: 'PASS',
      STARTUP_PARAMETERS_CLOSED: 'PASS',
      TOOL_HASH_BOUND: 'PASS',
      PROBE_MINT_CONFIGURATION_COHERENT: 'PASS',
    },
    verdict: 'CLOSED',
    derived_material_exposure: classifyDerivedMaterialExposure(CANNED_DERIVED_ROWS),
    derived_settings_list: [...OEP1_DERIVED_MATERIAL_SETTINGS],
    probe_tool_sha256: b.tools.probe.sha256,
    mint_tool_sha256: b.tools.mint.sha256,
    launcher_build_digest: b.launcher_build_digest,
    driver_digest: ctx.driverDigest,
    session_fingerprint: sessionFingerprint({ host: ctx.targetHost!, port: ROUTE_B_PORT, database: ROUTE_B_DATABASE, principal, driverDigest: ctx.driverDigest!, anchorSha256: anchor }),
    observed_at_utc: observedAtUtc,
    invalidation_predicates: ['IP-1', 'IP-2', 'IP-3', 'IP-4', 'IP-5', 'IP-6', 'IP-7', 'IP-8'],
    channel_certification_event: 'docs/ops/release/FIBDB053_D1_AUDITOR_PREHC1_PACKAGE_CERTIFICATION_000000000000_v1.0.0.json',
  }
}

export function goodOep1Facts(ctx: Oep1RepoContext, observedAtUtc: string): Oep1EvidenceFacts {
  return {
    path: FIXTURE_EVIDENCE_PATH,
    evidence: goodOep1Evidence(ctx, observedAtUtc),
    channelEvent: { exists: true, terminalPass: true, candidateIsAncestorOfHead: true, bindingAtCandidate: ctx.binding },
    chain: [{ path: FIXTURE_EVIDENCE_PATH, verdict: 'CLOSED' }],
    chainReasons: [],
  }
}
