// lib/stella/pilot/access.ts
// Etapa B0 (modo piloto restringido) — the SINGLE source of truth for
// whether a request may reach the pilot's provider. No server action, no
// UI, and no other service should independently re-derive pilot access —
// they all call getStellaPilotAccess().
//
// Critical invariant: quota and rate-limit are NEVER evaluated here. This
// function only decides PILOT eligibility; the caller (app/actions/stella/
// advisor.ts) only consumes quota/rate-limit AFTER receiving PILOT_ALLOWED —
// so a pilot rejection (wrong org, wrong user, kill switch, missing
// confirmation, etc.) never costs the organization a quota unit and never
// reaches the provider, real or mock.
//
// Never leaks allowlists, other organizations' state, or environment
// variable values — every returned message is a fixed, non-leaky string.

import { stellaConfig } from '../config'
import type { StellaRole } from '../adapter/types'
import { getStellaPilotConfig, PILOT_MEMBERSHIP_ROLE_ALLOWLIST } from './config'
import { getStellaConsentStatus } from '../consent/consent-status'
import { getStellaPilotConfirmationStatus } from './confirmation-service'

export type StellaPilotAccessDecision =
  | 'PILOT_DISABLED'
  | 'PILOT_KILL_SWITCH_ACTIVE'
  | 'PILOT_ORGANIZATION_NOT_ALLOWED'
  | 'PILOT_USER_NOT_ALLOWED'
  | 'PILOT_MEMBERSHIP_INACTIVE'
  | 'PILOT_ROLE_NOT_ALLOWED'
  | 'PILOT_CONFIRMATION_REQUIRED'
  | 'PILOT_CONFIRMATION_OUTDATED'
  | 'PILOT_CONSENT_REQUIRED'
  | 'PILOT_PAID_PROVIDER_NOT_CONFIRMED'
  | 'PILOT_PROVIDER_NOT_READY'
  | 'PILOT_ALLOWED'

export interface StellaPilotAccessResult {
  decision: StellaPilotAccessDecision
  message: string
}

export interface StellaPilotAccessInput {
  organizationId: string
  userId: string
  membershipRole: string
  membershipStatus: string
  stellaRole: StellaRole
}

const DECISION_MESSAGES: Record<StellaPilotAccessDecision, string> = {
  PILOT_DISABLED: 'Stella no está disponible en este momento.',
  PILOT_KILL_SWITCH_ACTIVE: 'Stella está temporalmente no disponible.',
  PILOT_ORGANIZATION_NOT_ALLOWED: 'Tu organización todavía no forma parte del piloto de Stella.',
  PILOT_USER_NOT_ALLOWED: 'Tu usuario todavía no está habilitado para el piloto de Stella.',
  PILOT_MEMBERSHIP_INACTIVE: 'Tu membresía en la organización no está activa.',
  PILOT_ROLE_NOT_ALLOWED: 'Esta función de Stella todavía no está habilitada en el piloto.',
  PILOT_CONFIRMATION_REQUIRED: 'Debés confirmar las restricciones de datos del piloto antes de continuar.',
  PILOT_CONFIRMATION_OUTDATED: 'El aviso del piloto se actualizó — debés volver a confirmar las restricciones de datos.',
  PILOT_CONSENT_REQUIRED: "Un administrador de organización debe aceptar los términos de IA de Stella antes de continuar.",
  PILOT_PAID_PROVIDER_NOT_CONFIRMED: 'El plan pago del proveedor de IA todavía no fue confirmado para el piloto.',
  PILOT_PROVIDER_NOT_READY: 'El proveedor de IA del piloto todavía no está configurado.',
  PILOT_ALLOWED: 'Acceso permitido.',
}

function isLegacyRoleFlagEnabled(role: StellaRole): boolean {
  switch (role) {
    case 'advisor':
      return stellaConfig.isAdvisorEnabled
    case 'validator':
      return stellaConfig.isValidatorEnabled
    case 'composer':
      return stellaConfig.isComposerEnabled
    case 'proxy_reviewer':
      return stellaConfig.isProxyReviewerEnabled
    case 'evidence_reviewer':
      return stellaConfig.isEvidenceReviewerEnabled
    case 'audit_assistant':
      return stellaConfig.isAuditAssistantEnabled
  }
}

/**
 * Evaluates pilot access in the order documented in
 * STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md#9: kill switch → pilot
 * enabled → Stella enabled → org allowlist → user allowed → membership
 * active → pilot role permitted → DR-005 consent → (DR-007 — not
 * re-checked, see inline note) → pilot data-restriction confirmation →
 * role-specific pilot enablement → provider readiness. Quota/rate-limit are
 * the caller's job, always evaluated strictly AFTER this returns
 * PILOT_ALLOWED.
 */
