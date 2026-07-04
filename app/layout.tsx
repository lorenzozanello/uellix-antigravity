import type { Metadata } from "next";
import { Geist_Mono, Sora, Manrope, IBM_Plex_Mono } from "next/font/google";
import { siteUrl } from "@/lib/site";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  // 400/600/700 are the only weights used across the app; 800 was dead weight.
  weight: ["400", "600", "700"],
  display: "swap",
  preload: true,
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Uellix | Ledger Cívico de Impacto Social",
    template: "%s | Uellix",
  },
  description:
    "Uellix estructura proyectos, conecta evidencias, documenta proxies y filtros SROI, y genera reportes audit-ready preparados para revisión externa.",
  applicationName: "Uellix",
  keywords: [
    "SROI",
    "impacto social",
    "evidencia defendible",
    "audit-ready",
    "medición de impacto",
    "trazabilidad metodológica",
  ],
  authors: [{ name: "The Balance Corp" }],
  // NOTE: no `alternates.canonical` here. In the App Router, metadata is merged
  // down the tree, so a canonical set on the root layout is inherited by EVERY
  // route that doesn't override it — which would point /demo, /privacidad and
  // /terminos at the homepage. Canonicals are declared per-page instead.
  openGraph: {
    type: "website",
    // Product is Latin-America-focused (SROI, es-LATAM). es_ES (Spain) was the
    // wrong territory; es_LA is neutral Spanish across LatAm markets.
    locale: "es_LA",
    url: siteUrl,
    siteName: "Uellix",
    title: "Uellix | Ledger Cívico de Impacto Social",
    description:
      "Convierte el impacto social en evidencia defendible: proyectos estructurados, evidencias conectadas y reportes audit-ready para revisión externa.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Uellix | Ledger Cívico de Impacto Social",
    description:
      "Convierte el impacto social en evidencia defendible. Audit-ready, trazable, defendible.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      data-scroll-behavior="smooth"
      className={`${geistMono.variable} ${sora.variable} ${manrope.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
