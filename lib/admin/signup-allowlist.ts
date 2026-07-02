// lib/admin/signup-allowlist.ts
// SuperAdmin management of the signup allowlist that gates self-serve org
// creation (see app/app/onboarding/actions.ts). Invited users bypass this
// entirely — acceptInvitation() is a separate code path.

import { db } from '@/db/client'
import { signupAllowlist } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireAdminAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

const AllowlistEntryInput = z.object({
  type: z.enum(['email', 'domain']),
  pattern: z.string().min(3).max(255),
  notes: z.string().optional(),
})

function normalizePattern(type: 'email' | 'domain', raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  return type === 'domain' ? trimmed.replace(/^@/, '') : trimmed
}

export async function listSignupAllowlist() {
  await requireAdminAccess()
  return db.select().from(signupAllowlist).orderBy(signupAllowlist.createdAt)
}

export async function createSignupAllowlistEntry(input: unknown) {
  const admin = await requireAdminAccess()
  const data = AllowlistEntryInput.parse(input)
  const pattern = normalizePattern(data.type, data.pattern)

  if (data.type === 'email' && !pattern.includes('@')) {
    throw new Error('Invalid email pattern')
  }
  if (data.type === 'domain' && (!pattern.includes('.') || pattern.includes('@'))) {
    throw new Error('Invalid domain pattern')
  }

  const [row] = await db
    .insert(signupAllowlist)
    .values({
      type: data.type,
      pattern,
      notes: data.notes,
      createdBy: admin.id,
    })
    .returning()

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'signup_allowlist',
    entityId: row.id,
    action: AUDIT_ACTIONS.SIGNUP_ALLOWLIST_CREATED,
    afterJson: row,
  })

  return row
}

export async function removeSignupAllowlistEntry(id: string) {
  const admin = await requireAdminAccess()

  const entry = await db.select().from(signupAllowlist).where(eq(signupAllowlist.id, id)).then((r) => r[0])
  if (!entry) throw new Error('Entry not found')

  await db.delete(signupAllowlist).where(eq(signupAllowlist.id, id))

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'signup_allowlist',
    entityId: id,
    action: AUDIT_ACTIONS.SIGNUP_ALLOWLIST_REMOVED,
    beforeJson: entry,
  })
}

/**
 * Checks whether an email is allowed to self-serve create a new organization.
 * Used only by createFirstOrganization — invited users never hit this.
 */
export async function isEmailAllowlisted(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const domain = normalized.split('@')[1]

  const entries = await db.select().from(signupAllowlist)

  return entries.some((entry) => {
    if (entry.type === 'email') return entry.pattern === normalized
    if (entry.type === 'domain') return domain === entry.pattern
    return false
  })
}
