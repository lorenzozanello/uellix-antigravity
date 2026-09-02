// lib/stella/security/__tests__/model-boundary-redaction.test.ts
//
// F-GB-01: nothing personal and nothing secret may cross the model boundary.
//
// WHY THIS SUITE DRIVES THE REAL ADAPTER
//
// `run-contextual-advisor.test.ts` injects a duck-typed object as the adapter
// (`{ generate, parseResponse, isReady } as unknown as StellaGeminiAdapter`),
// which is right for testing the pipeline's step contract and useless for
// testing egress: a hand-rolled object cannot demonstrate anything about the
// class that actually reaches Google. So every assertion here goes through
// `getGeminiAdapter({ mockProvider })` — the REAL StellaGeminiAdapter, with the
// provider swapped at the one seam the class already exposes.
//
// The mock provider therefore observes EXACTLY the bytes the live provider
// would observe. That equivalence is the whole proof, and it is pinned by
// `keeps the mock provider on the same code path as the live provider` below:
// if the redaction call is ever moved after the mockProvider branch, the mock
// stops being representative and that test fails.
//
// MODEL_PROVIDER_CALLS = 0. Nothing in this file can reach the network: the
// mock provider short-circuits before the `@google/genai` import.

import { describe, it, expect } from 'vitest'
import { getGeminiAdapter } from '../../adapter/gemini-client'
import { runContextualAdvisor } from '../../advisor/run-contextual-advisor'
import { buildContextualAdvisorRequest } from '../../context/build-contextual-advisor-request'
import { buildAdvisorContextualUserMessage } from '../../prompts/advisor-contextual-system'
import type { ContextualAdvisorContext } from '../../context/types'
import type { StellaRequest, StellaResponse } from '../../adapter/types'
import {
  SYNTHETIC_EMAIL,
  SYNTHETIC_EMAIL_ACCENTED,
  SYNTHETIC_PHONE_INTL,
  SYNTHETIC_PHONE_PARENS,
  SYNTHETIC_CEDULA_DIGITS,
  SYNTHETIC_GEMINI_KEY,
  SYNTHETIC_PG_PASSWORD,
  SYNTHETIC_PG_DSN,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_JWT,
  SYNTHETIC_URL_WITH_QUERY_TOKEN,
  ALL_SYNTHETIC_PII,
  ALL_SYNTHETIC_SECRETS,
} from '@/tests/fixtures/synthetic-credentials'

/** Captures every request handed to the provider, then answers plausibly. */
function capturingAdapter() {
  const seen: StellaRequest[] = []
  const adapter = getGeminiAdapter({
    apiKey: '',
    mockProvider: {
      async generate(request: StellaRequest): Promise<StellaResponse> {
        seen.push(request)
        return {
          role: request.role,
          rawOutput: JSON.stringify({
            step: 'stakeholders',
            responseType: 'review',
            summary: 'Resumen',
            findings: [],
            suggestions: [],
            clarifyingQuestions: [],
            limitations: [],
            requiresHumanReview: true,
          }),
          parsedOutput: null,
          modelUsed: 'mock-model',
          timestamp: new Date(),
        }
      },
    },
  })
  return { adapter, seen }
}

/**
 * A context whose PERSONAL data sits in the STRUCTURED fields, not only in the
 * narrative. That asymmetry is the defect: pre-fix, `narrativeSummary` went
 * through `sanitizeNarrative` (which calls redactPii) while `projectName`,
 * stakeholder names, outcome descriptions and evidence titles were serialized
 * verbatim by `JSON.stringify`.
 */
