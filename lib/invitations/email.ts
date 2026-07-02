// lib/invitations/email.ts
// Builds and sends the invitation email. Delivery failures never throw —
// the invitation is already persisted with a valid token by the time this
// runs, so a broken email provider must not block the invite from existing.

import { emailConfig } from '@/lib/email/config'
import { ResendEmailProvider } from '@/lib/email/resend-client'
import type { EmailProvider } from '@/lib/email/provider'
import { ROLE_LABELS, type Role } from '@/lib/auth/roles'

export function buildInvitationAcceptUrl(rawToken: string): string {
  return `${emailConfig.appUrl}/invite/accept?token=${rawToken}`
}

interface SendInvitationEmailParams {
  email: string
  organizationName: string
  role: Role
  rawToken: string
}

export async function sendInvitationEmail(
  params: SendInvitationEmailParams,
  provider: EmailProvider = new ResendEmailProvider()
): Promise<void> {
  const acceptUrl = buildInvitationAcceptUrl(params.rawToken)
  const roleLabel = ROLE_LABELS[params.role]

  try {
    await provider.send({
      to: params.email,
      subject: `Invitación a ${params.organizationName} en Uellix`,
      html: `
        <p>Has sido invitado a unirte a <strong>${params.organizationName}</strong> en Uellix como <strong>${roleLabel}</strong>.</p>
        <p><a href="${acceptUrl}">Aceptar invitación</a></p>
        <p>Este enlace expira en 7 días. Si no esperabas esta invitación, puedes ignorar este correo.</p>
      `.trim(),
    })
  } catch (err) {
    console.error('[invitations] Failed to send invitation email:', err)
  }
}
