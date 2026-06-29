import React from "react"
import { FileText, Paperclip, BarChart3, Calculator, Eye, BookOpen } from "lucide-react"

const features = [
  {
    icon: FileText,
    title: "Narrativa estructurada",
    description:
      "Define tu teoría del cambio, documenta stakeholders y resultados esperados en un flujo metodológico coherente y revisable.",
  },
  {
    icon: Paperclip,
    title: "Evidencias trazables",
    description:
      "Asocia documentos, fuentes y referencias a cada indicador. Cada evidencia queda vinculada a su resultado con fuente verificable.",
  },
  {
    icon: BarChart3,
    title: "Proxies verificables",
    description:
      "Selecciona proxies financieros de fuentes reconocidas. Cada supuesto queda registrado con su justificación metodológica.",
  },
  {
    icon: Calculator,
    title: "Cálculo SROI con filtros",
    description:
      "Aplica filtros estándar (peso muerto, atribución, desplazamiento, depreciación) y calcula el ratio SROI sobre una base metodológica explícita.",
  },
  {
    icon: Eye,
    title: "Revisión metodológica",
    description:
      "Stella identifica riesgos metodológicos antes de externalizar el análisis. La revisión humana sigue siendo el paso final requerido.",
  },
  {
    icon: BookOpen,
    title: "Reportes revisables",
    description:
      "Genera reportes audit-ready con supuestos explícitos, fuentes citadas y rastro de decisiones metodológicas para revisión externa.",
  },
]

export function SolutionSection() {
  return (
    <section
      id="solucion"
      aria-label="La solución Uellix"
      className="bg-slate-950 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            La solución
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Un sistema operativo de evidencia de impacto
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Uellix no es un certificador. Es la infraestructura que conecta narrativa, evidencia,
            proxies y cálculo en un rastro metodológico coherente, trazable y audit-ready.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="group rounded-xl border border-slate-800 bg-slate-900 p-6 flex flex-col gap-4 hover:border-slate-700 transition-colors"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 group-hover:bg-teal-500/15 transition-colors">
                <Icon className="h-5 w-5 text-teal-400" aria-hidden="true" />
              </div>
              <h3 className="text-base font-semibold text-white">{title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
