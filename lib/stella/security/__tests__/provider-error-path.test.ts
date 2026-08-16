// lib/stella/security/__tests__/provider-error-path.test.ts
//
// F-GB-02, Phase L: the failure path.
//
// A provider error is the single richest leak vector in the system. It is
// written by a third party, it routinely quotes the request that caused it —
// the key in the query string of a 403, the body echo of a 400 — and it then
// fans out to three sinks at once: a server log, a Sentry issue, and a
// user-facing error result.
//
// These tests drive the REAL catch block in `generateWithTimeout` by mocking
// `@google/genai` (the module the adapter dynamically imports) to throw. No
// network, no key, no provider call — but the code under test is the same code
// that runs in production.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockGenerateContent = vi.fn()
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (...args: unknown[]) => mockGenerateContent(...args) }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
  },
}))

const mockCaptureException = vi.fn()
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  addBreadcrumb: vi.fn(),
}))

import { getGeminiAdapter, buildGeminiErrorLog } from '../../adapter/gemini-client'
import { runContextualAdvisor } from '../../advisor/run-contextual-advisor'
import { reportStellaFailure } from '../../observability'
import { StellaGeminiError, StellaParseError } from '../../errors'
import type { ContextualAdvisorContext } from '../../context/types'
import {
  SYNTHETIC_GEMINI_KEY,
  SYNTHETIC_PG_DSN,
  SYNTHETIC_PG_PASSWORD,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_EMAIL,
  SYNTHETIC_URL_WITH_QUERY_TOKEN,
} from '@/tests/fixtures/synthetic-credentials'

/** A configured adapter with no mock provider, so the real path runs. */
function liveShapedAdapter() {
  return getGeminiAdapter({ apiKey: SYNTHETIC_GEMINI_KEY, timeoutMs: 5_000 })
}

function minimalContext(): ContextualAdvisorContext {
  return {
    projectId: 'p-1',
    organizationId: 'o-1',
    projectName: 'Programa',
    narrativeSummary: 'Narrativa',
    outcomesSnapshot: [],
    indicatorsSnapshot: [],
    stakeholderCount: 0,
    stakeholdersSnapshot: [],
    activitiesSummary: [],
    evidenceMetadata: [],
    evidenceTotal: 0,
    proxySummary: [],
    filterSetsSummary: [],
    calculationSnapshot: null,
    calculationReadiness: { ready: false, blockingReasons: [], warnings: [] },
    reportSections: [],
    projectCreatedAt: '',
    lastUpdatedAt: '',
  }
}

/** The worst realistic provider error: it quotes the failing request back. */
const POISONED_PROVIDER_MESSAGE =
  `400 Bad Request from ${SYNTHETIC_URL_WITH_QUERY_TOKEN} — ` +
  `Authorization: Bearer ${SYNTHETIC_BEARER_TOKEN}; ` +
  `upstream DATABASE_URL=${SYNTHETIC_PG_DSN}; ` +
  `body echo: {"userMessage":"contacto ${SYNTHETIC_EMAIL}"}`

describe('Phase L — provider throws while quoting the request', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('the thrown StellaGeminiError carries no credential material', async () => {
    mockGenerateContent.mockRejectedValue(new Error(POISONED_PROVIDER_MESSAGE))

    await expect(
      liveShapedAdapter().generate({ role: 'advisor', systemPrompt: 'S', userMessage: 'U' })
    ).rejects.toThrow(StellaGeminiError)

    let thrown: unknown
    try {
      await liveShapedAdapter().generate({ role: 'advisor', systemPrompt: 'S', userMessage: 'U' })
    } catch (error) {
      thrown = error
    }
    const message = (thrown as Error).message
    expect(message).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(message).not.toContain(SYNTHETIC_BEARER_TOKEN)
    expect(message).not.toContain(SYNTHETIC_PG_PASSWORD)
    // Still recognisable as a Gemini failure — a redactor that erases the
    // diagnosis gets removed by the next person debugging an outage.
    expect(message).toContain('Gemini API error')
    expect(message).toContain('400 Bad Request')
  })

  it('the server log carries no credential material and no wholesale payload', async () => {
    mockGenerateContent.mockRejectedValue(new Error(POISONED_PROVIDER_MESSAGE))

    await liveShapedAdapter()
      .generate({ role: 'advisor', systemPrompt: 'S', userMessage: 'U' })
      .catch(() => undefined)

    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(logged).not.toContain(SYNTHETIC_BEARER_TOKEN)
    expect(logged).not.toContain(SYNTHETIC_PG_PASSWORD)

    // The log payload is role + status + message, never the request object.
    const [, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(payload).sort()).toEqual(['message', 'role'])
    expect(payload.role).toBe('advisor')
  })

  it('the Sentry event carries no credential material', async () => {
    mockGenerateContent.mockRejectedValue(new Error(POISONED_PROVIDER_MESSAGE))

    let thrown: unknown
    try {
      await liveShapedAdapter().generate({ role: 'advisor', systemPrompt: 'S', userMessage: 'U' })
    } catch (error) {
      thrown = error
    }
    // The real action layer does exactly this on a provider failure.
    reportStellaFailure('advisor', 'GEMINI_ERROR', thrown, { projectId: 'p-1' })

    const captured = JSON.stringify(mockCaptureException.mock.calls)
    expect(captured).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(captured).not.toContain(SYNTHETIC_BEARER_TOKEN)
    expect(captured).not.toContain(SYNTHETIC_PG_PASSWORD)
  })

  it('the user-facing result is generic and reveals nothing about the request', async () => {
    mockGenerateContent.mockRejectedValue(new Error(POISONED_PROVIDER_MESSAGE))

    const result = await runContextualAdvisor('stakeholders', minimalContext(), liveShapedAdapter())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('GEMINI_ERROR')
      expect(result.message).toBe('Stella AI service encountered an error.')
      expect(result.message).not.toContain(SYNTHETIC_GEMINI_KEY)
    }
  })
})