function contextWithPersonalData(): ContextualAdvisorContext {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    // Structured field #1 — a project title carrying a contact address.
    projectName: `Programa Puente — contacto ${SYNTHETIC_EMAIL}`,
    // The one field that WAS already redacted. Kept so the suite proves the
    // fix did not regress it, and so the asymmetry is visible in one fixture.
    narrativeSummary: `Coordina ${SYNTHETIC_EMAIL_ACCENTED} y responde al ${SYNTHETIC_PHONE_INTL}.`,
    stakeholderCount: 2,
    // Structured field #2 — a person's name and a phone in a nested array.
    stakeholdersSnapshot: [
      {
        id: 'stakeholder-1',
        name: `María Restrepo (${SYNTHETIC_PHONE_PARENS})`,
        type: 'beneficiario',
        description: `Documento cédula ${SYNTHETIC_CEDULA_DIGITS}, vive en Bogotá.`,
      },
    ],
    activitiesSummary: [{ id: 'activity-1', title: `Taller con ${SYNTHETIC_EMAIL}` }],
    // Structured field #3 — nested arrays of objects.
    outcomesSnapshot: [
      {
        id: 'outcome-1',
        name: 'Empleabilidad juvenil',
        description: `Seguimiento telefónico al ${SYNTHETIC_PHONE_INTL}.`,
        stakeholderGroups: [`Jóvenes referidos por ${SYNTHETIC_EMAIL}`],
      },
    ],
    indicatorsSnapshot: [],
    // Evidence metadata: a title and a description are user-authored free text
    // and are exactly where an excerpt of an uploaded document lands.
    evidenceMetadata: [
      {
        id: 'evidence-1',
        title: `Acta firmada por ${SYNTHETIC_EMAIL}`,
        type: 'file',
        status: 'approved',
        createdAt: '2026-03-02T00:00:00.000Z',
        description: `Contacto de verificación ${SYNTHETIC_PHONE_PARENS}`,
        relatedOutcomeTitle: `Seguimiento de ${SYNTHETIC_EMAIL_ACCENTED}`,
      },
    ],
    evidenceTotal: 1,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    calculationReadiness: { ready: false, blockingReasons: [], warnings: [] },
    reportSections: [],
    projectCreatedAt: '2026-01-15T00:00:00.000Z',
    lastUpdatedAt: '2026-08-16T00:00:00.000Z',
  }
}

describe('F-GB-01 — provider boundary blocks personal data', () => {
  it('redacts personal data in STRUCTURED context fields, not only the narrative', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithPersonalData(), adapter)

    expect(seen).toHaveLength(1)
    const sentToProvider = `${seen[0]!.systemPrompt}\n${seen[0]!.userMessage}`

    // The narrative path was already covered pre-fix; these are the fields
    // that were not.
    expect(sentToProvider).not.toContain(SYNTHETIC_EMAIL) // projectName, activity title, stakeholderGroups
    expect(sentToProvider).not.toContain(SYNTHETIC_PHONE_PARENS) // nested stakeholder name
    expect(sentToProvider).not.toContain(SYNTHETIC_CEDULA_DIGITS) // nested description
    expect(sentToProvider).not.toContain(SYNTHETIC_PHONE_INTL) // outcome description (nested array)
    expect(sentToProvider).not.toContain(SYNTHETIC_EMAIL_ACCENTED) // narrative (regression guard)
  })

  it('leaves no synthetic personal value anywhere in the provider request', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithPersonalData(), adapter)

    const sentToProvider = `${seen[0]!.systemPrompt}\n${seen[0]!.userMessage}`
    for (const value of ALL_SYNTHETIC_PII) {
      if (!JSON.stringify(contextWithPersonalData()).includes(value)) continue
      expect(sentToProvider, `leaked ${value}`).not.toContain(value)
    }
  })

  it('still emits a REDACTION MARKER so the model knows a field was removed', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithPersonalData(), adapter)

    // Redaction must be visible, not silent: a field that simply vanished
    // would make the model infer the data does not exist.
    expect(seen[0]!.userMessage).toContain('[REDACTED:')
  })
})

