import type { Metadata } from "next";
import { Geist_Mono, Sora, Manrope, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  display: "swap",
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

const siteUrl = "https://uellix-antigravity.vercel.app";

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
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "es_ES",
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