export async function getStellaPilotAccess(input: StellaPilotAccessInput): Promise<StellaPilotAccessResult> {
  const config = getStellaPilotConfig()

  // 1. Kill switch — highest priority, overrides every other flag/allowlist.
  if (config.killSwitch) {
    return { decision: 'PILOT_KILL_SWITCH_ACTIVE', message: DECISION_MESSAGES.PILOT_KILL_SWITCH_ACTIVE }
  }

  // 2. Pilot mode enabled.
  if (!config.enabled) {
    return { decision: 'PILOT_DISABLED', message: DECISION_MESSAGES.PILOT_DISABLED }
  }

  // 3. Stella enabled globally — the pilot narrows access, it never widens
  // it: if the pre-existing global flag is off, the pilot cannot turn it on.
  if (!stellaConfig.isEnabled) {
    return { decision: 'PILOT_DISABLED', message: DECISION_MESSAGES.PILOT_DISABLED }
  }

  // 4. Organization allowlist — an EMPTY set means no organization has
  // access, never "unrestricted because nothing was configured".
  if (!config.allowedOrganizationIds.has(input.organizationId)) {
    return { decision: 'PILOT_ORGANIZATION_NOT_ALLOWED', message: DECISION_MESSAGES.PILOT_ORGANIZATION_NOT_ALLOWED }
  }

  // 5. User allowed — either an explicit user allowlist entry, or the
  // organization-wide opt-in flag. No third path exists.
  if (!config.allowAllUsersInAllowedOrganizations && !config.allowedUserIds.has(input.userId)) {
    return { decision: 'PILOT_USER_NOT_ALLOWED', message: DECISION_MESSAGES.PILOT_USER_NOT_ALLOWED }
  }

  // 6. Membership active — defense in depth. The caller's session resolution
  // already requires an active membership to reach this function at all;
  // re-checked here so this function never silently trusts a stale or
  // forged input if ever called from a different context. Distinct decision
  // code from step 5 (PILOT_USER_NOT_ALLOWED): "not in the pilot allowlist"
  // and "membership no longer active" call for different remediation.
  if (input.membershipStatus !== 'active') {
    return { decision: 'PILOT_MEMBERSHIP_INACTIVE', message: DECISION_MESSAGES.PILOT_MEMBERSHIP_INACTIVE }
  }

  // 7. Role permitted — pilot-specific allowlist (organization_admin/
  // impact_manager/analyst), a LITERAL match. super_admin is deliberately
  // excluded and gets no bypass here, per the encargo's explicit
  // restriction — being super_admin never substitutes for pilot eligibility.
  if (!PILOT_MEMBERSHIP_ROLE_ALLOWLIST.has(input.membershipRole)) {
    return { decision: 'PILOT_ROLE_NOT_ALLOWED', message: DECISION_MESSAGES.PILOT_ROLE_NOT_ALLOWED }
  }

  // 8. DR-005 organizational consent — reuses the existing, already-tested
  // service; never re-implemented here.
  const consent = await getStellaConsentStatus(input.organizationId)
  if (consent.status !== 'valid') {
    return { decision: 'PILOT_CONSENT_REQUIRED', message: DECISION_MESSAGES.PILOT_CONSENT_REQUIRED }
  }

  // 9. DR-007 access — NOT independently re-checked here. DR-007
  // (lib/stella/access/stella-interaction-access.ts) governs READING past
  // interactions, not triggering a new one. Every role in
  // PILOT_MEMBERSHIP_ROLE_ALLOWLIST (step 7) is already a subset of
  // ORG_WIDE_STELLA_ACCESS_ROLES, so a user who can trigger a pilot request
  // can always read it back afterward under the existing DR-007 policy —
  // duplicating that check here would be redundant, not a gap.

  // 10. Data restrictions — the pilot's OWN operative confirmation
  // (distinct from DR-005's organizational consent): "I will not upload
  // prohibited data and I will review outputs", accepted per-user. Split
  // into two decision codes: "never confirmed / revoked" vs. "confirmed an
  // older notice version" — the UI copy and remediation differ (accept for
  // the first time vs. re-accept after a notice bump).
  const confirmation = await getStellaPilotConfirmationStatus(input.organizationId, input.userId)
  if (confirmation.status === 'outdated') {
    return { decision: 'PILOT_CONFIRMATION_OUTDATED', message: DECISION_MESSAGES.PILOT_CONFIRMATION_OUTDATED }
  }
  if (confirmation.status !== 'valid') {
    return { decision: 'PILOT_CONFIRMATION_REQUIRED', message: DECISION_MESSAGES.PILOT_CONFIRMATION_REQUIRED }
  }

  // 11. Role-specific flag — BOTH the pilot's own role allowlist AND the
  // pre-existing legacy per-role feature flag (STELLA_ADVISOR_ENABLED etc.)
  // must agree; the pilot narrows, it never overrides a legacy flag that's
  // off.
  if (!config.enabledStellaRoles.has(input.stellaRole)) {
    return { decision: 'PILOT_ROLE_NOT_ALLOWED', message: DECISION_MESSAGES.PILOT_ROLE_NOT_ALLOWED }
  }
  if (!isLegacyRoleFlagEnabled(input.stellaRole)) {
    return { decision: 'PILOT_ROLE_NOT_ALLOWED', message: DECISION_MESSAGES.PILOT_ROLE_NOT_ALLOWED }
  }

  // 12. Provider readiness — an API key is NEVER treated as proof of a paid
  // tier (see config.ts's header): providerMode must be explicitly
  // configured, and 'paid_gemini' additionally requires the external
  // confirmation flag (STELLA_PILOT_PAID_GEMINI_CONFIRMED) to be true.
  if (config.providerMode === 'disabled') {
    return { decision: 'PILOT_PROVIDER_NOT_READY', message: DECISION_MESSAGES.PILOT_PROVIDER_NOT_READY }
  }
  if (config.providerMode === 'paid_gemini' && !config.paidGeminiConfirmed) {
    return { decision: 'PILOT_PAID_PROVIDER_NOT_CONFIRMED', message: DECISION_MESSAGES.PILOT_PAID_PROVIDER_NOT_CONFIRMED }
  }

  // 13. Quota/rate-limit are NEVER evaluated here — see this module's
  // header. The caller only consumes them after PILOT_ALLOWED.

  return { decision: 'PILOT_ALLOWED', message: DECISION_MESSAGES.PILOT_ALLOWED }
}
