// tests/sentry-telemetry-boundary.test.ts
//
// F-GB-02, Phases I/J/K: nothing personal and nothing secret reaches Sentry.
//
// The assertions run against the hook the RUNTIME CONFIG ACTUALLY REGISTERS,
// recovered by mocking `Sentry.init` and importing the config module. Testing
// the sanitizer in isolation would prove the function works while saying
// nothing about whether it is wired — and "wired on server but not on edge"
// is precisely the shape of gap this closes.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SYNTHETIC_GEMINI_KEY,
  SYNTHETIC_PG_DSN,
  SYNTHETIC_PG_PASSWORD,
  SYNTHETIC_JWT,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_SUPABASE_PAT,
  SYNTHETIC_COOKIE_VALUE,
  SYNTHETIC_URL_WITH_QUERY_TOKEN,
  SYNTHETIC_EMAIL,
  SYNTHETIC_PHONE_INTL,
  SYNTHETIC_CEDULA_DIGITS,
  ALL_SYNTHETIC_SECRETS,
} from './fixtures/synthetic-credentials'

type SentryOptions = Record<string, unknown>
type BeforeSend = (event: unknown, hint?: unknown) => unknown

/**
 * Load one runtime config with `Sentry.init` mocked, and hand back the options
 * it registered. `resetModules` matters: the config modules run their side
 * effect at import time and would otherwise be served from cache.
 */
async function loadRuntimeConfig(modulePath: string): Promise<SentryOptions> {
  const captured: SentryOptions[] = []
  vi.resetModules()
  vi.doMock('@sentry/nextjs', () => ({
    init: (options: SentryOptions) => {
      captured.push(options)
    },
    captureException: vi.fn(),
    captureRequestError: vi.fn(),
    captureRouterTransitionStart: vi.fn(),
    replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  }))
  await import(modulePath)
  expect(captured, `${modulePath} never called Sentry.init`).toHaveLength(1)
  return captured[0]!
}

const RUNTIMES: ReadonlyArray<[string, string]> = [
  ['server', '@/sentry.server.config'],
  ['edge', '@/sentry.edge.config'],
  ['client', '@/instrumentation-client'],
]

describe('every Sentry runtime registers the final scrub', () => {
  for (const [label, modulePath] of RUNTIMES) {
    it(`${label} runtime wires beforeSend and beforeSendTransaction`, async () => {
      const options = await loadRuntimeConfig(modulePath)
      expect(options.beforeSend, `${label} has no beforeSend`).toBeTypeOf('function')
      expect(options.beforeSendTransaction, `${label} has no beforeSendTransaction`).toBeTypeOf(
        'function'
      )
    })

    it(`${label} runtime's registered hook actually redacts`, async () => {
      // MUTATION GUARD. A hook could be present and be `(e) => e`. This drives
      // a credential through the real registered function.
      const options = await loadRuntimeConfig(modulePath)
      const beforeSend = options.beforeSend as BeforeSend
      const out = beforeSend({ message: `key ${SYNTHETIC_GEMINI_KEY}` })
      expect(JSON.stringify(out)).not.toContain(SYNTHETIC_GEMINI_KEY)
    })
  }
})

