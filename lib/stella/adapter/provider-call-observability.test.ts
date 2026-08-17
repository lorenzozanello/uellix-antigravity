// lib/stella/adapter/provider-call-observability.test.ts
//
// G1-B — PROVIDER INVOCATION OBSERVABILITY.
//
// ---------------------------------------------------------------------------
// THE PROPERTY, AND WHY NOTHING ELSE IN THE SYSTEM CAN STATE IT
// ---------------------------------------------------------------------------
// PB-01 (`PROVIDER_CALL_CONCURRENCY_PER_TICKET`) means a ticket that is already
// `bound` admits N concurrent deliveries, each of which can reach the provider
// before one `complete` wins the race:
//
//     1 ticket -> 1 bind -> N Gemini calls -> 1 settlement
//
// So `operation_tickets.bound_at`, `stella_interactions`, the quota ledger and
// `audit_logs` can ALL read 1 while the provider was invoked N times. None of
// them can count provider calls, and G1-B's budget of "exactly one" was
// therefore unverifiable from inside the runtime.
//
// These events are the counter. The property they certify is stated narrowly:
//
//     "the Uellix runtime invoked the Gemini SDK exactly once"
//
// NOT "Google accepted one request", NOT "Google billed one request", NOT
// "Google completed one request". Those are provider-side facts and this
// instrumentation deliberately does not claim them.
//
// ---------------------------------------------------------------------------
// WHAT THE CARDINALITY CONTRACT IS
// ---------------------------------------------------------------------------
// Over an isolated window:
//
//     happy path   |started| = 1, |completed| = 1, |failed| = 0, ids equal
//     negatives    |started| = 0
//     PB-01        |started| > 1  while ticket/interaction/settlement all = 1
//
// The last line is the whole reason this file exists.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StellaGeminiAdapter } from './gemini-client'
import { StellaTimeoutError, StellaGeminiError, StellaParseError } from '../errors'
import type { StellaMockProvider, StellaResponse, StellaRequest, StellaRole } from './types'

const mockGenerateContent = vi.fn()
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (...args: unknown[]) => mockGenerateContent(...args) }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
  },
}))

// ---------------------------------------------------------------------------
// Capturing the sink
// ---------------------------------------------------------------------------

type Event = Record<string, unknown>

let emitted: Event[] = []
let infoSpy: ReturnType<typeof vi.spyOn>

function capture() {
  emitted = []
  infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    // The contract is ONE argument, a JSON string. Anything else is a
    // violation of the format and must not be silently normalised here.
    if (args.length !== 1 || typeof args[0] !== 'string') return
    try {
      emitted.push(JSON.parse(args[0] as string) as Event)
    } catch {
      // Not our JSON — ignore, but never swallow the assertion below.
    }
  })
}

const of = (name: string): Event[] => emitted.filter((e) => e.event === name)
const ids = (name: string): string[] => [...new Set(of(name).map((e) => String(e.invocationId)))]

const STARTED = 'stella.provider_call.started'
const COMPLETED = 'stella.provider_call.completed'
const FAILED = 'stella.provider_call.failed'

const PROMPT = 'SYSTEM-PROMPT-CANARY-do-not-log'
const MESSAGE = 'USER-MESSAGE-CANARY-do-not-log'
const API_KEY = 'AIza-CANARY-KEY-do-not-log'

function adapter(overrides: Record<string, unknown> = {}) {
  return new StellaGeminiAdapter({ apiKey: API_KEY, ...overrides })
}

function request(role: StellaRole = 'advisor'): StellaRequest {
  return { role, systemPrompt: PROMPT, userMessage: MESSAGE }
}

function goodResponse(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({ ok: true }),
    modelVersion: 'gemini-3.6-flash-001',
    responseId: 'resp-abc',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 1632,
      candidatesTokenCount: 391,
      thoughtsTokenCount: 1396,
      totalTokenCount: 3419,
    },
    ...overrides,
  }
}