describe('reportStellaFailure redacts on its own, not because the adapter did', () => {
  // WHY THIS EXISTS. The suite above proves the Sentry event is clean after a
  // provider failure — but by then the adapter has ALREADY redacted the
  // message at construction, so removing redaction from `observability.ts`
  // changed nothing and the mutation survived. Defense in depth had made the
  // inner layer untestable through the outer one.
  //
  // These call `reportStellaFailure` DIRECTLY with a raw poisoned error, the
  // way any non-adapter caller would — a database driver error, an audit
  // failure, an UNKNOWN_ERROR wrapping something arbitrary.
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('strips a credential that sits INSIDE the 200-char truncation window', () => {
    // The exact pre-fix hole: 39-char key at offset 20, never truncated away.
    reportStellaFailure(
      'advisor',
      'GEMINI_ERROR',
      new Error(`Gemini 403: API key ${SYNTHETIC_GEMINI_KEY} is blocked`)
    )

    const [captured] = mockCaptureException.mock.calls[0] as [Error]
    expect(captured.message).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(captured.message).toContain('Gemini 403')
  })

  it('strips a DSN password from a database error', () => {
    reportStellaFailure(
      'validator',
      'AUDIT_ERROR',
      new Error(`connection refused: ${SYNTHETIC_PG_DSN}`)
    )

    const captured = JSON.stringify(mockCaptureException.mock.calls)
    expect(captured).not.toContain(SYNTHETIC_PG_PASSWORD)
  })

  it('redacts BEFORE truncating, so a credential at the cut is not left as a fragment', () => {
    // Position the key so it straddles the 200-char boundary. Truncate-first
    // would leave a recognisable prefix of it; redact-first removes the whole
    // value.
    const padding = 'x'.repeat(180)
    reportStellaFailure('advisor', 'GEMINI_ERROR', new Error(`${padding} ${SYNTHETIC_GEMINI_KEY}`))

    const [captured] = mockCaptureException.mock.calls[0] as [Error]
    expect(captured.message).not.toContain('AIza')
  })
})

describe('Phase L — other provider failure modes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('a malformed response never dumps the raw body', async () => {
    mockGenerateContent.mockResolvedValue({
      text: `no es JSON — contacto ${SYNTHETIC_EMAIL}, key ${SYNTHETIC_GEMINI_KEY}`,
    })

    const adapter = liveShapedAdapter()
    const response = await adapter.generate({ role: 'validator', systemPrompt: 'S', userMessage: 'U' })

    await expect(
      adapter.parseResponse(response.rawOutput, { parse: () => JSON.parse(response.rawOutput) })
    ).rejects.toThrow(StellaParseError)

    let thrown: unknown
    try {
      await adapter.parseResponse(response.rawOutput, {
        parse: () => JSON.parse(response.rawOutput) as unknown,
      })
    } catch (error) {
      thrown = error
    }
    // A JSON.parse failure message quotes the offending token. That is a
    // KNOWN, ACCEPTED residue: it is bounded to a few characters around the
    // syntax error and never the whole body — and `reportStellaFailure` +
    // `beforeSend` scrub it before it can leave. What must not happen is the
    // whole response being attached.
    expect((thrown as Error).message).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect((thrown as Error).message.length).toBeLessThan(200)
  })

  it('an empty response is a parse error, not a leak', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' })

    await expect(
      liveShapedAdapter().generate({ role: 'validator', systemPrompt: 'S', userMessage: 'U' })
    ).rejects.toThrow(StellaParseError)
  })
})

describe('buildGeminiErrorLog — the hole that the empty key opened', () => {
  it('redacts by SHAPE even when no api key is configured', () => {
    // PRE-FIX: `apiKey ? rawMessage.split(apiKey).join(...) : rawMessage`
    // forwarded the raw message whenever apiKey was falsy — i.e. exactly in
    // the mock/test configuration, and in any deployment already misconfigured.
    const { message } = buildGeminiErrorLog(new Error(POISONED_PROVIDER_MESSAGE), '')
    expect(message).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(message).not.toContain(SYNTHETIC_BEARER_TOKEN)
    expect(message).not.toContain(SYNTHETIC_PG_PASSWORD)
  })

  it('still redacts the configured key as an exact value', () => {
    const { message } = buildGeminiErrorLog(
      new Error(`403 for ${SYNTHETIC_GEMINI_KEY}`),
      SYNTHETIC_GEMINI_KEY
    )
    expect(message).not.toContain(SYNTHETIC_GEMINI_KEY)
  })

  it('preserves a numeric status for triage', () => {
    const error = Object.assign(new Error('rate limited'), { status: 429 })
    expect(buildGeminiErrorLog(error, '')).toEqual({ status: 429, message: 'rate limited' })
  })
})
