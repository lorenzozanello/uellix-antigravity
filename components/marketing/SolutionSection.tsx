import React from "react"
import { Workflow, ShieldCheck, Database, Sparkles, ShieldAlert, FileCheck2 } from "lucide-react"

const tiles = [
  {
    id: "sroi-pipeline",
    icon: Workflow,
    badge: "Core",
    title: "SROI Pipeline",
    description:
      "De la narrativa al cálculo en un único flujo trazable. Cada paso conectado y registrado: narrativa, stakeholders, resultados, indicadores, evidencias, proxies y cálculo.",
    highlight: true,
    size: "lg:col-span-2 lg:row-span-2",
  },
  {
    id: "trust-center",
    icon: ShieldCheck,
    badge: null,
    title: "Centro de confianza",
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
      "Selecciona proxies financieros de fuentes reconocidas. Cada supuesto queda registrado con su justificación y fuente verificable.",
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
      "Reportes audit-ready revisables por terceros, con supuestos explícitos, fuentes citadas y el rastro completo de decisiones metodológicas exportable.",
    highlight: true,
    size: "lg:col-span-2 lg:row-span-1",
  },
]

export function SolutionSection() {
  return (
    <section
      id="producto"
      aria-label="Módulos de la plataforma Uellix"
      className="bg-[#0F172A] px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full border border-[#FF6A00]/30 bg-[#FF6A00]/10 px-4 py-1.5 text-xs font-semibold text-[#FF6A00] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            La plataforma
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Un sistema operativo metodológico
            <br className="hidden sm:block" />
            para evidencia de impacto.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto leading-relaxed font-manrope">
            No un certificador. La infraestructura que conecta narrativa, evidencia,
            proxies y cálculo en un rastro metodológico coherente, trazable y audit-ready.
          </p>
        </div>

        {/* Bento grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:auto-rows-[minmax(180px,auto)]">
          {tiles.map(({ id, icon: Icon, badge, title, description, highlight, size }) => (
            <div
              key={id}
              className={`group relative flex flex-col gap-4 overflow-hidden rounded-xl border p-6 transition-all duration-200 card-lift ${
                highlight
                  ? "border-[#FF6A00]/20 bg-[#0F172A] hover:border-[#FF6A00]/35"
                  : "border-[#1E293B] bg-[#0A1220] hover:border-[#334155]"
              } ${size}`}
            >
              {/* Highlight accent glow */}
              {highlight && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-xl bg-[radial-gradient(ellipse_80%_60%_at_0%_0%,rgba(255,106,0,0.06),transparent)]"
                />
              )}

              <div className="relative flex items-start justify-between gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    highlight
                      ? "bg-[#FF6A00]/12 border border-[#FF6A00]/20 group-hover:bg-[#FF6A00]/18"
                      : "bg-[#1E293B] border border-[#334155] group-hover:bg-[#243048]"
                  }`}
                >
                  <Icon
                    className={`h-5 w-5 ${highlight ? "text-[#FF6A00]" : "text-[#64748B] group-hover:text-[#94A3B8]"} transition-colors`}
                    aria-hidden="true"
                  />
                </div>
                {badge && (
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider font-ibm-plex-mono ${
                      badge === "Stella"
                        ? "bg-[#FF6A00]/10 text-[#FF6A00] border border-[#FF6A00]/20"
                        : badge === "Output"
                        ? "bg-white/8 text-white/60 border border-white/12"
                        : "bg-[#1E293B] text-[#64748B] border border-[#334155]"
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </div>

              <div className="relative flex flex-col gap-2">
                <h3 className="text-base font-semibold text-white font-sora">{title}</h3>
                <p className="text-sm text-[#64748B] leading-relaxed font-manrope">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
