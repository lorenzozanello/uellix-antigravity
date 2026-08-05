// tests/eval/stella-release/observability-contract.test.ts
// RELEASE line — tests for the minimal observability event contract
// (STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3, Fase 4). Offline: no
// network, no DB, no provider, no real emitter — validates the contract
// object shapes only.

import { describe, it, expect } from 'vitest'
import {
  STELLA_OBSERVABILITY_EVENT_NAMES,
  STELLA_OBSERVABILITY_METRIC_CATEGORIES,
  PROVIDER_DEPENDENT_OBSERVABILITY_METRICS,
  MAX_EVENT_FIELD_VALUE_LENGTH,
  validateObservabilityEvent,
  isValidObservedDecisionValue,
  assertProviderDependentMetricsAreNull,
  type ObservabilityMetricValue,
} from './observability-contract'
import { MALICIOUS_DOCUMENT_PAYLOAD } from './fixtures'

describe('event name coverage — the 8 journey events Fase 4 requires', () => {
  it('declares started/completed/failed for ingestion', () => {
    expect(STELLA_OBSERVABILITY_EVENT_NAMES).toEqual(
      expect.arrayContaining(['ingestion.started', 'ingestion.completed', 'ingestion.failed']),
    )
  })

  it('declares started/completed/abstained for retrieval', () => {
    expect(STELLA_OBSERVABILITY_EVENT_NAMES).toEqual(
      expect.arrayContaining(['retrieval.started', 'retrieval.completed', 'retrieval.abstained']),
    )
  })

  it('declares validated/rejected for citations, plus response, decision, retry, quota and permission events', () => {
    expect(STELLA_OBSERVABILITY_EVENT_NAMES).toEqual(expect.arrayContaining([
      'citations.validated', 'citations.rejected', 'response.produced', 'human_decision.recorded',
      'retry.attempted', 'quota.rejected', 'permission.rejected',
    ]))
  })

  it('has exactly 13 events, no duplicates', () => {
    expect(new Set(STELLA_OBSERVABILITY_EVENT_NAMES).size).toBe(STELLA_OBSERVABILITY_EVENT_NAMES.length)
    expect(STELLA_OBSERVABILITY_EVENT_NAMES.length).toBe(13)
  })
})

describe('validateObservabilityEvent — accepts well-formed events', () => {
  it('accepts a minimal, well-formed event of every declared name', () => {
    const base = { timestamp: '2026-08-05T00:00:00.000Z', organizationId: 'org-1', requestId: 'req-1' }
    const perEventFields: Record<string, Record<string, unknown>> = {
      'ingestion.started': { documentId: 'doc-1', sourceKind: 'pdf' },
      'ingestion.completed': { documentId: 'doc-1', chunkCount: 12, durationMs: 340 },
      'ingestion.failed': { documentId: 'doc-1', errorCode: 'EXTRACT_ERROR' },
      'retrieval.started': { queryId: 'q-1' },
      'retrieval.completed': { queryId: 'q-1', resultCount: 3, topScore: 0.82, durationMs: 12 },
      'retrieval.abstained': { queryId: 'q-1', reasonCode: 'no_matching_evidence' },
      'citations.validated': { citationCount: 2 },
      'citations.rejected': { rejectedCount: 1, reasonCode: 'citation_out_of_scope' },
      'response.produced': { assertionCount: 1, requiresHumanReview: true },
      'human_decision.recorded': { decision: 'accepted', suggestionKey: 'advisor.suggested_next_actions[0]' },
      'retry.attempted': { attempt: 2, errorCode: 'TIMEOUT' },
      'quota.rejected': { limit: 100, windowHours: 1 },
      'permission.rejected': { requiredRole: 'admin' },
    }
    for (const eventName of STELLA_OBSERVABILITY_EVENT_NAMES) {
      const result = validateObservabilityEvent({ eventName, ...base, ...perEventFields[eventName] })
      expect(result.violations, `${eventName}: ${result.violations.join(' | ')}`).toEqual([])
      expect(result.ok).toBe(true)
    }
  })
})

