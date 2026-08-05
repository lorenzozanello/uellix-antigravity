// tests/eval/stella-release/wiring.test.ts
// Train 2 shared-root prep: structural check that the release harness is
// reachable as a named package.json script, and that the entrypoint it
// points to stays offline — no network, no secrets, no provider activation.
// Does not execute the harness (harness.test.ts already covers behavior).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(__dirname, '..', '..', '..')
const readRoot = (...segments: string[]) => readFileSync(path.join(ROOT, ...segments), 'utf8')

describe('release harness package.json wiring', () => {
  const pkg = JSON.parse(readRoot('package.json')) as { scripts: Record<string, string> }

  it('declares test:stella:release-eval pointing at the offline release harness', () => {
    expect(pkg.scripts['test:stella:release-eval']).toBe('tsx scripts/eval-release-offline.ts')
  })

  it('scripts/eval-release-offline.ts exists at the referenced path', () => {
    expect(() => readRoot('scripts', 'eval-release-offline.ts')).not.toThrow()
  })

  it('the harness entrypoint makes no network calls', () => {
    const entrypoint = readRoot('scripts', 'eval-release-offline.ts')
    expect(entrypoint).not.toMatch(/\bfetch\(/)
    expect(entrypoint).not.toMatch(/https?:\/\//)
    expect(entrypoint).not.toMatch(/XMLHttpRequest|axios|WebSocket/)
  })

  it('the harness entrypoint contains no secrets or credential-shaped values', () => {
    const entrypoint = readRoot('scripts', 'eval-release-offline.ts')
    expect(entrypoint).not.toMatch(/GEMINI_API_KEY|STRIPE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL/)
    expect(entrypoint).not.toMatch(/process\.env/)
  })

  it('the harness entrypoint does not activate any provider or feature flag', () => {
    const entrypoint = readRoot('scripts', 'eval-release-offline.ts')
    expect(entrypoint).not.toMatch(/STELLA_[A-Z_]*_ENABLED\s*=\s*true/)
    expect(entrypoint).not.toMatch(/@google\/genai/)
  })
})
