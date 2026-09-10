// lib/auth/email-verification.ts
//
// PACKET B — the destination for B0.
//
// This module does NOT read `email_confirmed_at` and does not derive the
// verified boolean: lib/auth/identity.ts is the only module allowed to do
// that (S-IA-PREDICATE-CARDINALITY). It exists only so every completeness
// point (requireAuth, requireOrganizationAccess) and every routing
// translation (login, signup, the auth callback, the onboarding action)
// redirects an authenticated-but-unverified subject to the SAME place,
// named once.
export const VERIFY_EMAIL_PATH = '/verify-email'
