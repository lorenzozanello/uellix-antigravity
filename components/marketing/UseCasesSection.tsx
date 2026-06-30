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
    title: "Empresas sociales",
    description:
      "Documenta el retorno social de iniciativas corporativas con un rastro metodológico sólido para reportes ESG y stakeholders externos.",
  },
  {
    icon: GraduationCap,
    title: "Universidades",
    description:
      "Mide el impacto de proyectos de investigación aplicada, vinculación comunitaria y extensión con rigor metodológico verificable.",
  },
  {
    icon: Globe,
    title: "Sector público",
    description:
      "Cumple con estándares de trazabilidad y rendición de cuentas para proyectos financiados por organizaciones internacionales o gobiernos.",
  },
  {
    icon: BarChart3,
    title: "Cooperativas",
    description:
      "Genera evidencia de impacto social estructurada y defendible para marcos de reporte, con supuestos explícitos y fuentes verificables.",
  },
  {
    icon: Users,
    title: "ONGs",
    description:
      "Apoya a organizaciones con una plataforma que centraliza la metodología, la evidencia y el cálculo SROI de forma trazable.",
  },
]

export function UseCasesSection() {
  return (
    <section
      id="casos"
      aria-label="Casos de uso y audiencias"
      className="bg-white px-4 py-20 sm:py-28 border-b border-[#E2E8F0]"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-[#0F172A]/5 border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#64748B] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            Para quién
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-[#0F172A]">
            Diseñado para quienes generan impacto
            <br className="hidden sm:block" /> y deben demostrarlo.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto leading-relaxed font-manrope">
            Uellix está pensado para organizaciones que necesitan metodología sólida,
            evidencia trazable y análisis SROI revisables por terceros.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="group flex flex-col gap-4 rounded-xl border border-[#E2E8F0] bg-[#FBFAFC] p-6 card-lift hover:bg-white"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white border border-[#E2E8F0] shadow-sm transition-colors group-hover:border-[#FF6A00]/25 group-hover:bg-[#FF6A00]/5">
                <Icon
                  className="h-5 w-5 text-[#0F172A] transition-colors group-hover:text-[#FF6A00]"
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-base font-semibold text-[#0F172A] font-sora">{title}</h3>
              <p className="text-sm text-[#64748B] leading-relaxed font-manrope">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
