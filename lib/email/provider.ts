// lib/email/provider.ts
// Provider-agnostic email interface. Concrete implementations (Resend, mocks
// for tests) implement this so callers never depend on a specific SDK.

export interface EmailMessage {
  to: string
  subject: string
  html: string
}

export interface EmailSendResult {
  id: string
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult | null>
}