beforeEach(() => {
  mockGenerateContent.mockReset()
  capture()
})
afterEach(() => {
  infoSpy.mockRestore()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1-2. The success lifecycle
// ---------------------------------------------------------------------------

describe('one SDK invocation produces exactly one STARTED', () => {
  it('emits exactly one started event for one generate()', async () => {
    mockGenerateContent.mockResolvedValue(goodResponse())
    await adapter().generate(request())

    expect(of(STARTED)).toHaveLength(1)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
  })

  it('carries only invocationId, role and requestedModel', async () => {
    mockGenerateContent.mockResolvedValue(goodResponse())
    await adapter({ model: 'gemini-3.6-flash' }).generate(request('validator'))

    const started = of(STARTED)[0]
    expect(Object.keys(started).sort()).toEqual(
      ['event', 'invocationId', 'requestedModel', 'role'].sort()
    )
    expect(started.role).toBe('validator')
    expect(started.requestedModel).toBe('gemini-3.6-flash')
    expect(String(started.invocationId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  it('emits NOTHING when a mock provider answers — a test double is not the provider', async () => {
    const mockProvider: StellaMockProvider = {
      async generate(): Promise<StellaResponse> {
        return { role: 'advisor', rawOutput: '{}', parsedOutput: null, modelUsed: 'mock', timestamp: new Date() }
      },
    }
    await new StellaGeminiAdapter({ apiKey: API_KEY, mockProvider }).generate(request())

    expect(emitted).toHaveLength(0)
  })
})

describe('a successful response produces exactly one COMPLETED with the same id', () => {
  it('pairs completed to started', async () => {
    mockGenerateContent.mockResolvedValue(goodResponse())
    await adapter().generate(request())

    expect(of(COMPLETED)).toHaveLength(1)
    expect(of(FAILED)).toHaveLength(0)
    expect(ids(COMPLETED)).toEqual(ids(STARTED))
  })

  it('projects the provider metadata through the SAME allowlist, and adds latencyMs', async () => {
    mockGenerateContent.mockResolvedValue(goodResponse())
    await adapter().generate(request())

    const completed = of(COMPLETED)[0]
    expect(completed).toMatchObject({
      event: COMPLETED,
      role: 'advisor',
      providerModelVersion: 'gemini-3.6-flash-001',
      responseId: 'resp-abc',
      finishReason: 'STOP',
      promptTokenCount: 1632,
      candidatesTokenCount: 391,
      thoughtsTokenCount: 1396,
      totalTokenCount: 3419,
    })
    expect(typeof completed.latencyMs).toBe('number')
    expect(completed.latencyMs as number).toBeGreaterThanOrEqual(0)
  })

  it('an EMPTY provider answer still COMPLETED the invocation — the parse failure is downstream', async () => {
    // The provider answered; `rawOutput` being empty is our contract failing,
    // not the invocation failing. Emitting FAILED here would put started=1,
    // completed=1, failed=1 on one invocation and break the cardinality rule.
    mockGenerateContent.mockResolvedValue(goodResponse({ text: '' }))

    await expect(adapter().generate(request())).rejects.toBeInstanceOf(StellaParseError)

    expect(of(STARTED)).toHaveLength(1)
    expect(of(COMPLETED)).toHaveLength(1)
    expect(of(FAILED)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3-4. The failure lifecycle
// ---------------------------------------------------------------------------

describe('a provider error produces exactly one FAILED with the same id', () => {
  it('categorises an ApiError carrying a status as PROVIDER_ERROR', async () => {
    mockGenerateContent.mockRejectedValue(
      Object.assign(new Error('403 API key blocked: ' + API_KEY), { status: 403 })
    )
    await expect(adapter().generate(request())).rejects.toBeInstanceOf(StellaGeminiError)

    expect(of(STARTED)).toHaveLength(1)
    expect(of(COMPLETED)).toHaveLength(0)
    expect(of(FAILED)).toHaveLength(1)
    expect(ids(FAILED)).toEqual(ids(STARTED))
    expect(of(FAILED)[0].failureCategory).toBe('PROVIDER_ERROR')
  })

  it('categorises everything else as UNKNOWN_PROVIDER_ERROR', async () => {
    mockGenerateContent.mockRejectedValue(new Error('socket hang up'))
    await expect(adapter().generate(request())).rejects.toBeInstanceOf(StellaGeminiError)

    expect(of(FAILED)[0].failureCategory).toBe('UNKNOWN_PROVIDER_ERROR')
  })

  it('carries only the allowlisted keys', async () => {
    mockGenerateContent.mockRejectedValue(new Error('socket hang up'))
    await expect(adapter().generate(request())).rejects.toThrow()

    expect(Object.keys(of(FAILED)[0]).sort()).toEqual(
      ['event', 'failureCategory', 'invocationId', 'latencyMs', 'requestedModel', 'role'].sort()
    )
  })
})

describe('a timeout produces STARTED + FAILED and NEVER COMPLETED', () => {
  it('categorises the abort as TIMEOUT', async () => {
    vi.useFakeTimers()
    mockGenerateContent.mockImplementation((req: { config?: { abortSignal?: AbortSignal } }) => {
      const signal = req?.config?.abortSignal
      return new Promise((_res, reject) => {
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        )
      })
    })

    const call = adapter({ timeoutMs: 40 }).generate(request())
    const assertion = expect(call).rejects.toBeInstanceOf(StellaTimeoutError)
    await vi.advanceTimersByTimeAsync(40)
    await assertion

    expect(of(STARTED)).toHaveLength(1)
    expect(of(COMPLETED)).toHaveLength(0)
    expect(of(FAILED)).toHaveLength(1)
    expect(of(FAILED)[0].failureCategory).toBe('TIMEOUT')
    expect(ids(FAILED)).toEqual(ids(STARTED))
  })
})

// ---------------------------------------------------------------------------
// 5. PB-01 becomes observable
// ---------------------------------------------------------------------------

describe('PB-01 is observable: every invocation is distinguishable', () => {
  // ---------------------------------------------------------------------------
  // WHY THERE IS NO `Promise.all` IN THIS FILE
  // ---------------------------------------------------------------------------
  // The obvious test — two adapters under `Promise.all` — CANNOT BE WRITTEN
  // SAFELY in this repository today. Measured on a minimal probe containing no
  // code of ours beyond the adapter:
  //
  //     two adapters, SEQUENTIAL   -> vi.mock('@google/genai') applies
  //     two adapters, CONCURRENT   -> the mock is BYPASSED and a real HTTPS
  //                                   request reaches generativelanguage.googleapis.com
  //
  // Two concurrent `await import('@google/genai')` calls defeat Vitest's module
  // mock, and the adapter resolves the REAL SDK. Warming the module registry
  // with a sequential call first does not help. See the harness finding
  // registered in docs/ops/G1_B_POST_GATE_PILOT_BLOCKERS.md (HZ-01).
  //
  // So the property is established where it actually lives instead. This is not
  // a weaker test — it is a test of the right thing:
  //
  //   * `newProviderInvocationId()` is called ONCE PER INVOCATION, inside
  //     `generateWithTimeout`, unconditionally. Nothing upstream — ticket,
  //     adapter, request — can collapse two invocations into one id, and the
  //     sequential case below proves exactly that.
  //   * The cardinality contract the runbook greps for is about counting
  //     DISTINCT ids in a window, which is a property of the ids and the
  //     emitters, not of whether the two calls overlapped in time.

  it('the SAME adapter instance reused twice mints two ids — the id is per INVOCATION', async () => {
    // The defect PB-01 describes is two deliveries of ONE ticket, which share
    // everything upstream. If anything shared produced the id, the counter
    // would report 1 where 2 happened — which is the whole failure mode.
    mockGenerateContent.mockResolvedValue(goodResponse())
    const shared = adapter()

    await shared.generate(request())
    await shared.generate(request())

    expect(of(STARTED)).toHaveLength(2)
    expect(ids(STARTED)).toHaveLength(2)
    expect(of(COMPLETED)).toHaveLength(2)
    expect(ids(COMPLETED).sort()).toEqual(ids(STARTED).sort())
  })

  it('the id generator never repeats across many invocations', async () => {
    const { newProviderInvocationId } = await import('./provider-call-log')
    const minted = Array.from({ length: 500 }, () => newProviderInvocationId())
    expect(new Set(minted).size).toBe(500)
  })

  it('N interleaved invocations yield N distinct started events — the PB-01 signature', async () => {
    // Emitted directly, in the order a real interleaving would produce them:
    // started, started, completed, completed. This is the log shape an operator
    // would find in a Vercel window if PB-01 fired, next to ONE ticket, ONE
    // interaction and ONE settlement.
    const { emitProviderCallStarted, emitProviderCallCompleted, newProviderInvocationId } =
      await import('./provider-call-log')
    const a = { invocationId: newProviderInvocationId(), role: 'advisor', requestedModel: 'gemini-3.6-flash' }
    const b = { invocationId: newProviderInvocationId(), role: 'advisor', requestedModel: 'gemini-3.6-flash' }
    const metadata = { usage: { totalTokenCount: 10 }, usageAvailable: true }

    emitProviderCallStarted(a)
    emitProviderCallStarted(b)
    emitProviderCallCompleted(a, metadata, 100)
    emitProviderCallCompleted(b, metadata, 120)

    expect(ids(STARTED)).toHaveLength(2)
    expect(ids(COMPLETED)).toHaveLength(2)
    // The assertion an operator makes: more than one started in a window where
    // the ledger says one.
    expect(of(STARTED).length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// 6-7. Privacy
// ---------------------------------------------------------------------------

describe('no event ever carries content or a credential', () => {
  const FORBIDDEN = [PROMPT, MESSAGE, API_KEY, 'do-not-log']

  async function everyEventSerialized(): Promise<string> {
    return JSON.stringify(emitted)
  }

  it('success path leaks nothing', async () => {
    mockGenerateContent.mockResolvedValue(
      goodResponse({ text: JSON.stringify({ secret: 'RAW-RESPONSE-CANARY' }) })
    )
    await adapter().generate(request())

    const serialized = await everyEventSerialized()
    for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden)
    expect(serialized).not.toContain('RAW-RESPONSE-CANARY')
  })

  it('failure path leaks nothing, including an error message that echoes the key', async () => {
    mockGenerateContent.mockRejectedValue(
      Object.assign(new Error(`403 blocked key=${API_KEY} body=${MESSAGE}`), { status: 403 })
    )
    await expect(adapter().generate(request())).rejects.toThrow()

    const serialized = await everyEventSerialized()
    for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden)
    expect(serialized).not.toContain('403 blocked')
  })

  it('never carries a header, an authorization value or a thought', async () => {
    mockGenerateContent.mockResolvedValue(
      goodResponse({
        headers: { authorization: 'Bearer LEAK' },
        candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'THOUGHT-CANARY' }] } }],
      })
    )
    await adapter().generate(request())

    const serialized = await everyEventSerialized()
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('THOUGHT-CANARY')
  })

  it('a HOSTILE provider response cannot widen the allowlist', async () => {
    // Extra keys, a nested object where a counter belongs, and a usageMetadata
    // carrying free text. The event must still be exactly the declared shape.
    mockGenerateContent.mockResolvedValue({
      text: '{}',
      modelVersion: 'gemini-3.6-flash-001',
      responseId: 'resp-abc',
      candidates: [{ finishReason: 'STOP' }],
      injectedTopLevel: 'HOSTILE-TOP-LEVEL',
      usageMetadata: {
        promptTokenCount: 10,
        totalTokenCount: { nested: 'HOSTILE-NESTED' },
        candidatesTokenCount: -5,
        thoughtsTokenCount: Number.NaN,
        injectedUsage: 'HOSTILE-USAGE',
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
      },
    })
    await adapter().generate(request())

    const completed = of(COMPLETED)[0]
    const serialized = JSON.stringify(completed)
    expect(serialized).not.toContain('HOSTILE')
    expect(serialized).not.toContain('injected')
    expect(serialized).not.toContain('promptTokensDetails')
    // Non-finite and negative counters are DROPPED, never coerced.
    expect(completed).not.toHaveProperty('totalTokenCount')
    expect(completed).not.toHaveProperty('candidatesTokenCount')
    expect(completed).not.toHaveProperty('thoughtsTokenCount')
    expect(completed.promptTokenCount).toBe(10)

    const allowed = new Set([
      'event', 'invocationId', 'role', 'requestedModel', 'latencyMs',
      'providerModelVersion', 'responseId', 'finishReason',
      'promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount',
      'totalTokenCount', 'cachedContentTokenCount',
    ])
    for (const key of Object.keys(completed)) expect(allowed.has(key)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. Observability must never take down a valid call
// ---------------------------------------------------------------------------

describe('a failing log sink never changes Stella semantics', () => {
  it('a throwing console.info does not fail a successful generate()', async () => {
    infoSpy.mockImplementation(() => {
      throw new Error('log sink exploded')
    })
    mockGenerateContent.mockResolvedValue(goodResponse())

    const response = await adapter().generate(request())

    expect(response.rawOutput).toBe(JSON.stringify({ ok: true }))
    expect(response.modelUsed).toBeTruthy()
  })

  it('a throwing console.info does not change the error a failed generate() raises', async () => {
    infoSpy.mockImplementation(() => {
      throw new Error('log sink exploded')
    })
    mockGenerateContent.mockRejectedValue(new Error('socket hang up'))

    await expect(adapter().generate(request())).rejects.toBeInstanceOf(StellaGeminiError)
  })
})
