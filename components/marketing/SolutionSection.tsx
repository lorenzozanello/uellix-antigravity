import React from "react"
import { Workflow, ShieldCheck, Database, Sparkles, ShieldAlert, FileCheck2 } from "lucide-react"

const layers = [
  {
    id: "sroi-pipeline",
    icon: Workflow,
    layer: "Core",
    title: "SROI Pipeline",
    description:
      "De la narrativa al cálculo en un único flujo trazable: narrativa, stakeholders, resultados, indicadores, evidencias, proxies y cálculo, todo conectado y registrado.",
    accent: true,
  },
  {
    id: "trust-center",
    icon: ShieldCheck,
    layer: "Confianza",
    title: "Centro de confianza",
    description:
      "Huellas de integridad, fuentes verificables y supuestos explícitos consolidados en un rastro auditable para revisión externa.",
    accent: false,
  },
  {
    id: "proxy-intelligence",
    icon: Database,
    layer: "Inteligencia",
    title: "Proxy Intelligence",
    description:
      "Proxies financieros de fuentes reconocidas. Cada supuesto queda registrado con su justificación y fuente verificable.",
    accent: false,
  },
  {
    id: "stella",
    icon: Sparkles,
    layer: "Stella",
    title: "Advisor + Validator",
    description:
      "Orientación metodológica paso a paso y detección de riesgos en el cálculo. Sugiere y señala; la revisión humana es siempre tuya.",
    accent: false,
    secondaryIcon: ShieldAlert,
  },
  {
    id: "impact-deck",
    icon: FileCheck2,
    layer: "Output",
    title: "Impact Deck",
    description:
      "Reportes audit-ready revisables por terceros, con supuestos explícitos, fuentes citadas y el rastro completo de decisiones metodológicas exportable.",
    accent: true,
  },
]

export function SolutionSection() {
  return (
    <section
      id="producto"
      aria-label="Módulos de la plataforma Uellix"
      className="section-seam relative overflow-hidden bg-[var(--uellix-carbon)] px-4 py-24 sm:py-32"
    >
      <div className="texture-grain-b" aria-hidden="true" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_50%_at_85%_0%,rgba(255,106,0,0.05),transparent_60%)]"
      />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-12 lg:items-start">

          {/* Heading — left, asymmetric */}
          <div className="lg:col-span-4">
            <div className="lg:sticky lg:top-28">
              <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#FF6A00] mb-6">
                <span className="h-px w-8 bg-[#FF6A00]/50" aria-hidden="true" />
                La plataforma
              </span>
              <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-semibold leading-[1.05] tracking-[-0.015em] text-white">
                Un sistema operativo metodológico para evidencia de impacto.
              </h2>
              <p className="mt-6 text-base text-[#94A3B8] max-w-sm leading-relaxed font-manrope">
                No un certificador. Una arquitectura que conecta narrativa,
                evidencia, proxies y cálculo en un rastro coherente, trazable y
                audit-ready.
              </p>
            </div>
          </div>

          {/* Architecture layers — connected strata, not a card grid */}
          <div className="lg:col-span-8">
            <ol className="relative flex flex-col">
              {/* vertical spine */}
              <span
                aria-hidden="true"
                className="absolute left-[19px] top-4 bottom-4 w-px bg-gradient-to-b from-[#FF6A00]/40 via-white/10 to-[#FF6A00]/40"
              />
              {layers.map(({ id, icon: Icon, secondaryIcon: Secondary, layer, title, description, accent }) => (
                <li key={id} className="relative grid grid-cols-[40px_1fr] gap-5 py-4 group">
                  {/* node */}
                  <span
                    className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border backdrop-blur-sm transition-premium ${
                      accent
                        ? "border-[#FF6A00]/35 bg-[#FF6A00]/12 group-hover:bg-[#FF6A00]/20"
                        : "border-white/12 bg-white/[0.04] group-hover:border-white/25"
                    }`}
                  >
                    <Icon
                      className={`h-[18px] w-[18px] ${accent ? "text-[#FF6A00]" : "text-[#94A3B8] group-hover:text-white"} transition-premium`}
                      aria-hidden="true"
                    />
                  </span>
                  <div className="rounded-xl border border-white/8 bg-white/[0.03] px-5 py-4 transition-premium hover:border-white/16 hover:bg-white/[0.05]">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className={`font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.18em] ${
                          accent ? "text-[#FF6A00]" : "text-[#64748B]"
                        }`}
                      >
                        {layer}
                      </span>
                      {Secondary && (
                        <Secondary className="h-3 w-3 text-[#FF6A00]/70" aria-hidden="true" />
                      )}
                    </div>
                    <h3 className="font-sora text-lg font-semibold text-white mb-1.5">{title}</h3>
                    <p className="text-sm text-[#94A3B8] leading-relaxed font-manrope">{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
