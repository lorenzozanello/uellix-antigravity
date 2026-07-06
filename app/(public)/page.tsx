import React from "react"
import type { Metadata } from "next"
import { siteUrl } from "@/lib/site"
import { HeroSection } from "@/components/marketing/HeroSection"
import { EditorialManifesto } from "@/components/marketing/EditorialManifesto"
import { ProblemSection } from "@/components/marketing/ProblemSection"
import { SolutionSection } from "@/components/marketing/SolutionSection"
import { ProductPreviewSection } from "@/components/marketing/ProductPreviewSection"
import { PipelineSection } from "@/components/marketing/PipelineSection"
import { TrustLayerSection } from "@/components/marketing/TrustLayerSection"
import { StellaSection } from "@/components/marketing/StellaSection"
import { UseCasesSection } from "@/components/marketing/UseCasesSection"
import { SocialProofSection } from "@/components/marketing/SocialProofSection"
import { FAQSection } from "@/components/marketing/FAQSection"
import { FinalCTASection } from "@/components/marketing/FinalCTASection"

// Canonical lives on the page, not the root layout, so it can't leak to other
// routes (see the note in app/layout.tsx).
export const metadata: Metadata = {
  alternates: { canonical: "/" },
}

// JSON-LD SoftwareApplication — tells crawlers WHAT the product is, complementing
// the Organization schema (WHO builds it) in the public layout. Audit-ready: only
// verifiable facts, no invented ratings, pricing or install counts.
const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Uellix",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Impact Measurement",
  operatingSystem: "Web",
  url: siteUrl,
  description:
    "Plataforma de inteligencia de impacto social audit-ready: estructura proyectos, conecta evidencias, documenta proxies y filtros SROI y genera reportes preparados para revisión externa.",
  inLanguage: "es",
  provider: {
    "@type": "Organization",
    name: "The Balance Corp",
    url: siteUrl,
  },
}

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        // Static, trusted content — safe to inline.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(softwareApplicationJsonLd),
        }}
      />
      <HeroSection />
      <EditorialManifesto />
      <ProblemSection />
      <SolutionSection />
      {/* Dormant until real captures exist (lib/marketing/product-shots.ts) */}
      <ProductPreviewSection />
      <PipelineSection />
      <TrustLayerSection />
      <StellaSection />
      <UseCasesSection />
      {/* Dormant until real logos/quotes exist (lib/marketing/social-proof.ts) */}
      <SocialProofSection />
      <FAQSection />
      <FinalCTASection />
    </>
  )
}
