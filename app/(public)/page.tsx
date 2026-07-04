import React from "react"
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

export default function HomePage() {
  return (
    <>
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
