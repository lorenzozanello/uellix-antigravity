import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { marketingLeads } from '@/db/schema';
import { z } from 'zod';

const LeadSchema = z.object({
  email: z.string().trim().email().max(255),
  companyName: z.string().trim().max(255).optional(),
  sroiResult: z.string().trim().max(50).optional(),
  source: z.string().trim().max(100).default('sroi_calculator'),
});

/**
 * PUBLIC, UNAUTHENTICATED WRITE — BLOCKED BY DESIGN AFTER THE RUNTIME CUTOVER.
 *
 * `marketing_leads` was the only table in `public` whose policies name database
 * ROLES rather than applying to all of them (since stella_0005c the three
 * append-only INSERT policies are role-scoped too — deliberately, TO
 * uellix_app; measured distribution: 101 {public} + 3 {uellix_app} +
 * 2 {authenticated} + 1 {anon}):
 *
 *   anon_insert_marketing_leads           TO anon           WITH CHECK (true)
 *   authenticated_insert_marketing_leads  TO authenticated  WITH CHECK (true)
 *   super_admins_read_marketing_leads     TO authenticated  USING (is_super_admin)
 *
 * A policy's `TO` clause is matched against the DATABASE role, not against the
 * `role` field of `request.jwt.claims`. The runtime authenticates as
 * `uellix_app`, which is a member of neither `anon` nor `authenticated`
 * (verified: `pg_has_role` returns false for both), so NO policy applies and
 * the insert is refused.
 *
 * That is fail-closed, and it is left that way deliberately. Restoring it means
 * one of:
 *   (a) an INSERT policy for `{public}` on this table — the same "anyone may
 *       submit a lead" rule, expressed against the role that actually connects;
 *   (b) granting `uellix_app` membership in `authenticated`, which would hand
 *       it every grant that role carries across the whole database.
 *
 * (a) is the right answer and (b) is not, but both are privilege decisions and
 * neither is taken in this unit. No claims are fabricated here: an
 * unauthenticated caller has no identity, and inventing one to satisfy a policy
 * would make every other policy's guarantee negotiable.
 *
 * It refuses EXPLICITLY rather than attempting the insert. An endpoint that is
 * structurally guaranteed to fail should not answer 500 on every request: a
 * permanent condition reported as a server fault buries itself in noise, and
 * "the leads table is unreachable" is a different operational fact from "the
 * database is down". Same reasoning as app/api/webhooks/stripe/route.ts.
 */
const LEAD_CAPTURE_POLICY_AVAILABLE = false

export async function POST(request: Request) {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request' },
      { status: 400 }
    )
  }

  const parsed = LeadSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request' },
      { status: 400 }
    )
  }

  // Refused AFTER validation, so a malformed body still gets its 400 and this
  // branch cannot be used to probe the endpoint without submitting a real
  // payload shape.
  if (!LEAD_CAPTURE_POLICY_AVAILABLE) {
    console.error(
      '[marketing-lead] refusing: marketing_leads has no INSERT policy that applies to the runtime role'
    )
    return NextResponse.json(
      { success: false, error: 'Lead capture is temporarily unavailable' },
      { status: 503 }
    )
  }

  try {
    const data = parsed.data
    await db.insert(marketingLeads).values({
      email: data.email,
      companyName: data.companyName,
      sroiResult: data.sroiResult,
      source: data.source,
    });

    return NextResponse.json({ success: true, message: 'Lead saved successfully' });
  } catch (error: unknown) {
    // Name only — a marketing lead payload is personal data and must not reach
    // a log line, and neither must the driver's echo of the failing statement.
    console.error(
      '[marketing-lead] insert failed:',
      error instanceof Error ? error.name : 'unknown'
    );
    return NextResponse.json(
      { success: false, error: 'Unable to save lead' },
      { status: 500 }
    );
  }
}
