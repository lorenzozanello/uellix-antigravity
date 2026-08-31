/**
 * lib/audit/index.ts
 * Barrel export for audit logging utilities.
 */

export { logAuditAction, AUDIT_ACTIONS, AuditContractViolationError, recordAuditCorrection } from './logger'
export type { AuditAction, AuditLogEntry, AuditCorrectionInput } from './logger'