describe('poisoned event corpus — every field the SDK can carry', () => {
  let beforeSend: BeforeSend

  beforeEach(async () => {
    beforeSend = (await loadRuntimeConfig('@/sentry.server.config')).beforeSend as BeforeSend
  })

  /** A worst-case event: a credential or a person in every slot at once. */
  function poisonedEvent() {
    return {
      event_id: 'e1',
      level: 'error',
      message: `Fallo con ${SYNTHETIC_GEMINI_KEY} para ${SYNTHETIC_EMAIL}`,
      exception: {
        values: [
          {
            type: 'StellaGeminiError',
            value: `Gemini 403: ${SYNTHETIC_GEMINI_KEY} bloqueada, tel ${SYNTHETIC_PHONE_INTL}`,
            stacktrace: {
              frames: [
                {
                  filename: `/app/lib/stella.ts?token=${SYNTHETIC_SUPABASE_PAT}`,
                  function: 'generate',
                  lineno: 42,
                  pre_context: [`const dsn = "${SYNTHETIC_PG_DSN}"`],
                  vars: { apiKey: SYNTHETIC_GEMINI_KEY, role: 'advisor' },
                },
              ],
            },
          },
          {
            // The linked-errors integration expands `cause` into a second
            // entry. Phase K: a nested cause must not be a way round the hook.
            type: 'Error',
            value: `causa raíz: DATABASE_URL=${SYNTHETIC_PG_DSN}`,
          },
        ],
      },
      breadcrumbs: [
        {
          category: 'fetch',
          message: `GET ${SYNTHETIC_URL_WITH_QUERY_TOKEN}`,
          data: { authorization: `Bearer ${SYNTHETIC_BEARER_TOKEN}`, status: 403 },
        },
      ],
      request: {
        url: SYNTHETIC_URL_WITH_QUERY_TOKEN,
        query_string: `key=${SYNTHETIC_GEMINI_KEY}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${SYNTHETIC_BEARER_TOKEN}`,
          cookie: SYNTHETIC_COOKIE_VALUE,
          'set-cookie': SYNTHETIC_COOKIE_VALUE,
          'x-api-key': SYNTHETIC_GEMINI_KEY,
          'user-agent': 'Mozilla/5.0',
        },
        data: { narrative: `Contacto ${SYNTHETIC_EMAIL}, cédula ${SYNTHETIC_CEDULA_DIGITS}` },
      },
      contexts: {
        runtime: { name: 'node', version: '24' },
        app: { session: SYNTHETIC_JWT },
      },
      extra: {
        prompt: `UNTRUSTED_PROJECT_DATA {"projectName":"Programa ${SYNTHETIC_EMAIL}"}`,
        promptChars: 1200,
        nested: { deeper: [{ token: SYNTHETIC_SUPABASE_PAT }] },
      },
      tags: { stella_role: 'advisor', error_code: 'GEMINI_ERROR', leaked: SYNTHETIC_GEMINI_KEY },
      user: { id: 'user-1', email: SYNTHETIC_EMAIL, ip_address: '10.0.0.1' },
    }
  }

  it('leaves no synthetic secret anywhere in the outgoing event', () => {
    const serialized = JSON.stringify(beforeSend(poisonedEvent()))
    for (const secret of ALL_SYNTHETIC_SECRETS) {
      if (!JSON.stringify(poisonedEvent()).includes(secret)) continue
      expect(serialized, `leaked ${secret.slice(0, 10)}…`).not.toContain(secret)
    }
    expect(serialized).not.toContain(SYNTHETIC_PG_PASSWORD)
  })

  it('leaves no synthetic personal data anywhere in the outgoing event', () => {
    const serialized = JSON.stringify(beforeSend(poisonedEvent()))
    expect(serialized).not.toContain(SYNTHETIC_EMAIL)
    expect(serialized).not.toContain(SYNTHETIC_PHONE_INTL)
    expect(serialized).not.toContain(SYNTHETIC_CEDULA_DIGITS)
  })

  it('strips sensitive request headers by NAME, whatever they contain', () => {
    const out = beforeSend(poisonedEvent()) as {
      request: { headers: Record<string, string> }
    }
    // An opaque session id has no recognisable shape — only the header name
    // marks it — so these are removed on the strength of the key alone.
    expect(out.request.headers.authorization).toBe('[REDACTED:sensitive-key]')
    expect(out.request.headers.cookie).toBe('[REDACTED:sensitive-key]')
    expect(out.request.headers['set-cookie']).toBe('[REDACTED:sensitive-key]')
    expect(out.request.headers['x-api-key']).toBe('[REDACTED:sensitive-key]')
    // Non-sensitive headers survive: they are how an issue gets triaged.
    expect(out.request.headers['user-agent']).toBe('Mozilla/5.0')
  })

  it('preserves everything Sentry needs to group and triage the issue', () => {
    const out = beforeSend(poisonedEvent()) as {
      event_id: string
      level: string
      exception: { values: Array<{ type: string; stacktrace?: { frames: Array<{ lineno: number; function: string }> } }> }
      tags: Record<string, string>
      request: { method: string }
      extra: Record<string, unknown>
    }
    expect(out.event_id).toBe('e1')
    expect(out.level).toBe('error')
    // The error CLASS is the grouping signal and is never credential-shaped.
    expect(out.exception.values[0]!.type).toBe('StellaGeminiError')
    expect(out.exception.values[1]!.type).toBe('Error')
    expect(out.exception.values[0]!.stacktrace!.frames[0]!.lineno).toBe(42)
    expect(out.exception.values[0]!.stacktrace!.frames[0]!.function).toBe('generate')
    expect(out.tags.stella_role).toBe('advisor')
    expect(out.tags.error_code).toBe('GEMINI_ERROR')
    expect(out.request.method).toBe('POST')
    expect(out.extra.promptChars).toBe(1200)
  })

  it('reaches into stack-frame locals and pre_context', () => {
    const out = beforeSend(poisonedEvent()) as {
      exception: { values: Array<{ stacktrace?: { frames: Array<{ vars: Record<string, string>; pre_context: string[] }> } }> }
    }
    const frame = out.exception.values[0]!.stacktrace!.frames[0]!
    expect(frame.vars.apiKey).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(frame.vars.role).toBe('advisor')
    expect(frame.pre_context[0]).not.toContain(SYNTHETIC_PG_PASSWORD)
  })

  it('reaches arbitrarily deep into extra', () => {
    const out = beforeSend(poisonedEvent()) as {
      extra: { nested: { deeper: Array<{ token: string }> } }
    }
    expect(out.extra.nested.deeper[0]!.token).toBe('[REDACTED:sensitive-key]')
  })
})

