// app/app/projects/[projectId]/__tests__/grounded-query-readiness.test.ts
// N8 — THE UI MUST ASK THE SAME READINESS QUESTION THE SERVER ACTION ASKS.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS PINS
// ---------------------------------------------------------------------------
// `runStellaGroundedQuery` and `issueStellaGroundedQueryTicket` both gate on
// `isStellaCapabilityReady('grounded_query')` (G-03), and `grounded_query` is
// deliberately NOT in `GEMINI_BACKED_STELLA_CAPABILITIES`: its answers come
// from `createExtractiveAnswerProvider`, which quotes retrieved passages and
// never opens a socket to a provider.
//
// `StellaGroundedQuerySection` mirrored the OLD gate instead:
//
//   stellaConfig.isEnabled && stellaConfig.isGroundedQueryEnabled
//     && stellaState.canUseStella
//
// and `stellaState.canUseStella` still requires a non-blank `GEMINI_API_KEY`.
// So on a deployment with the two grounded-query flags on and no Gemini key,
// the SERVER was ready and the UI rendered the panel inert — a readiness
// mismatch, not a policy. The panel is the only way a human reaches the
// action, so the capability was unreachable for a reason it does not have.
//
// ---------------------------------------------------------------------------
// WHY THESE TESTS LOAD THE REAL AUTHORITY
// ---------------------------------------------------------------------------
// `stellaConfig`, `stellaState` and `capability-readiness` are all REAL here,
// re-imported per case after `vi.stubEnv` + `vi.resetModules()` (the pattern
// `lib/stella/__tests__/eligibility-hygiene.test.ts` uses), because a mocked
// readiness table would make the mismatch untestable by construction — it is
// precisely the disagreement BETWEEN two real readers that these pin.
//
// Only two things are mocked, and neither decides readiness: the server-action
// module (imported solely for its two `.bind` targets, and it pulls `db/**`
// and `node:crypto` into a jsdom test that has no business loading them) and
// the component barrel (the panel is never rendered — the section's returned
// element is read as data, so `enabled` is observed exactly as the panel would
// have received it).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@/app/actions/stella/grounded-query', () => ({
  runStellaGroundedQueryForProject: async () => ({
    status: 'error',
    code: 'DISABLED',
    message: '',
  }),
  issueStellaGroundedQueryTicketForProject: async () => ({ status: 'disabled' }),
}))

vi.mock('@/components/stella', () => ({
  StellaGroundedQueryPanel: () => null,
}))

interface Deployment {
  /** STELLA_ENABLED */
  stella: boolean
  /** STELLA_GROUNDED_QUERY_ENABLED */
  groundedQuery: boolean
  /** GEMINI_API_KEY — `null` means the variable is ABSENT, not blank. */
  geminiKey: string | null
}

const SECTION_MODULE = '@/app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection'

/**
 * Loads the section, the readiness table and the config snapshot as ONE
 * deployment, so every value a case compares was produced by the same env.
 */
