'use server'
// app/actions/marketing/demo-request.ts
// Public, unauthenticated action — replaces the mailto: "Solicitar demo" CTAs
// across the landing. No DB write: this is a lead notification, not a
// persisted business record. Delivery goes through the existing Resend
// provider, which already no-ops safely if RESEND_API_KEY isn't configured.

import { headers } from 'next/headers'
import { z } from 'zod'
import { ResendEmailProvider } from '@/lib/email/resend-client'
import type { EmailProvider } from '@/lib/email/provider'
import { checkDemoRequestRateLimit, recordDemoRequest } from '@/lib/marketing/demo-request-rate-limit'

const DEMO_REQUEST_RECIPIENT = 'hola@uellix.com'

const DemoRequestSchema = z.object({
  name: z.string().trim().min(1, 'Ingresá tu nombre').max(200),
  organization: z.string().trim().min(1, 'Ingresá tu organización').max(200),
  email: z.string().trim().min(1, 'Ingresá tu email').email('Ingresá un email válido').max(320),
  message: z.string().trim().max(2000).optional(),
  // Honeypot: real users never see or fill this field (hidden via CSS in the
  // form). Any non-empty value means the submitter is a bot.
  website: z.string().optional(),
})

export type DemoRequestInput = z.infer<typeof DemoRequestSchema>

export type DemoRequestResult =
  | { ok: true }
  | { ok: false; error: string }

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function clientIp(): Promise<string> {
  const h = await headers()
  const forwardedFor = h.get('x-forwarded-for')
  return forwardedFor?.split(',')[0]?.trim() || 'unknown'
}

export async function submitDemoRequest(
  input: DemoRequestInput,
  provider: EmailProvider = new ResendEmailProvider()
): Promise<DemoRequestResult> {
  const parsed = DemoRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Datos inválidos.' }
  }

  const { name, organization, email, message, website } = parsed.data

  // Honeypot tripped — report success to the bot without sending anything.
  if (website) {
    return { ok: true }
  }

  const ip = await clientIp()
  if (!checkDemoRequestRateLimit(ip)) {
    return { ok: false, error: 'Demasiadas solicitudes. Probá de nuevo en un rato o escribinos a hola@uellix.com.' }
  }

  try {
    await provider.send({
      to: DEMO_REQUEST_RECIPIENT,
      subject: `Nueva solicitud de demo — ${organization}`,
      replyTo: email,
      html: `
        <p><strong>Nombre:</strong> ${escapeHtml(name)}</p>
        <p><strong>Organización:</strong> ${escapeHtml(organization)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        ${message ? `<p><strong>Mensaje:</strong><br/>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>` : ''}
      `.trim(),
    })
    recordDemoRequest(ip)
    return { ok: true }
  } catch (err) {
    console.error('[marketing] Failed to send demo request email:', err)
    return { ok: false, error: 'No pudimos enviar tu solicitud. Escribinos directamente a hola@uellix.com.' }
  }
}
