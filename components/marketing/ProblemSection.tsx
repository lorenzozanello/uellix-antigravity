import React from "react"
import { AlertCircle, FileX, Search } from "lucide-react"

const problems = [
  {
    icon: FileX,
    title: "Información dispersa e inconectada",
    description:
      "Los análisis de impacto quedan fragmentados en documentos, hojas de cálculo y evidencias sin conexión entre sí. La trazabilidad metodológica se pierde antes de llegar al reporte.",
  },
  {
    icon: AlertCircle,
    title: "Supuestos difíciles de defender",
    description:
      "Los proxies y supuestos metodológicos son cuestionados en revisiones externas porque no hay un registro claro de su fuente, su justificación ni su aplicación en el cálculo.",
  },
  {
    icon: Search,
    title: "Reportes sin rastro verificable",
    description:
      "Los informes externos exigen trazabilidad completa: fuente, supuesto, evidencia y cálculo. Sin esa estructura, la defensa del análisis queda expuesta ante cualquier auditoría.",
  },
]

export function ProblemSection() {
  return (
    <section
      id="desafio"
      aria-label="El desafío de la medición de impacto"
      className="bg-slate-900 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            El desafío
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            La medición de impacto es difícil de defender
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Las organizaciones invierten semanas construyendo análisis SROI que no resisten el
            escrutinio porque la metodología, la evidencia y los supuestos no están conectados
            de forma trazable.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {problems.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="group rounded-xl border border-slate-800 bg-slate-950 p-6 flex flex-col gap-4 card-lift"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800 transition-colors group-hover:bg-slate-700">
                <Icon
                  className="h-5 w-5 text-slate-400 transition-colors group-hover:text-teal-400"
                  aria-hidden="true"
                />
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
