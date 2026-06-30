import React from "react"
import { Building2, Briefcase, GraduationCap, Globe, BarChart3, Users } from "lucide-react"

const useCases = [
  {
    icon: Building2,
    title: "Fundaciones",
    description:
      "Estructura análisis de impacto para programas sociales con evidencias trazables y metodología revisable por donantes e inversores.",
  },
  {
    icon: Briefcase,
    title: "Empresas con inversión social",
    description:
      "Documenta el retorno social de iniciativas corporativas con un rastro metodológico sólido para reportes ESG y stakeholders externos.",
  },
  {
    icon: GraduationCap,
    title: "Universidades e instituciones",
    description:
      "Mide el impacto de proyectos de investigación aplicada, vinculación comunitaria y extensión con rigor metodológico verificable.",
  },
  {
    icon: Globe,
    title: "Cooperación internacional",
    description:
      "Cumple con estándares de trazabilidad y rendición de cuentas para proyectos financiados por organizaciones internacionales o gobiernos.",
  },
  {
    icon: BarChart3,
    title: "Equipos ESG",
    description:
      "Genera evidencia de impacto social estructurada y defendible para marcos de reporte ESG, con supuestos explícitos y fuentes verificables.",
  },
  {
    icon: Users,
    title: "Consultores de impacto",
    description:
      "Apoya a consultoras y equipos especializados con una plataforma que centraliza la metodología, la evidencia y el cálculo SROI.",
  },
]

export function UseCasesSection() {
  return (
    <section
      id="para-quien"
      aria-label="Casos de uso y audiencias"
      className="bg-slate-950 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            Para quién
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Diseñado para equipos de impacto
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Uellix está pensado para organizaciones que necesitan metodología sólida, evidencia
            trazable y análisis SROI revisables por terceros.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="group flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900 p-6 card-lift"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 transition-colors group-hover:bg-teal-500/15">
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
