// EN translation of the ES legal source — G7 legal review pending; ES prevails on conflict.
// Source of truth: app/(public)/privacidad/page.tsx. Keep sections in sync with it.
import type { Metadata } from "next";

export const metadata: Metadata = {
  // Plain string → the root template ("%s | Uellix") appends the brand. Do NOT
  // repeat "Uellix" here or the title renders as "… · Uellix | Uellix".
  title: "Privacy Policy",
  description:
    "Uellix Privacy Policy: how the platform handles and protects each organization's data.",
  alternates: { canonical: "/privacy" },
  // Draft pending legal review (see on-page banner). Keep it reachable for users
  // but out of Google's index until it's a binding document. Flip to `index: true`
  // and re-add to app/sitemap.ts once legal signs off.
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <div className="mb-4 rounded-md border border-[#FF6A00]/30 bg-[#FF6A00]/5 px-4 py-3 text-sm text-uellix-deep">
        <strong className="font-semibold">Draft pending legal review.</strong>{" "}
        This document describes in good faith how the platform handles data today,
        but it has not yet been reviewed or approved by a data protection lawyer.
        It should not be considered binding until the Uellix team confirms it.
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-uellix-deep font-sora">
        Privacy Policy
      </h1>
      <p className="mt-2 text-sm text-[#64748B]">
        Last updated: [PENDING — complete before publishing]
      </p>

      <div
        className="mt-10 max-w-none space-y-5 text-[15px] leading-relaxed text-[#334155]
          [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-sora [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-uellix-deep [&_h2]:first:mt-0
          [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1.5 [&_strong]:font-semibold [&_strong]:text-uellix-deep
          [&_a]:text-[#FF6A00] [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-uellix-orange-strong"
      >
        <h2>1. Who we are</h2>
        <p>
          This policy describes how [LEGAL ENTITY NAME PENDING]
          (&ldquo;Uellix&rdquo;) collects, uses and protects the data it processes
          through the Uellix platform.
        </p>

        <h2>2. What data we collect</h2>
        <p><strong>Account data:</strong> email, name, and the data of the organization you belong to (name, legal name, country, sector).</p>
        <p><strong>Customer Content:</strong> narratives, evidence (PDF, Excel, CSV, images, Word, links, text/testimonies, meeting minutes), indicators, financial proxies and SROI calculation results that you or your organization upload to the Platform.</p>
        <p><strong>Evidence metadata:</strong> each evidence file is processed with a cryptographic hash (SHA-256) to guarantee its integrity, along with metadata about who uploaded it, when, and its review status.</p>
        <p><strong>Audit logs:</strong> relevant methodological changes are recorded (proxy creation, evidence status changes, calculation parameter adjustments) with the corresponding user and date, for traceability and audit purposes — they cannot be edited or deleted retroactively.</p>
        <p><strong>Stella interactions:</strong> when you use Stella&apos;s advisor, validator or composer functions, the interaction is recorded (Stella role, pipeline step, generated response) to maintain the audit trail required by the SROI methodology.</p>

        <h2>3. How we use your data</h2>
        <ul>
          <li>To operate the Platform: authentication, per-organization data isolation, SROI calculation, report generation.</li>
          <li>For Stella&apos;s features, when you explicitly activate them.</li>
          <li>To send you operational emails: invitations to an organization, password recovery, notifications related to your account.</li>
          <li>For security: rate limiting on sensitive actions such as sign-in, and append-only audit logs.</li>
        </ul>
        <p>We do not use your data for advertising and we do not sell it to third parties.</p>

        <h2>4. Who we share data with</h2>
        <p>
          Uellix relies on infrastructure providers to operate. These providers
          process data on our behalf under their own data processing agreements,
          not as independent third parties:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — database hosting, authentication and
            evidence file storage. It applies Row Level Security (RLS) at the
            database level as an additional layer of isolation between
            organizations.
          </li>
          <li>
            <strong>Google (Gemini API)</strong> — the AI engine behind Stella.
            Before sending any text to the model, the Platform explicitly excludes
            file paths, full evidence content and raw financial proxy values from
            the context that is sent, and automatically filters patterns that look
            like credentials, passwords or API keys. Stella only receives the
            minimum project context necessary (narratives, indicator/outcome
            summaries) to be able to advise or validate.
          </li>
          <li>
            <strong>Resend</strong> — transactional email delivery (invitations,
            password recovery).
          </li>
        </ul>
        <p>
          We do not share Customer Content with other organizations on the
          Platform, except for the global financial proxies your organization
          chooses to submit for review and approval by the Uellix team as a shared
          methodological reference.
        </p>

        <h2>5. Isolation and security</h2>
        <ul>
          <li>Each organization has its own isolated data space, verified both at the application level and at the database level (RLS).</li>
          <li>Roles and permissions within your organization control who can view or modify what information.</li>
          <li>Uploaded evidence is verified with a SHA-256 hash to guarantee it has not been altered.</li>
          <li>Audit logs are append-only: they cannot be modified or deleted retroactively.</li>
        </ul>

        <h2>6. Cookies and session</h2>
        <p>
          We use strictly necessary cookies to keep your session signed in, managed
          by our authentication provider (Supabase Auth). We do not use advertising
          or cross-site tracking cookies.
        </p>

        <h2>7. Your rights over your data</h2>
        <p>You can request from us, by writing to <a href="mailto:hola@uellix.com">hola@uellix.com</a>:</p>
        <ul>
          <li>Access to the personal data we hold about you.</li>
          <li>Correction of inaccurate data.</li>
          <li>Deletion of your account, subject to your organization&apos;s traceability and audit obligations over Customer Content already uploaded.</li>
          <li>Export of your data in a usable format.</li>
        </ul>
        <p>
          [PENDING — confirm with legal counsel whether a specific regulatory
          framework applies (for example, personal data protection law of the
          company&apos;s country of incorporation or of the countries where client
          organizations operate) and document the formal process for exercising
          these rights].
        </p>

        <h2>8. Data retention</h2>
        <p>
          We retain Customer Content while your organization maintains an active
          account on the Platform, and for a reasonable period after termination to
          allow data export, unless a legal obligation requires a different period.
          Audit logs are retained indefinitely as part of the methodological
          traceability trail.
        </p>

        <h2>9. Minors</h2>
        <p>
          Uellix is a B2B tool aimed at organizations and professionals; it is not
          intended to be used directly by minors.
        </p>

        <h2>10. Changes to this policy</h2>
        <p>
          If we make significant changes to this policy, we will communicate them
          through the Platform or by email before they take effect.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions about this policy or about your data: <a href="mailto:hola@uellix.com">hola@uellix.com</a>.
        </p>
      </div>

      <p className="mt-12 border-t border-[#E2E8F0] pt-4 text-xs text-[#64748B]">
        This English version is a draft courtesy translation pending legal review
        (gate G7). The Spanish version at{" "}
        <a href="/privacidad" className="text-[#FF6A00] underline underline-offset-2">/privacidad</a>{" "}
        is the source document and prevails in case of any conflict.
      </p>
    </div>
  );
}
