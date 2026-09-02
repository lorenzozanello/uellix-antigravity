// lib/admin/organization-administration.ts
//
// THE ONLY REACHABLE WAY THE APPLICATION MOVES AN ADMINISTRATIVE COLUMN OF
// `organizations`.
//
// "Reachable" no longer needs a caveat. `app/api/webhooks/stripe/route.ts` used
// to hold three `db.update(organizations).set({ stellaMonthlyQuota, … })`
// statements — dead behind `WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false`, and
// guaranteed to raise 42501 the moment that flag was flipped after stella_0011,
// because none of those columns is in the runtime grant. CAPABILITIES train 1
// removed them: the webhook now goes through `lib/capabilities/stripe-webhook.ts`
// onto the `uellix_capability` functions of stella_0008, on the dedicated
// `uellix_stripe` connection. They were the webhook remainder of RR-CAP-10-A
// (canonical id — `RR-CAP-10-A-bis` was an alias coined in this comment and
// never entered the risk register; see CT-CAP-002).
//
// After `stella_0011_organization_column_acl.sql`, `stella_monthly_quota`,
// `stella_plan_label` and `status` are outside every runtime UPDATE grant. The
// ORM cannot write them, and that is deliberate: an ACL is the only layer that
// can bound a COLUMN, because RLS evaluates a row and is never handed the
// statement's target list.
//
// So the two administrative operations move here, onto the two SECURITY DEFINER
// functions the package prepares. Each one:
//
//   * refuses any caller that is not a platform super_admin, TWICE — in its
//     body and through the RESTRICTIVE policy `cap_platform_only_super_admin`,
//     which reads `auth.uid()` from the session the request already
//     established;
//   * writes the change and its `audit_logs` row in ONE transaction. That is
//     the second reason this file exists: the previous code issued the UPDATE
//     and the audit INSERT as two awaited calls, so a failure between them left
//     a quota moved with no record of why.
//
// ---------------------------------------------------------------------------
// DEPLOYMENT IS COUPLED. THIS IS NOT OPTIONAL.
// ---------------------------------------------------------------------------
// These functions do not exist until `stella_0011` is applied. This module and
// that package are ONE change and must ship together — deploy the code first
// and the two platform-admin screens raise 42883 (`function does not exist`);
// apply the package first and they raise 42501 (`permission denied`). That was
// RR-CAP-10-A, recorded as "a code change must land BEFORE the package"; with
// this module it becomes an ordinary coupled deployment instead of a latent
// trap, which is the whole point of closing it.
//
// There is deliberately NO feature flag and NO fallback to a direct UPDATE.
// A fallback would keep `db.update(organizations).set({ stellaMonthlyQuota })`
// alive in the tree, which is the exact statement RR-CAP-10 exists to remove,
// and a flag defaulting to the old path would mean the boundary is off in
// production while the tests exercise the new one.

import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * A refusal from the administrative capability, with nothing of the database in it.
 *
 * The functions answer every refusal with the same `capability request denied`
 * (SQLSTATE U0001) precisely so that "you are not a super_admin", "no such
 * organisation" and "that quota is negative" are indistinguishable to the
 * caller. Re-wrapping here keeps that property through the ORM, which would
 * otherwise surface a driver error carrying the statement text.
 */
export class OrganizationAdministrationError extends Error {
  readonly name = 'OrganizationAdministrationError'
  constructor(operation: string) {
    super(`Organization administration refused: ${operation}`)
  }
}

/**
 * `organizationId` is a client-supplied form field, so it is validated as a
 * UUID before it reaches a query — not because the parameter binding would
 * allow anything else, but because an unparseable value should fail as input
 * validation rather than as a database type error.
 */
const OrganizationId = z.string().uuid()

const StellaServiceArgs = z.object({
  /**
   * `null` is a VALUE, not an omission: the runtime reads a null
   * `stella_monthly_quota` as UNLIMITED (`lib/stella/quota.ts`). The admin form
   * offers it as an empty field, so it has to survive the round trip.
   */
  monthlyQuota: z.number().int().min(0).nullable(),
  /**
   * DESTRUCTIVE WHEN OMITTED, and that is a change of meaning worth stating.
   * The definer assigns `stella_plan_label = p_plan_label` unconditionally, so
   * omitting this CLEARS the label — where the removed `db.update().set()`
   * would have left it alone, because drizzle drops undefined keys. The one UI
   * caller always sends the field; a programmatic caller updating only the
   * quota must send the current label or lose it.
   */
  planLabel: z.string().max(100).optional(),
})

const OrganizationStatus = z.enum(['active', 'suspended'])

/** Move an organisation's Stella plan label and monthly quota. Platform super_admin only. */
export async function callAdminSetStellaService(
  organizationId: string,
  args: z.infer<typeof StellaServiceArgs>,
): Promise<void> {
  const id = OrganizationId.parse(organizationId)
  const { monthlyQuota, planLabel } = StellaServiceArgs.parse(args)

  try {
    await db.execute(
      sql`SELECT uellix_capability.admin_set_stella_service(
            ${id}::uuid, ${monthlyQuota}::integer, ${planLabel ?? null}::text)`,
    )
  } catch (err) {
    // The CLIENT learns nothing; the SERVER learns everything. Swallowing the
    // driver error entirely was a real defect: 42883 ("the code shipped without
    // the package"), 42501 ("the package shipped without the code"), a dropped
    // connection and a genuine U0001 refusal all rendered as one query-string
    // value with an empty console. The uniform-refusal argument justifies
    // hiding the database's discrimination from the caller, never destroying it.
    console.error('[admin-capability] stella service refused:', getErrorMessage(err, 'unknown database error'))
    throw new OrganizationAdministrationError('stella service')
  }
}

/** Suspend or reactivate an organisation platform-wide. Platform super_admin only. */
export async function callAdminSetOrganizationStatus(
  organizationId: string,
  status: z.infer<typeof OrganizationStatus>,
): Promise<void> {
  const id = OrganizationId.parse(organizationId)
  const next = OrganizationStatus.parse(status)

  try {
    await db.execute(
      sql`SELECT uellix_capability.admin_set_organization_status(${id}::uuid, ${next}::text)`,
    )
  } catch (err) {
    console.error('[admin-capability] organization status refused:', getErrorMessage(err, 'unknown database error'))
    throw new OrganizationAdministrationError('organization status')
  }
}
