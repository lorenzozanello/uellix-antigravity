// lib/email/resend-client.ts
// Server-only. Real Resend implementation of EmailProvider.
//
// Constructed with no API key when RESEND_API_KEY is unset — send() then
// no-ops with a warning instead of throwing, so callers (e.g. invitation
// creation) never fail just because email delivery isn't configured yet.

import { Resend } from 'resend'
import { emailConfig } from './config'
import type { EmailMessage, EmailProvider, EmailSendResult } from './provider'

export class ResendEmailProvider implements EmailProvider {
  private client: Resend | null

  constructor(apiKey: string = emailConfig.resendApiKey) {
    this.client = apiKey ? new Resend(apiKey) : null
  }

  isReady(): boolean {
    return this.client !== null
  }

  async send(message: EmailMessage): Promise<EmailSendResult | null> {
    if (!this.client) {
      console.warn('[email] RESEND_API_KEY not configured — skipping send to', message.to)
      return null
    }

    const { data, error } = await this.client.emails.send({
      from: emailConfig.emailFrom,
      to: message.to,
      subject: message.subject,
      html: message.html,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    })

    if (error) {
      console.error('[email] Resend send failed:', error.message)
      return null
    }

    return data ? { id: data.id } : null
  }
}