describe('F-GB-01 — the fields the per-step slicer only exposes on some steps', () => {
  it('redacts evidence titles, descriptions and linkage names (evidence step)', async () => {
    // `evidenceMetadata` is in the slice for the evidence/indicators steps
    // only, so asserting it on the stakeholders step above would have proved
    // nothing — the field is simply absent there.
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('evidence', contextWithPersonalData(), adapter)

    const payload = seen[0]!.userMessage
    // The field really is present on this step (otherwise the assertions
    // below are vacuous).
    expect(payload).toContain('evidenceMetadata')
    expect(payload).toContain('Acta firmada por')
    // …and its free text is redacted.
    expect(payload).not.toContain(SYNTHETIC_EMAIL)
    expect(payload).not.toContain(SYNTHETIC_PHONE_PARENS)
    expect(payload).not.toContain(SYNTHETIC_EMAIL_ACCENTED)
  })

  it('redacts a user-supplied question', async () => {
    // The question is a third tier of input: not project data, not a system
    // instruction, and typed by a human who may paste anything into it.
    const question = `¿Puedo citar a ${SYNTHETIC_EMAIL} y al ${SYNTHETIC_PHONE_INTL}?`
    const message = buildAdvisorContextualUserMessage(
      'stakeholders',
      contextWithPersonalData(),
      question
    )

    expect(message).toContain('userQuestion')
    expect(message).not.toContain(SYNTHETIC_EMAIL)
    expect(message).not.toContain(SYNTHETIC_PHONE_INTL)
  })

  it('redacts previous advisor output fed back as context', async () => {
    // A follow-up turn can carry the model's own prior answer back in. It is
    // untrusted on the way out for the same reason it was on the way in.
    const seen: StellaRequest[] = []
    const adapter = getGeminiAdapter({
      apiKey: '',
      mockProvider: {
        async generate(request) {
          seen.push(request)
          return {
            role: request.role,
            rawOutput: '{}',
            parsedOutput: null,
            modelUsed: 'mock-model',
            timestamp: new Date(),
          }
        },
      },
    })

    await adapter.generate({
      role: 'advisor',
      systemPrompt: 'Sistema',
      userMessage: `Respuesta previa de Stella: "coordinar con ${SYNTHETIC_EMAIL}, cédula ${SYNTHETIC_CEDULA_DIGITS}".`,
    })

    expect(seen[0]!.userMessage).not.toContain(SYNTHETIC_EMAIL)
    expect(seen[0]!.userMessage).not.toContain(SYNTHETIC_CEDULA_DIGITS)
  })
})

describe('F-GB-01 — provider boundary blocks secrets carried in project data', () => {
  /**
   * Phase O: evidence text is DATA. A credential that arrives inside an
   * uploaded document must not reach the provider merely because a user typed
   * it into a field the schema calls "description".
   */
  function contextWithSecretsInContent(): ContextualAdvisorContext {
    const base = contextWithPersonalData()
    return {
      ...base,
      projectName: `Integración — key ${SYNTHETIC_GEMINI_KEY}`,
      narrativeSummary: `El runbook dice DATABASE_URL=${SYNTHETIC_PG_DSN}`,
      stakeholdersSnapshot: [
        {
          id: 'stakeholder-1',
          name: 'Equipo de plataforma',
          type: 'operador',
          description: `Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}`,
        },
      ],
      outcomesSnapshot: [
        {
          id: 'outcome-1',
          name: 'Interoperabilidad',
          description: `Token de sesión ${SYNTHETIC_JWT} y callback ${SYNTHETIC_URL_WITH_QUERY_TOKEN}`,
          stakeholderGroups: [],
        },
      ],
    }
  }

  it('strips credential-shaped values out of every provider-bound field', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithSecretsInContent(), adapter)

    const sentToProvider = `${seen[0]!.systemPrompt}\n${seen[0]!.userMessage}`
    for (const secret of ALL_SYNTHETIC_SECRETS) {
      if (!JSON.stringify(contextWithSecretsInContent()).includes(secret)) continue
      expect(sentToProvider, `leaked ${secret.slice(0, 8)}…`).not.toContain(secret)
    }
    // The DSN password specifically — the value that actually authenticates.
    expect(sentToProvider).not.toContain(SYNTHETIC_PG_PASSWORD)
  })
})