describe('validateObservabilityEvent — rejects what Fase 4 excludes', () => {
  const base = { timestamp: '2026-08-05T00:00:00.000Z', organizationId: 'org-1', requestId: 'req-1' }

  it('rejects an unknown event name', () => {
    expect(validateObservabilityEvent({ eventName: 'not.a.real.event', ...base }).ok).toBe(false)
  })

  it('rejects a full prompt field, even on an event whose allowlist does not mention it', () => {
    const result = validateObservabilityEvent({
      eventName: 'response.produced', ...base, assertionCount: 1, requiresHumanReview: true,
      prompt: 'Eres un asistente que analiza evidencia de impacto social...',
    })
    expect(result.ok).toBe(false)
    expect(result.violations.join(' ')).toMatch(/prompt/)
  })

  it('rejects full evidence/document text under any field name, via the length cap', () => {
    const longText = 'x'.repeat(MAX_EVENT_FIELD_VALUE_LENGTH + 1)
    const result = validateObservabilityEvent({ eventName: 'ingestion.started', ...base, documentId: longText, sourceKind: 'pdf' })
    expect(result.ok).toBe(false)
    expect(result.violations.join(' ')).toMatch(/char cap/)
  })

  it('rejects a secret-shaped value even in an otherwise-allowed field', () => {
    const result = validateObservabilityEvent({ eventName: 'ingestion.failed', ...base, documentId: 'doc-1', errorCode: MALICIOUS_DOCUMENT_PAYLOAD })
    expect(result.ok).toBe(false)
    expect(result.violations.join(' ')).toMatch(/secret-pattern/)
  })

  it('rejects apiKey/secret/password/token field names outright, regardless of the per-event allowlist', () => {
    for (const field of ['apiKey', 'secret', 'password', 'authToken', 'sessionToken']) {
      const result = validateObservabilityEvent({ eventName: 'quota.rejected', ...base, limit: 100, windowHours: 1, [field]: 'whatever-value' })
      expect(result.ok, `${field} should be rejected`).toBe(false)
    }
  })

  it('rejects a field not on that event\'s allowlist even if it is a harmless-looking name', () => {
    const result = validateObservabilityEvent({ eventName: 'quota.rejected', ...base, limit: 100, windowHours: 1, unrelatedField: 'x' })
    expect(result.ok).toBe(false)
    expect(result.violations.join(' ')).toMatch(/not on the allowlist/)
  })
})

describe('isValidObservedDecisionValue — pinned against the real decisions-schema contract', () => {
  it('accepts the 4 real decision values', () => {
    for (const value of ['accepted', 'accepted_edited', 'rejected', 'undone']) {
      expect(isValidObservedDecisionValue(value)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isValidObservedDecisionValue('approved')).toBe(false)
    expect(isValidObservedDecisionValue(123)).toBe(false)
  })
})

describe('metric categories — the 7 dimensions Fase 4 requires kept separate', () => {
  it('has exactly 7 categories, no duplicates', () => {
    expect(new Set(STELLA_OBSERVABILITY_METRIC_CATEGORIES).size).toBe(7)
  })

  it('marks exactly latency/token-usage/cost as provider-dependent', () => {
    expect([...PROVIDER_DEPENDENT_OBSERVABILITY_METRICS].sort()).toEqual(['cost', 'latency', 'token-usage'])
  })
})

describe('assertProviderDependentMetricsAreNull — fails closed on a fabricated number', () => {
  const cleanMetrics: ObservabilityMetricValue[] = STELLA_OBSERVABILITY_METRIC_CATEGORIES.map((category) =>
    PROVIDER_DEPENDENT_OBSERVABILITY_METRICS.includes(category)
      ? { category, measurable: false, value: null, nullReason: { code: 'requires-provider-call', gate: 'G1', detail: 'no provider call made' } }
      : { category, measurable: true, value: 0, nullReason: null },
  )

  it('reports no problems when every provider-dependent metric is null with a reason', () => {
    expect(assertProviderDependentMetricsAreNull(cleanMetrics)).toEqual([])
  })

  it('reports a problem when a provider-dependent metric carries a fabricated value', () => {
    const tampered = cleanMetrics.map((m) => (m.category === 'latency' ? { ...m, measurable: true, value: 240, nullReason: null } : m))
    const problems = assertProviderDependentMetricsAreNull(tampered)
    expect(problems.join(' ')).toMatch(/"latency" is provider-dependent/)
  })

  it('reports a problem when any metric is a bare null with no reason', () => {
    const tampered = cleanMetrics.map((m) => (m.category === 'errors' ? { ...m, value: null, nullReason: null } : m))
    const problems = assertProviderDependentMetricsAreNull(tampered)
    expect(problems.join(' ')).toMatch(/"errors" is null with no structured reason/)
  })

  it('reports a problem when a metric carries both a value and a null reason', () => {
    const tampered = cleanMetrics.map((m) =>
      m.category === 'errors' ? { ...m, value: 1, nullReason: { code: 'requires-provider-call' as const, gate: 'G1' as const, detail: 'x' } } : m,
    )
    const problems = assertProviderDependentMetricsAreNull(tampered)
    expect(problems.join(' ')).toMatch(/carries both a value and a null reason/)
  })
})
