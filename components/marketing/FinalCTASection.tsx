import React from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

export function FinalCTASection() {
  return (
    <section
      id="comenzar"
      aria-label="Llamada a la acción final"
      className="relative overflow-hidden bg-slate-950 px-4 py-20 sm:py-28"
    >
      {/* Deep teal glow from bottom */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute bottom-[-20%] left-1/2 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(20,184,166,0.12),transparent_60%)] animate-pulse-glow motion-reduce:animate-none" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-teal-500/20 to-transparent" />
      </div>

      {/* Subtle grid overlay */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.03)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,black,transparent)]"
      />

      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white mb-4">
          Tu próximo análisis de impacto merece una base que resiste.{" "}
          <span className="bg-gradient-to-r from-teal-400 to-cyan-400 bg-clip-text text-transparent">
            Evidencia defendible.
          </span>
        </h2>
        <p className="text-base sm:text-lg text-slate-400 max-w-xl mx-auto mb-10 leading-relaxed">
          Construye análisis SROI con la metodología, la trazabilidad y el rastro de evidencia
          que resisten el escrutinio externo.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-500 px-8 py-3.5 text-base font-semibold text-slate-950 shadow-sm shadow-teal-500/20 hover:bg-teal-400 active:bg-teal-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-colors min-h-[44px] w-full sm:w-auto"
          >
            Empezar gratis
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <a
            href="mailto:hola@uellix.com?subject=Solicitud%20de%20demo"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-8 py-3.5 text-base font-semibold text-slate-100 hover:bg-slate-800 hover:border-slate-600 active:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-colors min-h-[44px] w-full sm:w-auto"
          >
            Escribirnos →
          </a>
        </div>

        <p className="mt-6 text-xs text-slate-500 leading-relaxed">
          Stella asiste y revisa riesgos metodológicos; la revisión humana sigue siendo requerida.
        </p>
      </div>
    </section>
  )
}
