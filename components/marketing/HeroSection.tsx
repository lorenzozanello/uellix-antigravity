import React from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

export function HeroSection() {
  return (
    <section
      id="inicio"
      aria-label="Sección principal"
      className="relative flex flex-col items-center justify-center px-4 py-24 sm:py-32 lg:py-40 text-center overflow-hidden bg-slate-950"
    >
      {/* Radial glow */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(20,184,166,0.07),transparent)] pointer-events-none"
      />
      {/* Subtle grid */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.03)_1px,transparent_1px)] bg-[size:64px_64px] pointer-events-none"
      />

      <div className="relative z-10 mx-auto max-w-4xl flex flex-col items-center">
        <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-8">
          Plataforma audit-ready de evidencia de impacto
        </span>

        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl text-white mb-6 leading-tight">
          Uellix convierte el impacto social en{" "}
          <span className="bg-gradient-to-r from-teal-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
            evidencia defendible
          </span>
        </h1>

        <p className="text-base sm:text-lg text-slate-300 max-w-2xl mb-10 leading-relaxed">
          Una plataforma audit-ready para estructurar proyectos de impacto, asociar evidencias,
          seleccionar proxies verificables, aplicar filtros SROI y generar reportes revisables con
          apoyo de Stella.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center w-full sm:w-auto">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-sm hover:bg-teal-400 active:bg-teal-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-colors min-h-[44px] w-full sm:w-auto"
          >
            Entrar a la plataforma
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <a
            href="mailto:hola@uellix.com?subject=Solicitud%20de%20demo"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-6 py-3 text-base font-semibold text-slate-100 hover:bg-slate-800 hover:border-slate-600 active:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-colors min-h-[44px] w-full sm:w-auto"
          >
            Solicitar demo
          </a>
        </div>

        <p className="mt-6 text-xs text-slate-500 max-w-md leading-relaxed">
          Stella asiste y revisa riesgos metodológicos; la revisión humana sigue siendo requerida.
        </p>
      </div>
    </section>
  )
}