describe('the scrub cannot be defeated by the shape of the event', () => {
  let beforeSend: BeforeSend

  beforeEach(async () => {
    beforeSend = (await loadRuntimeConfig('@/sentry.server.config')).beforeSend as BeforeSend
  })

  it('handles a cyclic event without throwing or leaking', () => {
    const event: Record<string, unknown> = { message: `key ${SYNTHETIC_GEMINI_KEY}` }
    event.self = event
    let out: unknown
    expect(() => {
      out = beforeSend(event)
    }).not.toThrow()
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_GEMINI_KEY)
  })

  it('handles a hostile getter without forwarding the raw event', () => {
    const event = {
      message: 'ok',
      get exception(): never {
        throw new Error('hostile getter')
      },
    }
    let out: unknown
    expect(() => {
      out = beforeSend(event)
    }).not.toThrow()
    // Fail-closed: whatever comes back, it is not the original object.
    //
    // Identity is compared as a BOOLEAN rather than with
    // `expect(out).not.toBe(event)`. Vitest's `toBe` computes a "same
    // structure, different reference?" hint whenever Object.is returns false
    // — before `.not` inverts the result — and that hint deep-traverses both
    // operands, invoking the very getter this fixture uses to be hostile. The
    // assertion would pass and then explode building a message it never
    // needed. Same reason below, for the proxy.
    expect(Object.is(out, event)).toBe(false)
  })

  it('falls back to a content-free event when the ROOT cannot be walked', () => {
    // A proxy whose `ownKeys` throws defeats the walk at the top level. The
    // hook must still return something event-SHAPED carrying the alert and no
    // content — not the raw object, and not the bare error token.
    const hostileRoot = new Proxy(
      { event_id: 'e9', level: 'error', secret: SYNTHETIC_GEMINI_KEY },
      {
        ownKeys() {
          throw new Error('ownKeys refused')
        },
      }
    )

    let out: unknown
    expect(() => {
      out = beforeSend(hostileRoot)
    }).not.toThrow()

    expect(Object.is(out, hostileRoot)).toBe(false)
    expect(typeof out).toBe('object')
    expect(out).not.toBeNull()
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_GEMINI_KEY)
    // The alert survives even though the content did not — an on-call engineer
    // still learns that something broke.
    expect((out as { message: string }).message).toBe('[REDACTED:telemetry-sanitizer-failed]')
    expect((out as { tags: Record<string, string> }).tags.redaction).toBe('failed_closed')
  })

  it('scrubs even the scalars the fallback carries across', () => {
    // The fallback runs precisely when the normal scrub did NOT, so the few
    // fields it forwards cannot be assumed clean just because the SDK usually
    // populates them.
    //
    // Both fixtures are SHAPED credentials, which is the honest scope of this
    // guarantee. A bare opaque token — no prefix, no sensitive key name, no
    // surrounding context — is indistinguishable from a build id or a release
    // name, and nothing here claims to catch it. See §4 of
    // docs/ops/FGB_MODEL_BOUNDARY.md.
    const hostileRoot = new Proxy(
      { event_id: `e-${SYNTHETIC_GEMINI_KEY}`, release: `v1-${SYNTHETIC_SUPABASE_PAT}`, level: 'error' },
      {
        ownKeys() {
          throw new Error('ownKeys refused')
        },
      }
    )

    const out = beforeSend(hostileRoot)
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(serialized).not.toContain(SYNTHETIC_SUPABASE_PAT)
    // The non-sensitive scalar still survives, so the alert stays useful.
    expect((out as { level: string }).level).toBe('error')
  })

  it('never returns the input object itself (which would bypass the scrub)', () => {
    const event = { message: `key ${SYNTHETIC_GEMINI_KEY}` }
    expect(beforeSend(event)).not.toBe(event)
    // And the caller's object is untouched.
    expect(event.message).toContain(SYNTHETIC_GEMINI_KEY)
  })

  it('is idempotent — a second pass changes nothing', () => {
    const once = beforeSend({
      message: `key ${SYNTHETIC_GEMINI_KEY}`,
      request: { headers: { authorization: `Bearer ${SYNTHETIC_BEARER_TOKEN}` } },
    })
    expect(beforeSend(once)).toEqual(once)
  })
})

