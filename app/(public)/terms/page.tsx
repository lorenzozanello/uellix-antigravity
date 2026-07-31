// EN translation of the ES legal source — G7 legal review pending; ES prevails on conflict.
// Source of truth: app/(public)/terminos/page.tsx. Keep sections in sync with it.
import type { Metadata } from "next";

export const metadata: Metadata = {
  // Plain string → the root template ("%s | Uellix") appends the brand. Do NOT
  // repeat "Uellix" here or the title renders as "… · Uellix | Uellix".
  title: "Terms of Service",
  description:
    "Uellix Terms of Service: conditions of use of the audit-ready social impact intelligence platform.",
  alternates: { canonical: "/terms" },
  // Draft pending legal review (see on-page banner). Keep it reachable for users
  // but out of Google's index until it's a binding document. Flip to `index: true`
  // and re-add to app/sitemap.ts once legal signs off.
  robots: { index: false, follow: true },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <div className="mb-4 rounded-md border border-[#FF6A00]/30 bg-[#FF6A00]/5 px-4 py-3 text-sm text-[#0F172A]">
        <strong className="font-semibold">Draft pending legal review.</strong>{" "}
        This document describes the platform&apos;s actual practices in good faith,
        but it has not yet been reviewed or approved by a lawyer. It should not be
        considered binding until the Uellix team confirms it.
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-[#0F172A] font-sora">
        Terms of Service
      </h1>
      <p className="mt-2 text-sm text-[#64748B]">
        Last updated: [PENDING — complete before publishing]
      </p>

      <div
        className="mt-10 max-w-none space-y-5 text-[15px] leading-relaxed text-[#334155]
          [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-sora [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[#0F172A] [&_h2]:first:mt-0
          [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1.5 [&_strong]:font-semibold [&_strong]:text-[#0F172A]
          [&_a]:text-[#FF6A00] [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-[#e05e00]"
      >
        <h2>1. Who we are</h2>
        <p>
          Uellix is operated by [LEGAL ENTITY NAME PENDING — complete with the
          registered legal entity], hereinafter &ldquo;Uellix&rdquo;,
          &ldquo;we&rdquo; or &ldquo;the Platform&rdquo;. These Terms govern the use
          of the B2B SaaS social impact intelligence platform available on this site
          and its associated applications.
        </p>

        <h2>2. What Uellix is</h2>
        <p>
          Uellix turns narratives, evidence, indicators, financial proxies and
          social impact calculations into a traceable, auditable, audit-ready SROI
          (Social Return on Investment) trail.
        </p>
        <p>
          <strong>Uellix does not automatically certify the social impact of any
          program or organization.</strong> The Platform prepares, structures,
          strengthens and documents impact evidence and indicators to make them
          traceable, verifiable and defensible before third parties (funders,
          auditors, regulators). Final validation of any impact report remains the
          human responsibility of the user organization.
        </p>
        <p>
          Uellix includes an artificial intelligence layer (&ldquo;Stella&rdquo;)
          that acts as a methodological advisor, structured validator and drafter of
          narrative drafts. Stella does not replace human review, does not approve
          financial proxies autonomously, does not invent sources or evidence, and
          does not issue legal or certification opinions.
        </p>

        <h2>3. Accounts and access</h2>
        <ul>
          <li>
            To use Uellix you need to create an account with a valid email address
            and belong to an organization within the Platform (your own or by
            invitation).
          </li>
          <li>
            You are responsible for keeping your credentials confidential and for
            all activity that occurs under your account.
          </li>
          <li>
            Self-service access to create new organizations may be subject to a
            controlled enablement process managed by Uellix.
          </li>
          <li>
            Roles and permissions within an organization (administrator, impact
            manager, analyst, reviewer, read-only) determine which actions each
            user can perform; it is the organization administrator&apos;s
            responsibility to assign them correctly.
          </li>
        </ul>

        <h2>4. Data and content you upload</h2>
        <p>
          When using Uellix, you and your organization retain ownership of all
          content you upload to the Platform: narratives, evidence, indicators,
          proxies, calculation results and reports (&ldquo;Customer
          Content&rdquo;). Uellix claims no ownership over that content.
        </p>
        <p>
          You grant us a limited license to store, process and display that content
          solely for the purpose of operating the Platform for you and your
          organization, including processing by Stella when you explicitly activate
          that functionality.
        </p>
        <p>
          You are responsible for having the necessary rights and consents over any
          evidence, testimony or third-party personal data (beneficiaries, survey
          respondents) that you upload to the Platform, and for applying the
          available anonymization options where appropriate.
        </p>

        <h2>5. Isolation between organizations</h2>
        <p>
          Each organization in Uellix operates in an isolated data space. Your
          organization&apos;s Customer Content is not visible to other
          organizations on the Platform, except for the global financial proxies
          curated and approved by the Uellix team, which are explicitly designed to
          be shared as a methodological reference.
        </p>

        <h2>6. Acceptable use</h2>
        <p>You may not use Uellix to:</p>
        <ul>
          <li>Upload false evidence, invented sources or data you know to be inaccurate in order to inflate impact results.</li>
          <li>Present reports generated in Uellix as an official certification or guarantee of impact without due human review.</li>
          <li>Attempt to access another organization&apos;s data without authorization.</li>
          <li>Overload, interfere with or attempt to compromise the security of the Platform.</li>
          <li>Use the Platform in violation of any applicable law.</li>
        </ul>

        <h2>7. Availability and changes to the service</h2>
        <p>
          We work to keep the Platform continuously available, but we do not
          guarantee uninterrupted availability. We may modify, add or remove
          functionality over time; changes that significantly affect ordinary use
          of the service will be communicated with reasonable advance notice where
          possible.
        </p>

        <h2>8. Termination</h2>
        <p>
          You may stop using Uellix at any time. We reserve the right to suspend or
          cancel accounts that violate these Terms, with prior notice except in
          cases of security risk. Upon termination of the relationship, Customer
          Content is retained for a reasonable period to allow data export, unless
          a legal obligation provides otherwise.
        </p>

        <h2>9. Limitation of liability</h2>
        <p>
          Uellix is provided &ldquo;as is&rdquo;. To the maximum extent permitted
          by applicable law, Uellix will not be liable for business, funding or
          compliance decisions your organization makes based on reports generated
          on the Platform, including suggestions generated by Stella. Final
          validation of any impact claim is the responsibility of the user
          organization.
        </p>

        <h2>10. Governing law</h2>
        <p>
          [PENDING — define jurisdiction and applicable law with legal counsel
          before publishing].
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions about these Terms: <a href="mailto:hola@uellix.com">hola@uellix.com</a>.
        </p>
      </div>

      <p className="mt-12 border-t border-[#E2E8F0] pt-4 text-xs text-[#64748B]">
        This English version is a draft courtesy translation pending legal review
        (gate G7). The Spanish version at{" "}
        <a href="/terminos" className="text-[#FF6A00] underline underline-offset-2">/terminos</a>{" "}
        is the source document and prevails in case of any conflict.
      </p>
    </div>
  );
}
