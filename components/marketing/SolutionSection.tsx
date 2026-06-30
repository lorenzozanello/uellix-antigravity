import React from "react"
import { Workflow, ShieldCheck, Database, Sparkles, ShieldAlert, FileCheck2 } from "lucide-react"

const tiles = [
  {
    id: "sroi-pipeline",
    icon: Workflow,
    badge: "Core",
    title: "SROI Pipeline",
    description:
      "De la narrativa al cálculo en un único flujo trazable. Narrativa, stakeholders, resultados, indicadores, evidencias, proxies, filtros y cálculo, cada paso conectado y registrado.",
    highlight: true,
    size: "lg:col-span-2 lg:row-span-2",
  },
  {
    id: "trust-center",
    icon: ShieldCheck,
    badge: null,
    title: "Trust Center",
    description:
      "Hashes de integridad, fuentes verificables y supuestos explícitos consolidados en un rastro auditable para revisión externa.",
    highlight: false,
    size: "lg:col-span-1 lg:row-span-1",
  },
  {
    id: "proxy-intelligence",
    icon: Database,
    badge: null,
    title: "Proxy Intelligence",
    description:
      "Selecciona proxies financieros de fuentes reconocidas. Cada supuesto metodológico queda registrado con su justificación y fuente verificable.",
    highlight: false,
    size: "lg:col-span-1 lg:row-span-1",
  },
  {
    id: "stella-advisor",
    icon: Sparkles,
    badge: "Stella",
    title: "Stella Advisor",
    description:
      "Orientación metodológica paso a paso durante la construcción del análisis. Sugiere, no decide. La revisión humana es siempre tuya.",
    highlight: false,
    size: "lg:col-span-1 lg:row-span-1",
  },
  {
    id: "stella-validator",
    icon: ShieldAlert,
    badge: "Stella",
    title: "Stella Validator",
    description:
      "Identifica riesgos metodológicos en el paso de Cálculo: brechas de evidencia, riesgos de proxy y de atribución. Revisión humana requerida.",
    highlight: false,
    size: "lg:col-span-1 lg:row-span-1",
  },
  {
    id: "impact-deck",
    icon: FileCheck2,
    badge: "Output",
    title: "Impact Deck",
    description:
      "Reportes audit-ready revisables por terceros, con supuestos explícitos, fuentes citadas y el rastro completo de decisiones metodológicas exportable en cada paso.",
    highlight: true,
    size: "lg:col-span-2 lg:row-span-1",
  },
]

export function SolutionSection() {
  return (
    <section
      id="solucion"
      aria-label="Módulos de la plataforma Uellix"
      className="bg-slate-950 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            La plataforma
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            El sistema operativo de la evidencia de impacto
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            No un certificador. La infraestructura que conecta narrativa, evidencia, proxies y
            cálculo en un rastro metodológico coherente, trazable y audit-ready.
          </p>
        </div>

        {/* Bento grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:auto-rows-[minmax(180px,auto)]">
          {tiles.map(({ id, icon: Icon, badge, title, description, highlight, size }) => (
            <div
              key={id}
              className={`group relative flex flex-col gap-4 overflow-hidden rounded-xl border p-6 transition-all duration-200 card-lift ${
                highlight
                  ? "border-teal-500/25 bg-slate-900 hover:border-teal-500/40"
                  : "border-slate-800 bg-slate-900 hover:border-slate-700"
              } ${size}`}
            >
              {/* Tile glow for highlighted */}
              {highlight && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-xl bg-[radial-gradient(ellipse_80%_60%_at_0%_0%,rgba(20,184,166,0.07),transparent)]"
                />
              )}

              <div className="relative flex items-start justify-between gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    highlight
                      ? "bg-teal-500/15 group-hover:bg-teal-500/20"
                      : "bg-slate-800 group-hover:bg-slate-700"
                  }`}
                >
                  <Icon
                    className={`h-5 w-5 ${highlight ? "text-teal-400" : "text-slate-400 group-hover:text-teal-400"} transition-colors`}
                    aria-hidden="true"
                  />
                </div>
                {badge && (
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      badge === "Stella"
                        ? "bg-teal-500/10 text-teal-400 ring-1 ring-inset ring-teal-500/20"
                        : badge === "Output"
                        ? "bg-blue-500/10 text-blue-400 ring-1 ring-inset ring-blue-500/20"
                        : "bg-slate-800 text-slate-400 ring-1 ring-inset ring-slate-700"
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </div>

              <div className="relative flex flex-col gap-2">
                <h3 className="text-base font-semibold text-white">{title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
