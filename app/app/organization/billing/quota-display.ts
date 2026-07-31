// app/app/organization/billing/quota-display.ts
// Pure mapping from the stored stella_monthly_quota value to what the billing
// page shows. MUST mirror the enforcement semantics of lib/stella/quota.ts:
//   null      → unlimited (no cap assigned/enforced)
//   0/absent  → NO plan assigned — Stella is blocked (fail-closed default)
//   n > 0     → n requests per current UTC calendar month
// Never invent a fallback quota here: showing a number the backend does not
// enforce (the old `|| 10`) is a lie to the customer.

export type StellaQuotaDisplay = {
  state: 'unlimited' | 'unassigned' | 'assigned'
  /** Short value for the quota slot, e.g. "Ilimitado" / "Sin plan asignado" / "50 consultas/mes". */
  quotaLabel: string
  /** One-sentence explanation shown under the plan title. */
  description: string
}

export function getStellaQuotaDisplay(quota: number | null | undefined): StellaQuotaDisplay {
  if (quota === null) {
    return {
      state: 'unlimited',
      quotaLabel: 'Ilimitado',
      description: 'Tu organización tiene consultas de Stella ilimitadas este mes (sin cupo asignado).',
    }
  }
  if (!quota || quota <= 0) {
    return {
      state: 'unassigned',
      quotaLabel: 'Sin plan asignado',
      description:
        'Tu organización no tiene un plan de Stella asignado — contactá a Uellix para habilitarlo.',
    }
  }
  return {
    state: 'assigned',
    quotaLabel: `${quota} consultas/mes`,
    description: `Tenés acceso a ${quota} consultas de Stella por mes calendario (UTC).`,
  }
}
