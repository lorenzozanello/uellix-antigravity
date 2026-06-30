import React from "react"
import Link from "next/link"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import { EvidenceGraph } from "@/components/marketing/visuals/EvidenceGraph"

const trustItems = [
  "Trazabilidad metodológica desde el primer dato",
  "Revisión humana requerida en cada análisis",
  "Audit-ready por diseño, no como extra",
]

export function HeroSection() {
  return (
    <section
      id="inicio"
      aria-label="Sección principal"
      className="relative overflow-hidden bg-slate-950 px-4 pt-20 pb-24 sm:pt-24 sm:pb-32 lg:pt-28 lg:pb-36"
    >
      {/* Aurora gradient mesh */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[30%] top-[-15%] h-[700px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(20,184,166,0.14),transparent_60%)] animate-aurora-drift motion-reduce:animate-none" />
        <div className="absolute right-[-8%] top-[15%] h-[500px] w-[500px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(56,189,248,0.08),transparent_65%)] animate-aurora-drift motion-reduce:animate-none [animation-delay:8s]" />
        <div className="absolute bottom-[-10%] left-[10%] h-[400px] w-[600px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(20,184,166,0.06),transparent_65%)] animate-aurora-drift motion-reduce:animate-none [animation-delay:4s]" />
      </div>

      {/* Technical grid — masked radially */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.04)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_80%_70%_at_50%_0%,black,transparent)]"
      />

      <div className="relative z-10 mx-auto max-w-7xl">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-10 xl:gap-16">

          {/* ── Left: copy column ── */}
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <span className="inline-flex items-center rounded-full border border-teal-500/20 bg-teal-500/8 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-8">
              Infraestructura audit-ready para evidencia de impacto
            </span>

            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-[3.4rem] xl:text-6xl text-white mb-6 leading-[1.07]">
              Uellix convierte el impacto social en{" "}
              <span className="bg-gradient-to-r from-teal-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
                evidencia defendible
              </span>
            </h1>

            <p className="text-base sm:text-lg text-slate-300 max-w-xl mb-10 leading-relaxed">
              Plataforma audit-ready para estructurar narrativa, asociar evidencias trazables,
              aplicar proxies verificables y calcular el SROI con un rastro metodológico
              revisable por terceros, con apoyo de Stella.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 items-center w-full sm:w-auto">
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-sm shadow-teal-500/20 hover:bg-teal-400 active:bg-teal-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 transition-colors min-h-[44px] w-full sm:w-auto"
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

            <ul
              aria-label="Puntos clave de la plataforma"
              className="mt-8 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2"
            >
              {trustItems.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-1.5 text-xs text-slate-500"
                >
                  <CheckCircle2
                    className="h-3.5 w-3.5 shrink-0 text-teal-500/70"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>

            <p className="mt-6 text-xs text-slate-500 max-w-md leading-relaxed">
              Stella asiste y revisa riesgos metodológicos; la revisión humana sigue siendo
              requerida.
            </p>
          </div>

          {/* ── Right: visual column (desktop only) ── */}
          <div className="hidden lg:flex items-center justify-center">
            <EvidenceGraph />
          </div>
        </div>
      </div>
    </section>
  )
}
