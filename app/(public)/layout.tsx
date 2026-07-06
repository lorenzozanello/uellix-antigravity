import React from "react";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { NavigationProgress } from "@/components/marketing/visuals/NavigationProgress";
import { siteUrl } from "@/lib/site";

// JSON-LD Organization — no invented claims, only verifiable brand facts.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Uellix",
  legalName: "The Balance Corp",
  url: siteUrl,
  // 1024x1024 raster, matches Google's Logo structured-data requirement
  // (square, PNG/JPG/GIF, min 112x112 — the SVG brand marks don't qualify).
  logo: `${siteUrl}/brand/uellix-logo-icon-from-guide.png`,
  description:
    "Plataforma de inteligencia de impacto social audit-ready: estructura proyectos, conecta evidencias, documenta proxies y filtros SROI y genera reportes preparados para revisión externa.",
  email: "hola@uellix.com",
  slogan: "Convierte el impacto social en evidencia defendible.",
};

// JSON-LD WebSite — anchors the site name/language as an entity. No
// `potentialAction: SearchAction`: there is no public site search, and the
// schema must not claim a capability that doesn't exist.
const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Uellix",
  url: siteUrl,
  inLanguage: "es",
  publisher: { "@type": "Organization", name: "Uellix" },
};

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--uellix-paper)] text-[var(--uellix-ink)] font-manrope selection:bg-[#FF6A00]/20 selection:text-[#0F172A]">
      <script
        type="application/ld+json"
        // Static, trusted content — safe to inline.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <script
        type="application/ld+json"
        // Static, trusted content — safe to inline.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />

      {/* Skip link — visible on focus */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-[#0F172A] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[#FF6A00]"
      >
        Saltar al contenido
      </a>

      {/* CSS scroll progress bar — decorative, aria-hidden */}
      <div className="landing-scroll-progress" aria-hidden="true" />

      <Navbar />
      <NavigationProgress />

      <main id="main-content" className="flex-1 flex flex-col" tabIndex={-1}>
        {children}
      </main>

      <Footer />
    </div>
  );
}
