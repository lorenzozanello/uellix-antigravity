// tests/custody/support/oep1-evidence-fixture.ts
//
// A SYNTHETIC OEP-1 evidence that satisfies OEP1_EVIDENCE_CONTRACT, bound to
// the pins and host the repository carries NOW, with a synthetic channel
// certification event. It lets a positive control show PMR-13 able to say
// yes; every negative control changes one field. It is never written to the
// repository: PHASE 2 has not run.

import { OEP1_SETTINGS, evaluateOep1 } from '@/db/custody/mint-operator-channel'
import { OEP1_EVIDENCE_CLASS, type ChannelBinding, type Oep1EvidenceFacts } from '@/scripts/custody/d1-mint-operator-evidence'
import { CANNED_SAFE_ROWS, PROBE_HARNESS_PRINCIPAL } from '@/scripts/custody/d1-oep1-probe-harness'

export function goodOep1Evidence(binding: ChannelBinding, targetHost: string, observedAtUtc: string): Record<string, unknown> {
  const observation = { rows: CANNED_SAFE_ROWS, extensions: ['pg_stat_statements'] }
  return {
    evidence_class: OEP1_EVIDENCE_CLASS,
    append_only: true,
    target_host: targetHost,
    operator_principal: PROBE_HARNESS_PRINCIPAL,
    identity: { current_user: PROBE_HARNESS_PRINCIPAL, session_user: PROBE_HARNESS_PRINCIPAL },
    probe_tool_sha256: binding.tools.probe.sha256,
    launcher_build_digest: binding.launcher_build_digest,
    observed_at_utc: observedAtUtc,
    settings_list: [...OEP1_SETTINGS],
    observation,
    verdict: evaluateOep1(observation).verdict,
    invalidation_predicates: ['IP-1', 'IP-2', 'IP-3', 'IP-4', 'IP-5', 'IP-6'],
    channel_certification_event: 'docs/ops/release/FIBDB053_D1_AUDITOR_PREHC1_PACKAGE_CERTIFICATION_000000000000_v1.0.0.json',
  }
}

export function goodOep1Facts(binding: ChannelBinding, targetHost: string, observedAtUtc: string): Oep1EvidenceFacts {
  return {
    path: 'docs/ops/release/FIBDB053_D1_AUDITOR_OEP1_LOGGING_POSTURE_EVIDENCE_v1.0.0.json',
    evidence: goodOep1Evidence(binding, targetHost, observedAtUtc),
    channelEvent: { exists: true, terminalPass: true, candidateIsAncestorOfHead: true, bindingAtCandidate: binding },
  }
}
