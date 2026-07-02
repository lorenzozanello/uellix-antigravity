// lib/email/config.ts
// Server-only module. Never expose RESEND_API_KEY to the client.

export const emailConfig = {
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'Uellix <noreply@uellix.com>',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
} as const

// Computed flag: only attempt real delivery when a key is present.
export const emailState = {
  canSendEmail: emailConfig.resendApiKey.length > 0,
} as const