describe('Phase K — synthetic error paths through the real pipeline', () => {
  let beforeSend: BeforeSend

  beforeEach(async () => {
    beforeSend = (await loadRuntimeConfig('@/sentry.server.config')).beforeSend as BeforeSend
  })

  /** Mirrors how the SDK serializes an Error chain into `exception.values`. */
  function eventFromErrorChain(...messages: string[]) {
    return {
      exception: { values: messages.map((value) => ({ type: 'Error', value })) },
    }
  }

  it('strips a secret from message, cause and nested cause alike', () => {
    const out = JSON.stringify(
      beforeSend(
        eventFromErrorChain(
          `nivel 1: ${SYNTHETIC_GEMINI_KEY}`,
          `nivel 2 (cause): ${SYNTHETIC_PG_DSN}`,
          `nivel 3 (nested cause): ${SYNTHETIC_JWT}`
        )
      )
    )
    expect(out).not.toContain(SYNTHETIC_GEMINI_KEY)
    expect(out).not.toContain(SYNTHETIC_PG_PASSWORD)
    expect(out).not.toContain(SYNTHETIC_JWT)
  })

  it('strips a secret arriving as a provider response body echo', () => {
    const out = JSON.stringify(
      beforeSend({
        exception: {
          values: [
            {
              type: 'StellaGeminiError',
              value: `400 Bad Request: {"error":{"message":"API key not valid","key":"${SYNTHETIC_GEMINI_KEY}"}}`,
            },
          ],
        },
      })
    )
    expect(out).not.toContain(SYNTHETIC_GEMINI_KEY)
  })

  it('strips a secret arriving as a database error', () => {
    const out = JSON.stringify(
      beforeSend(
        eventFromErrorChain(`password authentication failed for connection ${SYNTHETIC_PG_DSN}`)
      )
    )
    expect(out).not.toContain(SYNTHETIC_PG_PASSWORD)
  })
})
