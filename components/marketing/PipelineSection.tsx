import React from "react"
import { ChevronRight } from "lucide-react"

const steps = [
  { label: "Narrativa", number: 1 },
  { label: "Stakeholders", number: 2 },
  { label: "Resultados", number: 3 },
  { label: "Indicadores", number: 4 },
  { label: "Evidencias", number: 5 },
  { label: "Proxies", number: 6 },
  { label: "Filtros SROI", number: 7 },
  { label: "Cálculo", number: 8 },
  { label: "Stella Review", number: 9, highlight: true },
  { label: "Impact Deck", number: 10, accent: true },
]

export function PipelineSection() {
  return (
    <section
      id="pipeline"
      aria-label="Flujo del pipeline de impacto"
      className="bg-slate-900 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            El pipeline
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Del dato al informe: un flujo trazable
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Cada paso del análisis queda registrado, conectado y disponible para revisión. Ningún
            supuesto queda oculto. Ninguna evidencia, desvinculada.
          </p>
        </div>

        {/* Mobile: vertical list */}
        <ol
          aria-label="Pasos del pipeline"
          className="flex flex-col gap-3 sm:hidden"
        >
          {steps.map(({ label, number, highlight, accent }) => (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  accent
                    ? "bg-teal-500 text-slate-950"
                    : highlight
                    ? "bg-teal-500/20 text-teal-400 border border-teal-500/30"
                    : "bg-slate-800 text-slate-400"
                }`}
                aria-hidden="true"
              >
                {number}
              </span>
              <span
                className={`text-sm font-medium ${
                  accent ? "text-teal-400" : highlight ? "text-teal-300" : "text-slate-300"
                }`}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>

        {/* Desktop: horizontal flow */}
        <div
          className="hidden sm:flex flex-wrap items-center justify-center gap-2"
          role="list"
          aria-label="Pasos del pipeline"
        >
          {steps.map(({ label, number, highlight, accent }, index) => (
            <React.Fragment key={label}>
              <div
                role="listitem"
                className={`flex items-center gap-2 rounded-lg px-4 py-2.5 border text-sm font-medium ${
                  accent
                    ? "bg-teal-500 border-teal-400 text-slate-950"
                    : highlight
                    ? "bg-teal-500/10 border-teal-500/30 text-teal-300"
                    : "bg-slate-800 border-slate-700 text-slate-300"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    accent ? "bg-slate-950/20 text-slate-950" : "bg-slate-700 text-slate-400"
                  }`}
                  aria-hidden="true"
                >
                  {number}
                </span>
                {label}
              </div>
              {index < steps.length - 1 && (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-slate-600"
                  aria-hidden="true"
                />
              )}
            </React.Fragment>
          ))}
        </div>

        <p className="mt-10 text-center text-xs text-slate-500 max-w-xl mx-auto leading-relaxed">
          Stella Review identifica riesgos metodológicos en el paso de Cálculo. No calcula el SROI
          ni reemplaza la revisión humana.
        </p>
      </div>
    </section>
  )
}