describe('F-GB-01 — redaction preserves the contract the provider depends on', () => {
  it('keeps the untrusted-data envelope parseable as JSON', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithPersonalData(), adapter)

    const [marker, payload] = seen[0]!.userMessage.split('\n')
    expect(marker).toBe('UNTRUSTED_PROJECT_DATA')
    expect(() => JSON.parse(payload!)).not.toThrow()
  })

  it('preserves the citation catalog exactly — redaction touches values, never paths', async () => {
    const context = contextWithPersonalData()
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', context, adapter)

    // The catalog the SYSTEM prompt advertises is built from keys and array
    // indexes. A structure-preserving redactor must leave it byte-identical to
    // the catalog computed from the UNREDACTED context — otherwise every
    // sourceRefIndex the model returns would decode to the wrong field.
    const expected = buildContextualAdvisorRequest('stakeholders', context).canonicalSourceFieldPaths
    for (const path of expected) {
      expect(seen[0]!.systemPrompt).toContain(path)
    }
  })

  it('preserves structure: same keys, same array lengths, same non-string types', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithPersonalData(), adapter)

    const payload = JSON.parse(seen[0]!.userMessage.split('\n')[1]!) as {
      step: string
      context: Record<string, unknown>
    }
    expect(payload.step).toBe('stakeholders')
    // Numbers survive — they carry meaning (beneficiary counts, amounts).
    expect(payload.context.stakeholderCount).toBe(2)
    // Array cardinality survives — a dropped element would silently change
    // what the model is reasoning about.
    expect((payload.context.stakeholdersSnapshot as unknown[]).length).toBe(1)
    expect((payload.context.outcomesSnapshot as unknown[]).length).toBe(1)
    // Identifiers survive — they are how findings are cited back.
    expect((payload.context.stakeholdersSnapshot as { id: string }[])[0]!.id).toBe('stakeholder-1')
    expect(payload.context.projectId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('does not mangle the trusted system instructions', async () => {
    const { adapter, seen } = capturingAdapter()

    await runContextualAdvisor('stakeholders', contextWithPersonalData(), adapter)

    expect(seen[0]!.systemPrompt).toContain('You are Stella')
    expect(seen[0]!.systemPrompt).toContain('SOURCE_REFERENCE_INDEXES')
    expect(seen[0]!.systemPrompt).toContain('requiresHumanReview')
  })
})

describe('F-GB-01 — the boundary is the adapter, so every caller inherits it', () => {
  it('keeps the mock provider on the same code path as the live provider', async () => {
    // MUTATION GUARD. If redaction is ever moved to a position AFTER the
    // mockProvider branch in generate(), the mock stops seeing what Google
    // would see — and every other assertion in this file silently becomes
    // vacuous. Driving the adapter directly (no advisor pipeline in front of
    // it) is the narrowest way to pin that ordering.
    const seen: StellaRequest[] = []
    const adapter = getGeminiAdapter({
      apiKey: '',
      mockProvider: {
        async generate(request) {
          seen.push(request)
          return {
            role: request.role,
            rawOutput: '{}',
            parsedOutput: null,
            modelUsed: 'mock-model',
            timestamp: new Date(),
          }
        },
      },
    })

    await adapter.generate({
      role: 'validator',
      systemPrompt: `Sistema. Reportar a ${SYNTHETIC_EMAIL}`,
      userMessage: `Clave ${SYNTHETIC_GEMINI_KEY} y teléfono ${SYNTHETIC_PHONE_INTL}`,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.systemPrompt).not.toContain(SYNTHETIC_EMAIL)
    expect(seen[0]!.userMessage).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(seen[0]!.userMessage).not.toContain(SYNTHETIC_PHONE_INTL)
  })

  it('does not mutate the caller\'s request object', async () => {
    const seen: StellaRequest[] = []
    const adapter = getGeminiAdapter({
      apiKey: '',
      mockProvider: {
        async generate(request) {
          seen.push(request)
          return {
            role: request.role,
            rawOutput: '{}',
            parsedOutput: null,
            modelUsed: 'mock-model',
            timestamp: new Date(),
          }
        },
      },
    })

    const request: StellaRequest = {
      role: 'composer',
      systemPrompt: 'Sistema',
      userMessage: `Contacto ${SYNTHETIC_EMAIL}`,
    }
    await adapter.generate(request)

    // The audit trail upstream may legitimately hold the original. Redaction
    // is a boundary transform, not an in-place scrub of the caller's data.
    expect(request.userMessage).toContain(SYNTHETIC_EMAIL)
    expect(seen[0]!.userMessage).not.toContain(SYNTHETIC_EMAIL)
  })

  it('preserves the contextHash — the audit identity of the request', async () => {
    const seen: StellaRequest[] = []
    const adapter = getGeminiAdapter({
      apiKey: '',
      mockProvider: {
        async generate(request) {
          seen.push(request)
          return {
            role: request.role,
            rawOutput: '{}',
            parsedOutput: null,
            modelUsed: 'mock-model',
            timestamp: new Date(),
          }
        },
      },
    })

    await adapter.generate({
      role: 'advisor',
      systemPrompt: 'Sistema',
      userMessage: 'Mensaje',
      contextHash: 'a'.repeat(64),
      responseJsonSchema: { type: 'object' },
    })

    expect(seen[0]!.contextHash).toBe('a'.repeat(64))
    expect(seen[0]!.responseJsonSchema).toEqual({ type: 'object' })
    expect(seen[0]!.role).toBe('advisor')
  })
})
