# Closed beta preview hardening design

## Objective

Convert the approved stabilization workspace into a reviewable GitHub branch
that can generate a Vercel Preview without changing Vercel or Supabase
production. The preview candidate must close the two known technical risks,
consolidate the approved inherited work and pass the complete local gate.

## Scope and safety boundary

- Work only on `codex/beta-stabilization`.
- Do not apply database migrations or policies to any Supabase project.
- Do not change Vercel production configuration or promote a deployment.
- A branch push and pull request may create a Vercel Preview through the
  existing GitHub integration; that preview is the intended external effect.
- Real credentials remain outside Git. Missing optional integrations must fail
  safely or remain disabled.

## Controlled organization logos

Organization branding will accept only HTTPS object URLs from the configured
Supabase project origin. The validation unit will parse
`NEXT_PUBLIC_SUPABASE_URL`, compare URL origins and require the public Storage
object path prefix `/storage/v1/object/public/`. Invalid, private, local and
third-party URLs are rejected before being stored.

The PDF renderer will apply the same validation before passing a URL to
`@react-pdf/renderer`. This second boundary protects existing rows and prevents
a future write path from bypassing the server-action validation. An invalid
logo is omitted; report generation itself remains available.

Tests will cover an allowed Storage URL, mismatched origins, non-HTTPS URLs,
lookalike hostnames, credentials in URLs and missing Supabase configuration.

## Atomic Stella rate limiting

Replace the split `check` then `record` behavior with one asynchronous consume
operation. Both the memory and Upstash implementations will consume exactly one
token and return the resulting allowance in one call. The four Stella actions
will consume only after authentication, feature/quota checks and successful
project-context validation, but before calling Gemini.

This produces one charging rule across runtimes: invalid context requests do
not consume; attempted model requests do consume even if Gemini or later audit
storage fails. Upstash errors fail closed with a controlled rate-limit service
error so a Redis outage cannot create unbounded AI spend. Tests will cover
atomic memory behavior, organization isolation, hourly reset and action call
ordering. No live Upstash requests are part of the unit suite.

## Approved inherited work

The remaining marketing redesign, organization onboarding/settings/billing,
public verification, legal pages, report branding and associated tests will be
reviewed as coherent groups before staging. Local-only agent configuration and
generated audit fixtures are not automatically included; only files required
by the product or its documented audit trail will be versioned.

Public verification continues to expose locked reports only. Copy must describe
the report as registered and locked for external review, not cryptographically
immutable. Stripe remains lazy and disabled without credentials. Legal copy is
treated as business-approved by the product owner, while production publication
still remains subject to the final deployment gate.

## Error handling and observability

- Public APIs return generic errors and log operational detail server-side.
- Missing optional credentials do not break `next build`.
- Sentry initializes only when a DSN is present and keeps replay text/media
  masking enabled.
- Health endpoints expose status booleans and generic availability messages,
  never user records or upstream error text.

## Verification and delivery

The candidate must pass, on the final dependency graph and working tree:

1. focused red-green tests for logo validation and Stella limiting;
2. `pnpm lint` with zero errors;
3. `pnpm typecheck`;
4. `pnpm test:unit`;
5. `pnpm build`;
6. `pnpm audit --prod` with no known vulnerabilities;
7. `pnpm db:generate` with no schema drift;
8. `git diff --check` for the staged product changes.

After verification, changes are committed on the stabilization branch. The
branch may then be pushed and a pull request created for GitHub/Vercel Preview.
No merge, production deployment or production database action is authorized by
this design.
