// scripts/stella-pilot-preflight.ts
// Etapa B0 (modo piloto restringido) — local-only readiness check for the
// controlled pilot. Entry point: `pnpm stella:pilot:preflight`.
//
// Prints ONLY a per-check PASS/FAIL/NOT VERIFIED line and a final verdict —
// never an allowlist ID, an env var's raw value, an API key, a prompt, or
// any other secret. Never mutates anything: pure read of process.env plus
// getStellaPilotConfig()/stellaConfig, no DB connection, no network call.
//
// Distinguishes two categories, per the encargo's explicit instruction that
// an API key or a config flag is never proof of a paid tier:
//   - "verifiable from code": every flag this script inspects.
//   - "NOT VERIFIED": actual active billing, a billing account, and the
//     contractual terms of the Gemini paid tier. No script can check these —
//     only the organization's owner can confirm them, which is exactly what
//     STELLA_PILOT_PAID_GEMINI_CONFIRMED represents. This script treats that
//     flag as a REPORTED claim, not independent proof, and says so.

import * as dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

type CheckStatus = 'PASS' | 'FAIL' | 'NOT VERIFIED'

interface CheckResult {
  name: string
  status: CheckStatus
  note?: string
}

async function main() {
  const { getStellaPilotConfig } = await import('../lib/stella/pilot/config')
  const { stellaConfig } = await import('../lib/stella/config')

  const config = getStellaPilotConfig()
  const results: CheckResult[] = []

  results.push({
    name: 'Kill switch inactive',
    status: config.killSwitch ? 'FAIL' : 'PASS',
    note: config.killSwitch ? 'STELLA_PILOT_KILL_SWITCH=true — every pilot request is blocked' : undefined,
  })

  results.push({
    name: 'Pilot mode enabled (STELLA_PILOT_MODE=true)',
    status: config.enabled ? 'PASS' : 'FAIL',
  })

  results.push({
    name: 'Global Stella flag enabled (STELLA_ENABLED=true)',
    status: stellaConfig.isEnabled ? 'PASS' : 'FAIL',
  })

  results.push({
    name: 'Advisor role flag enabled (STELLA_ADVISOR_ENABLED=true)',
    status: stellaConfig.isAdvisorEnabled ? 'PASS' : 'FAIL',
    note: config.enabledStellaRoles.has('advisor') ? undefined : 'advisor is also absent from the pilot role allowlist',
  })

  results.push({
    name: 'Organization allowlist non-empty',
    status: config.allowedOrganizationIds.size > 0 ? 'PASS' : 'FAIL',
    note: `${config.allowedOrganizationIds.size} organization(s) configured (count only — IDs are never printed)`,
  })

  const userGateOpen = config.allowAllUsersInAllowedOrganizations || config.allowedUserIds.size > 0
  results.push({
    name: 'User gate open (explicit allowlist or org-wide opt-in)',
    status: userGateOpen ? 'PASS' : 'FAIL',
    note: config.allowAllUsersInAllowedOrganizations
      ? 'STELLA_PILOT_ALLOW_ALL_ORG_USERS=true'
      : `${config.allowedUserIds.size} user(s) configured (count only)`,
  })

  results.push({
    name: 'Provider mode configured (not "disabled")',
    status: config.providerMode !== 'disabled' ? 'PASS' : 'FAIL',
    note: `providerMode=${config.providerMode}`,
  })

  if (config.providerMode === 'paid_gemini') {
    results.push({
      name: 'GEMINI_API_KEY present (existence only — never printed)',
      status: stellaConfig.geminiApiKey.length > 0 ? 'PASS' : 'FAIL',
    })
    results.push({
      name: 'STELLA_PILOT_PAID_GEMINI_CONFIRMED=true (reported by the owner)',
      status: config.paidGeminiConfirmed ? 'PASS' : 'FAIL',
      note: 'this flag is a claim recorded in configuration, not independent proof — see the next line',
    })
    results.push({
      name: 'Active paid billing, billing account, and contractual terms',
      status: 'NOT VERIFIED',
      note: 'cannot be checked from code by design — requires the organization owner to confirm outside this script before any real call is made',
    })
  } else {
    results.push({
      name: 'Paid-tier checks',
      status: 'NOT VERIFIED',
      note: 'providerMode is not "paid_gemini" — paid-tier gates do not apply (mock or disabled mode)',
    })
  }

  results.push({
    name: 'Notice version configured',
    status: config.noticeVersion ? 'PASS' : 'FAIL',
    note: 'value not printed',
  })

  console.log('[stella:pilot:preflight] Etapa B0 readiness check\n')
  for (const r of results) {
    const line = `  [${r.status.padEnd(11)}] ${r.name}`
    console.log(r.note ? `${line}\n              ${r.note}` : line)
  }

  const anyFail = results.some((r) => r.status === 'FAIL')
  const anyNotVerified = results.some((r) => r.status === 'NOT VERIFIED')

  console.log('')
  if (anyFail) {
    console.log('[stella:pilot:preflight] Result: FAIL — at least one code-verifiable check failed. No real call should be attempted.')
  } else if (anyNotVerified) {
    console.log(
      '[stella:pilot:preflight] Result: PASS (code-verifiable checks) — but items marked NOT VERIFIED require ' +
        'explicit, separate confirmation from the organization owner before any real paid-tier call.',
    )
  } else {
    console.log('[stella:pilot:preflight] Result: PASS — all checks satisfied.')
  }

  process.exit(anyFail ? 1 : 0)
}

main().catch((err) => {
  console.error('[stella:pilot:preflight] Failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
