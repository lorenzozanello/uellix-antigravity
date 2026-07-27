// lib/stella/pilot/__tests__/config.test.ts
// Etapa B0 (modo piloto restringido) — pure env parsing, no DB, no auth.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { getStellaPilotConfig, PILOT_MEMBERSHIP_ROLE_ALLOWLIST } from '../config'

describe('getStellaPilotConfig', () => {
  afterEach(() => vi.restoreAllMocks())

  it('defaults to pilot disabled when no env vars are set', () => {
    const config = getStellaPilotConfig({})
    expect(config.enabled).toBe(false)
    expect(config.killSwitch).toBe(false)
    expect(config.providerMode).toBe('disabled')
    expect(config.allowedOrganizationIds.size).toBe(0)
    expect(config.allowedUserIds.size).toBe(0)
    expect(config.allowAllUsersInAllowedOrganizations).toBe(false)
    expect(config.paidGeminiConfirmed).toBe(false)
  })

  it('requireSyntheticDataConfirmation and requireHumanReview are always true, never configurable', () => {
    const config = getStellaPilotConfig({ STELLA_PILOT_MODE: 'true' })
    expect(config.requireSyntheticDataConfirmation).toBe(true)
    expect(config.requireHumanReview).toBe(true)
  })

  it('enables pilot mode only with the exact string "true"', () => {
    expect(getStellaPilotConfig({ STELLA_PILOT_MODE: 'true' }).enabled).toBe(true)
    expect(getStellaPilotConfig({ STELLA_PILOT_MODE: 'TRUE' }).enabled).toBe(false)
    expect(getStellaPilotConfig({ STELLA_PILOT_MODE: '1' }).enabled).toBe(false)
    expect(getStellaPilotConfig({ STELLA_PILOT_MODE: 'yes' }).enabled).toBe(false)
  })

  it('an unrecognized STELLA_PILOT_PROVIDER_MODE fails closed to "disabled"', () => {
    expect(getStellaPilotConfig({ STELLA_PILOT_PROVIDER_MODE: 'real' }).providerMode).toBe('disabled')
    expect(getStellaPilotConfig({ STELLA_PILOT_PROVIDER_MODE: 'mock' }).providerMode).toBe('mock')
    expect(getStellaPilotConfig({ STELLA_PILOT_PROVIDER_MODE: 'paid_gemini' }).providerMode).toBe('paid_gemini')
  })

  it('parses a valid comma-separated organization ID allowlist', () => {
    const idA = '11111111-1111-1111-1111-111111111111'
    const idB = '22222222-2222-2222-2222-222222222222'
    const config = getStellaPilotConfig({ STELLA_PILOT_ORGANIZATION_IDS: `${idA}, ${idB}` })
    expect(config.allowedOrganizationIds.has(idA)).toBe(true)
    expect(config.allowedOrganizationIds.has(idB)).toBe(true)
    expect(config.allowedOrganizationIds.size).toBe(2)
  })

  it('drops (fail-closed) an invalid UUID from the organization allowlist instead of throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const validId = '11111111-1111-1111-1111-111111111111'
    const config = getStellaPilotConfig({ STELLA_PILOT_ORGANIZATION_IDS: `${validId}, not-a-uuid, DROP TABLE organizations;` })
    expect(config.allowedOrganizationIds.size).toBe(1)
    expect(config.allowedOrganizationIds.has(validId)).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('an empty organization allowlist means NO organization is allowed — never "unrestricted"', () => {
    const config = getStellaPilotConfig({ STELLA_PILOT_MODE: 'true' })
    expect(config.allowedOrganizationIds.size).toBe(0)
  })

  it('defaults enabledStellaRoles to just "advisor" when STELLA_PILOT_ENABLED_ROLES is unset', () => {
    const config = getStellaPilotConfig({})
    expect(config.enabledStellaRoles.has('advisor')).toBe(true)
    expect(config.enabledStellaRoles.has('composer')).toBe(false)
    expect(config.enabledStellaRoles.size).toBe(1)
  })

  it('an explicit STELLA_PILOT_ENABLED_ROLES overrides the default, dropping unrecognized roles', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = getStellaPilotConfig({ STELLA_PILOT_ENABLED_ROLES: 'advisor,composer,not_a_role' })
    expect(config.enabledStellaRoles.has('advisor')).toBe(true)
    expect(config.enabledStellaRoles.has('composer')).toBe(true)
    expect(config.enabledStellaRoles.size).toBe(2)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('paidGeminiConfirmed requires the exact string "true" — an API key alone is never treated as proof of payment (no such field exists here)', () => {
    expect(getStellaPilotConfig({ STELLA_PILOT_PAID_GEMINI_CONFIRMED: 'true' }).paidGeminiConfirmed).toBe(true)
    expect(getStellaPilotConfig({ STELLA_PILOT_PAID_GEMINI_CONFIRMED: 'yes' }).paidGeminiConfirmed).toBe(false)
    expect(getStellaPilotConfig({}).paidGeminiConfirmed).toBe(false)
  })

  it('noticeVersion defaults to "v1" and can be overridden', () => {
    expect(getStellaPilotConfig({}).noticeVersion).toBe('v1')
    expect(getStellaPilotConfig({ STELLA_PILOT_NOTICE_VERSION: 'v2' }).noticeVersion).toBe('v2')
  })
})

describe('PILOT_MEMBERSHIP_ROLE_ALLOWLIST', () => {
  it('includes organization_admin, impact_manager, analyst', () => {
    expect(PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has('organization_admin')).toBe(true)
    expect(PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has('impact_manager')).toBe(true)
    expect(PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has('analyst')).toBe(true)
  })

  it('excludes super_admin — no bypass for the platform role', () => {
    expect(PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has('super_admin')).toBe(false)
  })

  it('excludes viewer and reviewer', () => {
    expect(PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has('viewer')).toBe(false)
    expect(PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has('reviewer')).toBe(false)
  })
})
