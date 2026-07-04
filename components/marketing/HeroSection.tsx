import React from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { EvidenceDossier } from "@/components/marketing/visuals/EvidenceDossier"

export function HeroSection() {
  return (
    <section
      id="inicio"
      aria-label="Sección principal"
      className="relative overflow-hidden bg-[var(--uellix-paper)] px-4 pt-16 pb-20 sm:pt-24 sm:pb-28 lg:pt-28 lg:pb-36"
    >
      {/* Fine technical grid — masked toward top */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:radial-gradient(ellipse_85%_65%_at_60%_0%,black_35%,transparent)]"
      />
      {/* Copper/orange radial — very subtle */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[-8%] top-[-8%] h-[560px] w-[560px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,106,0,0.07),transparent_62%)]"
      />

      <div className="relative z-10 mx-auto max-w-7xl">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 xl:gap-16">

          {/* ── Left: editorial copy column ── */}
          <div className="flex flex-col items-start text-left animate-fade-up">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#FF6A00]/25 bg-[#FF6A00]/8 px-3.5 py-1.5 text-[11px] font-semibold text-[#B85200] mb-7 font-ibm-plex-mono tracking-[0.14em] uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-[#FF6A00] shrink-0" aria-hidden="true" />
              Ledger cívico de impacto
            </span>

            <h1 className="font-sora font-semibold tracking-[-0.02em] text-[#0F172A] mb-6 text-[clamp(2.6rem,6vw,5.5rem)] leading-[0.98]">
              Convierte el impacto social en{" "}
              <span className="text-[#FF6A00]">evidencia defendible.</span>
            </h1>

            <p className="font-manrope text-base sm:text-lg text-[#475569] max-w-xl mb-9 leading-relaxed">
              Uellix estructura proyectos, conecta evidencias, documenta proxies y
              filtros SROI, y genera reportes audit-ready preparados para revisión
              externa.
            </p>

            <div className="flex flex-col sm:flex-row gap-3.5 items-stretch sm:items-center w-full sm:w-auto">
              <Link
                href="/demo"
                className="btn-premium inline-flex items-center justify-center gap-2 rounded-lg bg-[#FF6A00] px-7 py-3.5 text-base font-semibold text-white hover:bg-[#e05e00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[48px] w-full sm:w-auto shadow-[0_6px_20px_-6px_rgba(255,106,0,0.55)]"
              >
                Solicitar demo
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <a
                href="#metodologia"
                className="btn-premium inline-flex items-center justify-center gap-2 rounded-lg border border-[#0F172A]/12 bg-white/70 px-7 py-3.5 text-base font-semibold text-[#0F172A] hover:bg-white hover:border-[#0F172A]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[48px] w-full sm:w-auto"
              >
                Ver metodología
              </a>
            </div>

            <p className="mt-7 max-w-md text-xs leading-relaxed font-manrope text-[#5B6472] border-l-2 border-[#FF6A00]/30 pl-3">
              Stella ayuda a identificar riesgos metodológicos. La validación final
              permanece en manos del equipo experto.
            </p>
          </div>

          {/* ── Right: Evidence Dossier — visible on all breakpoints ── */}
          <div className="flex items-center justify-center lg:justify-end animate-fade-up">
            <EvidenceDossier />
          </div>
        </div>
      </div>
    </section>
  )
}