async function loadDeployment(deployment: Deployment) {
  vi.resetModules()
  vi.stubEnv('STELLA_ENABLED', deployment.stella ? 'true' : 'false')
  vi.stubEnv('STELLA_GROUNDED_QUERY_ENABLED', deployment.groundedQuery ? 'true' : 'false')
  // The advisor is the Gemini-backed capability CASE D uses. Its own flag
  // follows the master switch, so the only thing that can make it unready in a
  // Stella-enabled deployment is the key.
  vi.stubEnv('STELLA_ADVISOR_ENABLED', deployment.stella ? 'true' : 'false')
  vi.stubEnv('GEMINI_API_KEY', deployment.geminiKey ?? undefined)

  const section = await import(SECTION_MODULE)
  const readiness = await import('@/lib/stella/capability-readiness')
  const config = await import('@/lib/stella/config')

  const element = section.StellaGroundedQuerySection({
    projectId: '9d8c0412-2782-4d2e-a1df-e2dfa1e0b3aa',
    step: 'outcomes',
  }) as { props: { enabled: boolean } }

  return { uiEnabled: element.props.enabled, readiness, config }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('CASE A — the master switch refuses first', () => {
  it('leaves the grounded-query UI disabled with STELLA_ENABLED=false', async () => {
    const { uiEnabled, readiness } = await loadDeployment({
      stella: false,
      groundedQuery: true,
      geminiKey: 'AIza-not-a-real-key',
    })

    expect(uiEnabled).toBe(false)
    expect(readiness.stellaCapabilityBlocker('grounded_query')).toBe('master_disabled')
  })

  it('stays disabled with the master off AND no key — one refusal, and it is the broadest', async () => {
    const { uiEnabled, readiness } = await loadDeployment({
      stella: false,
      groundedQuery: true,
      geminiKey: null,
    })

    expect(uiEnabled).toBe(false)
    expect(readiness.stellaCapabilityBlocker('grounded_query')).toBe('master_disabled')
  })
})

describe("CASE B — the capability's own flag refuses", () => {
  it('leaves the UI disabled with STELLA_GROUNDED_QUERY_ENABLED=false', async () => {
    const { uiEnabled, readiness } = await loadDeployment({
      stella: true,
      groundedQuery: false,
      geminiKey: 'AIza-not-a-real-key',
    })

    expect(uiEnabled).toBe(false)
    expect(readiness.stellaCapabilityBlocker('grounded_query')).toBe('capability_disabled')
  })

  it('is not rescued by a present Gemini key', async () => {
    const { uiEnabled } = await loadDeployment({
      stella: true,
      groundedQuery: false,
      geminiKey: 'AIza-not-a-real-key',
    })

    expect(uiEnabled).toBe(false)
  })
})

describe('CASE C — grounded_query is enabled without a Gemini key', () => {
  it('enables the UI when both flags are on and GEMINI_API_KEY is absent', async () => {
    const { uiEnabled, readiness } = await loadDeployment({
      stella: true,
      groundedQuery: true,
      geminiKey: null,
    })

    expect(readiness.isStellaCapabilityReady('grounded_query')).toBe(true)
    expect(uiEnabled).toBe(true)
  })

  it('enables it with a whitespace-only key too — blank is absent, and absent does not block', async () => {
    const { uiEnabled, readiness } = await loadDeployment({
      stella: true,
      groundedQuery: true,
      geminiKey: '   ',
    })

    expect(readiness.stellaCapabilityBlocker('grounded_query')).toBeNull()
    expect(uiEnabled).toBe(true)
  })

  it('does so while canUseStella is false — the term the UI no longer reads', async () => {
    // The decisive assertion. If this ever passes because `canUseStella` went
    // true, the mismatch was closed by weakening the provider requirement
    // instead of by asking the right question.
    const { uiEnabled, config } = await loadDeployment({
      stella: true,
      groundedQuery: true,
      geminiKey: null,
    })

    expect(config.stellaState.canUseStella).toBe(false)
    expect(config.stellaState.missingApiKey).toBe(true)
    expect(uiEnabled).toBe(true)
  })
})

describe('CASE D — capabilities that DO call Gemini still require the key', () => {
  it('keeps the advisor unready without a key, in the very deployment that enables grounded_query', async () => {
    const { uiEnabled, readiness, config } = await loadDeployment({
      stella: true,
      groundedQuery: true,
      geminiKey: null,
    })

    expect(uiEnabled).toBe(true)
    expect(readiness.isStellaCapabilityReady('advisor')).toBe(false)
    expect(readiness.stellaCapabilityBlocker('advisor')).toBe('provider_key_missing')
    // The seven pipeline pages mirror the Gemini-backed gates through
    // `stellaState.canUseStella`; this is the value they read, unchanged.
    expect(config.stellaState.canUseStella).toBe(false)
  })

  it('refuses EVERY Gemini-backed capability without a key', async () => {
    const { readiness } = await loadDeployment({
      stella: true,
      groundedQuery: true,
      geminiKey: null,
    })

    for (const capability of readiness.GEMINI_BACKED_STELLA_CAPABILITIES) {
      expect(readiness.isStellaCapabilityReady(capability)).toBe(false)
    }
    expect(readiness.GEMINI_BACKED_STELLA_CAPABILITIES.has('grounded_query')).toBe(false)
  })
})

describe('CASE E — the UI and the server action cannot disagree', () => {
  const MATRIX: Deployment[] = [
    { stella: false, groundedQuery: false, geminiKey: null },
    { stella: false, groundedQuery: true, geminiKey: null },
    { stella: false, groundedQuery: true, geminiKey: 'AIza-not-a-real-key' },
    { stella: true, groundedQuery: false, geminiKey: null },
    { stella: true, groundedQuery: false, geminiKey: 'AIza-not-a-real-key' },
    { stella: true, groundedQuery: true, geminiKey: null },
    { stella: true, groundedQuery: true, geminiKey: '   ' },
    { stella: true, groundedQuery: true, geminiKey: 'AIza-not-a-real-key' },
  ]

  it('agrees with the capability table on every combination of the three inputs', async () => {
    for (const deployment of MATRIX) {
      const { uiEnabled, readiness } = await loadDeployment(deployment)
      expect(
        uiEnabled,
        `UI disagreed with the capability table for ${JSON.stringify(deployment)}`,
      ).toBe(readiness.isStellaCapabilityReady('grounded_query'))
    }
  })

  it('both grounded-query server entry points gate on the same authority', () => {
    // The matrix above compares the UI to the table. This is the other half:
    // the ACTION reads that same table, at both entry points, for this
    // capability — so "UI == table" and "action == table" compose into
    // "UI == action" without this test having to load `db/**`.
    const action = readFileSync(
      path.join(process.cwd(), 'app/actions/stella/grounded-query.ts'),
      'utf8',
    )
    const gates = [...action.matchAll(/isStellaCapabilityReady\('grounded_query'\)/g)]
    expect(gates.length, 'execution and issuance must both gate on the capability').toBe(2)
    expect(action).toMatch(/from '@\/lib\/stella\/capability-readiness'/)
  })

  it('the section derives enablement from the capability table and from nothing else', () => {
    // Source-scanned because this is a claim about which QUESTION is asked,
    // not about an answer: a section that happened to agree on all eight rows
    // while recomputing the rule locally would pass the matrix and drift on
    // the ninth.
    const source = readFileSync(
      path.join(
        process.cwd(),
        'app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection.tsx',
      ),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

    expect(code).toMatch(/isStellaCapabilityReady\('grounded_query'\)/)
    // The three terms it must no longer re-derive for itself.
    expect(code).not.toMatch(/\bcanUseStella\b/)
    expect(code).not.toMatch(/\bstellaState\b/)
    expect(code).not.toMatch(/\bisGroundedQueryEnabled\b/)
  })
})
