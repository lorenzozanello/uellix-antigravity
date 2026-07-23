import React from "react"
import Link from "next/link"
import { ArrowRight, FileCheck2 } from "lucide-react"

const benefits = [
  "Implementación guiada",
  "Capacitación metodológica",
  "Soporte continuo",
]

export function FinalCTASection() {
  return (
    <section
      id="demo"
      aria-label="Llamada a la acción final"
      className="relative overflow-hidden bg-[var(--uellix-carbon)] px-4 py-28 sm:py-40"
    >
      <div className="texture-grain-c" aria-hidden="true" />

      {/* Layered dossier motif — decorative */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[4%] top-1/2 -translate-y-1/2 hidden lg:block opacity-[0.08]"
      >
        <div className="relative w-[320px] h-[320px]">
          <div className="absolute inset-0 rounded-3xl border border-white/10 rotate-[12deg]" />
          <div className="absolute inset-[14px] rounded-3xl border border-white/8 rotate-[8deg]" />
          <div className="absolute inset-[28px] rounded-3xl border border-uellix-orange/30 rotate-[4deg]" />
          <div className="absolute inset-[42px] rounded-3xl border border-uellix-orange/20" />
          <div className="absolute inset-[56px] rounded-3xl bg-uellix-orange/10 border border-uellix-orange/30 flex items-center justify-center">
            <span className="font-sora text-7xl font-semibold text-uellix-orange/40 select-none">U</span>
          </div>
        </div>
      </div>

      {/* Radial + technical grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_70%_at_50%_100%,rgba(252,76,13,0.08),transparent_65%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(252,76,13,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(252,76,13,0.025)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,black,transparent)]"
      />

      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-uellix-orange mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-uellix-orange" aria-hidden="true" />
          Comenzar
        </span>

        <h2 className="font-sora text-[clamp(2.2rem,5vw,4rem)] font-bold tracking-[-0.02em] text-white mb-6 leading-[1.02]">
          Trae un proyecto. Uellix te ayuda a convertirlo en un{" "}
          <span className="text-uellix-orange">análisis defendible.</span>
        </h2>
        <p className="text-base sm:text-lg text-[#94A3B8] max-w-xl mx-auto mb-10 leading-relaxed font-manrope">
          Construye análisis SROI con la metodología, la trazabilidad y el rastro
          de evidencia que resisten el escrutinio externo.
        </p>

        <div className="flex flex-col sm:flex-row gap-3.5 justify-center items-stretch sm:items-center mb-10">
          <Link
            href="/demo"
            className="btn-premium inline-flex items-center justify-center gap-2 rounded-lg bg-uellix-orange px-8 py-4 text-base font-semibold text-white hover:bg-uellix-orange-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange min-h-[48px] w-full sm:w-auto shadow-[0_10px_30px_-8px_rgba(252,76,13,0.6)]"
          >
            Solicitar demo privada
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href="/login"
            className="btn-premium inline-flex items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/[0.04] px-8 py-4 text-base font-semibold text-[#CBD5E1] hover:bg-white/[0.08] hover:text-white hover:border-white/24 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange min-h-[48px] w-full sm:w-auto"
          >
            Entrar a Uellix
          </Link>
        </div>

        <ul aria-label="Incluido con Uellix" className="flex flex-col sm:flex-row flex-wrap gap-x-6 gap-y-2 justify-center mb-8">
          {benefits.map((benefit) => (
            <li key={benefit} className="flex items-center gap-2 font-ibm-plex-mono text-[11px] uppercase tracking-[0.1em] text-[#94A3B8]">
              <span className="h-1 w-1 rounded-full bg-uellix-orange" aria-hidden="true" />
              {benefit}
            </li>
          ))}
        </ul>

        <div className="mx-auto mb-6 flex max-w-xs items-center gap-3 sm:max-w-none sm:justify-center" aria-hidden="true">
          <span className="h-px flex-1 bg-white/10" />
          <span className="flex items-center gap-2 font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">
            <FileCheck2 className="h-3.5 w-3.5 text-uellix-orange/70" />
            Expediente listo para revisión
          </span>
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <p className="text-xs text-[#64748B] leading-relaxed font-manrope">
          Stella ayuda a identificar riesgos metodológicos. La validación final
          permanece en manos del equipo experto.
        </p>
      </div>
    </section>
  )
}
