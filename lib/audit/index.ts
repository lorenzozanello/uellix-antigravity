/**
 * lib/audit/index.ts
 * Barrel export for audit logging utilities.
 */

export { logAuditAction, AUDIT_ACTIONS } from './logger'
export type { AuditAction, AuditLogEntry } from './logger'
