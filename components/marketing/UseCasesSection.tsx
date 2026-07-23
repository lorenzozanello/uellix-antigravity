import React from "react"
import { Building2, TrendingUp, GraduationCap, Compass, ArrowUpRight } from "lucide-react"

const featured = {
  n: "01",
  icon: Building2,
  title: "Fundaciones y cooperación",
  description:
    "Estructura análisis de impacto con evidencias trazables y metodología revisable por donantes, aliados de cooperación e inversores — lista para escrutinio externo.",
  result: "De relatos de programa a evidencia defendible.",
}

const segments = [
  {
    n: "02",
    icon: TrendingUp,
    title: "Empresas e inversión social / ESG",
    description:
      "Documenta el retorno social de iniciativas corporativas con un rastro metodológico sólido para reportes ESG y stakeholders externos.",
  },
  {
    n: "03",
    icon: GraduationCap,
    title: "Universidades y extensión",
    description:
      "Mide el impacto de investigación aplicada y vinculación comunitaria con rigor metodológico verificable.",
  },
  {
    n: "04",
    icon: Compass,
    title: "Consultores de impacto",
    description:
      "Entrega análisis SROI defendibles a tus clientes, con supuestos explícitos y fuentes verificables en cada paso.",
  },
]

export function UseCasesSection() {
  return (
    <section
      id="casos"
      aria-label="Casos de uso y audiencias"
      className="bg-[var(--uellix-paper)] px-4 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-7xl">
        <div className="max-w-2xl mb-14">
          <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-6">
            <span className="h-px w-8 bg-uellix-orange/30" aria-hidden="true" />
            Para quién
          </span>
          <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-bold leading-[1.05] tracking-[-0.015em] text-[#0F172A]">
            Para quienes generan impacto y deben demostrarlo.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">

          {/* Featured segment — large */}
          <div className="lg:col-span-6">
            <div className="group relative flex h-full flex-col justify-between overflow-hidden rounded-2xl border border-[#0F172A]/10 bg-[var(--uellix-carbon)] p-8 sm:p-10 card-lift">
              <div className="texture-grain" aria-hidden="true" />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_100%_0%,rgba(252,76,13,0.10),transparent_60%)]"
              />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <span className="font-sora text-6xl font-semibold text-white/12 tabular-nums leading-none" aria-hidden="true">
                    {featured.n}
                  </span>
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-uellix-orange/30 bg-uellix-orange/12">
                    <featured.icon className="h-5 w-5 text-uellix-orange" aria-hidden="true" />
                  </span>
                </div>
                <h3 className="mt-8 font-sora text-2xl sm:text-3xl font-semibold text-white leading-tight">
                  {featured.title}
                </h3>
                <p className="mt-4 text-[15px] text-[#94A3B8] leading-relaxed font-manrope max-w-md">
                  {featured.description}
                </p>
              </div>
              <p className="relative mt-8 flex items-center gap-2 font-ibm-plex-mono text-[11px] uppercase tracking-[0.14em] text-uellix-orange">
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                {featured.result}
              </p>
            </div>
          </div>

          {/* Three editorial segments — hairline divided */}
          <div className="lg:col-span-6">
            <div className="flex h-full flex-col rounded-2xl border border-[#0F172A]/10 bg-white/70 backdrop-blur-sm px-6 sm:px-8">
              {segments.map(({ n, icon: Icon, title, description }, i) => (
                <div
                  key={n}
                  className={`group grid grid-cols-[auto_1fr] gap-5 py-7 ${
                    i !== 0 ? "border-t border-[#0F172A]/10" : ""
                  }`}
                >
                  <div className="flex flex-col items-center gap-2">
                    <span className="font-sora text-2xl font-semibold text-[#0F172A]/15 tabular-nums leading-none transition-premium group-hover:text-uellix-orange/60" aria-hidden="true">
                      {n}
                    </span>
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#0F172A]/10 bg-[var(--uellix-paper)] transition-premium group-hover:border-uellix-orange/30 group-hover:bg-uellix-orange/5">
                      <Icon className="h-4 w-4 text-[#0F172A] transition-premium group-hover:text-uellix-orange" aria-hidden="true" />
                    </span>
                  </div>
                  <div>
                    <h3 className="font-sora text-lg font-semibold text-[#0F172A] mb-1.5">{title}</h3>
                    <p className="text-sm text-[#5B6472] leading-relaxed font-manrope">{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
