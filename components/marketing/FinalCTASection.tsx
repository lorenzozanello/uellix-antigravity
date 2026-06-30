import React from "react"
import Link from "next/link"
import { ArrowRight, CheckCircle2 } from "lucide-react"

const benefits = [
  "Implementación guiada",
  "Capacitación y buenas prácticas",
  "Soporte metodológico continuo",
]

export function FinalCTASection() {
  return (
    <section
      id="demo"
      aria-label="Llamada a la acción final"
      className="relative overflow-hidden bg-[#0F172A] px-4 py-20 sm:py-28"
    >
      {/* Isotipo layers — decorative visual */}
      <div aria-hidden="true" className="pointer-events-none absolute right-[5%] top-1/2 -translate-y-1/2 hidden lg:block opacity-8">
        <div className="relative w-[280px] h-[280px]">
          <div className="absolute inset-0 rounded-3xl border border-white/6 rotate-[12deg]" />
          <div className="absolute inset-[12px] rounded-3xl border border-white/5 rotate-[8deg]" />
          <div className="absolute inset-[24px] rounded-3xl border border-[#FF6A00]/20 rotate-[4deg]" />
          <div className="absolute inset-[36px] rounded-3xl border border-[#FF6A00]/15" />
          <div className="absolute inset-[48px] rounded-3xl bg-[#FF6A00]/10 border border-[#FF6A00]/25 flex items-center justify-center">
            <span className="font-ibm-plex-mono text-6xl font-black text-[#FF6A00]/30 select-none">U</span>
          </div>
        </div>
      </div>

      {/* Subtle grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,106,0,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,106,0,0.02)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,black,transparent)]"
      />

      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center rounded-full border border-[#FF6A00]/30 bg-[#FF6A00]/10 px-4 py-1.5 text-xs font-semibold text-[#FF6A00] mb-8 font-ibm-plex-mono tracking-wide uppercase">
          Comenzar
        </span>

        <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-white mb-4">
          Tu próximo análisis de impacto merece
          <br className="hidden sm:block" /> una base que resiste.{" "}
          <span className="text-[#FF6A00]">
            Evidencia defendible.
          </span>
        </h2>
        <p className="text-base sm:text-lg text-[#64748B] max-w-xl mx-auto mb-10 leading-relaxed font-manrope">
          Construye análisis SROI con la metodología, la trazabilidad y el rastro
          de evidencia que resisten el escrutinio externo.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-10">
          <a
            href="mailto:hola@uellix.com?subject=Solicitud%20de%20demo"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#FF6A00] px-8 py-3.5 text-base font-semibold text-white hover:bg-[#e05e00] active:bg-[#cc5500] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] transition-colors duration-150 min-h-[44px] w-full sm:w-auto font-sora"
          >
            Solicitar demo
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#1E293B] bg-[#0A1220] px-8 py-3.5 text-base font-semibold text-[#94A3B8] hover:bg-[#1E293B] hover:text-white hover:border-[#334155] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] transition-colors duration-150 min-h-[44px] w-full sm:w-auto font-sora"
          >
            Entrar a Uellix
          </Link>
        </div>

        {/* Benefits */}
        <ul
          aria-label="Beneficios de Uellix"
          className="flex flex-col sm:flex-row flex-wrap gap-3 justify-center mb-8"
        >
          {benefits.map((benefit) => (
            <li key={benefit} className="flex items-center gap-2 text-sm text-[#64748B] font-manrope">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#FF6A00]" aria-hidden="true" />
              {benefit}
            </li>
          ))}
        </ul>

        <p className="text-xs text-[#334155] leading-relaxed font-manrope">
          Stella asiste y detecta riesgos metodológicos. La revisión humana es siempre requerida.
        </p>
      </div>
    </section>
  )
}
