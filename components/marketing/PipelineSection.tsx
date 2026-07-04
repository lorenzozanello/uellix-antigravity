import React from "react"
import { FileCheck2, Sparkles } from "lucide-react"

// MethodTraceMap — a traceability map, not a basic stepper. Static for this
// sprint; structure is animation-ready (nodes + hairline connectors).
const nodes: Array<{ n: number; label: string; kind?: "stella" | "output" }> = [
  { n: 1,  label: "Narrativa" },
  { n: 2,  label: "Stakeholders" },
  { n: 3,  label: "Resultados" },
  { n: 4,  label: "Indicadores" },
  { n: 5,  label: "Evidencias" },
  { n: 6,  label: "Proxies" },
  { n: 7,  label: "Filtros SROI" },
  { n: 8,  label: "Cálculo" },
  { n: 9,  label: "Stella Review", kind: "stella" },
  { n: 10, label: "Impact Deck", kind: "output" },
]

export function PipelineSection() {
  return (
    <section
      id="metodologia"
      aria-label="Mapa de trazabilidad del método"
      className="bg-[var(--uellix-paper-deep)] px-4 py-24 sm:py-32"
    >
      <span id="flujo" aria-hidden="true" className="absolute -mt-20" />

      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-16">
          <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-6">
            <span className="h-px w-8 bg-[#FF6A00]/50" aria-hidden="true" />
            Método · Mapa de trazabilidad
          </span>
          <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-semibold leading-[1.05] tracking-[-0.015em] text-[#0F172A]">
            Un camino claro, rastreable y defendible.
          </h2>
          <p className="mt-6 text-base text-[#475569] max-w-xl leading-relaxed font-manrope">
            Cada paso queda registrado, conectado y disponible para revisión.
            Ningún supuesto queda oculto. Ninguna evidencia, desvinculada.
          </p>
        </div>

        {/* Desktop / tablet: horizontal trace map */}
        <div className="hidden md:block" aria-label="Nodos del método">
          <ol className="relative flex items-start justify-between gap-1">
            {/* baseline connector — draws in as the section scrolls into view */}
            <span
              aria-hidden="true"
              className="trace-line-draw absolute left-4 right-4 top-5 h-px bg-gradient-to-r from-[#CBD5E1] via-[#FF6A00]/40 to-[#FF6A00]"
            />
            {nodes.map(({ n, label, kind }) => (
              <li key={n} className="relative z-10 flex flex-1 flex-col items-center gap-2.5 group">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 font-sora text-sm font-semibold transition-premium group-hover:-translate-y-0.5 ${
                    kind === "output"
                      ? "border-[#FF6A00] bg-[#FF6A00] text-white shadow-[0_6px_16px_-6px_rgba(255,106,0,0.6)]"
                      : kind === "stella"
                      ? "border-[#FF6A00]/40 bg-[#FF6A00]/10 text-[#B85200]"
                      : "border-[#0F172A]/12 bg-white text-[#0F172A] shadow-sm"
                  }`}
                >
                  {kind === "output" ? (
                    <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                  ) : kind === "stella" ? (
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <span className="tabular-nums">{n}</span>
                  )}
                </span>
                <span
                  className={`font-ibm-plex-mono text-[10px] font-medium text-center leading-tight tracking-tight px-1 ${
                    kind ? "text-[#B85200]" : "text-[#5B6472]"
                  }`}
                >
                  {label}
                </span>
              </li>
            ))}
          </ol>
        </div>

        {/* Mobile: vertical trace map with spine */}
        <ol className="md:hidden relative flex flex-col gap-1 pl-2" aria-label="Nodos del método">
          <span
            aria-hidden="true"
            className="absolute left-[22px] top-4 bottom-4 w-px bg-gradient-to-b from-[#CBD5E1] via-[#FF6A00]/40 to-[#FF6A00]"
          />
          {nodes.map(({ n, label, kind }) => (
            <li key={n} className="relative z-10 flex items-center gap-4 py-2">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 font-sora text-sm font-semibold ${
                  kind === "output"
                    ? "border-[#FF6A00] bg-[#FF6A00] text-white"
                    : kind === "stella"
                    ? "border-[#FF6A00]/40 bg-[#FF6A00]/10 text-[#B85200]"
                    : "border-[#0F172A]/12 bg-white text-[#0F172A] shadow-sm"
                }`}
                aria-hidden="true"
              >
                {kind === "output" ? (
                  <FileCheck2 className="h-4 w-4" />
                ) : kind === "stella" ? (
                  <Sparkles className="h-4 w-4" />
                ) : (
                  <span className="tabular-nums">{n}</span>
                )}
              </span>
              <span
                className={`font-manrope text-sm font-medium ${kind ? "text-[#B85200]" : "text-[#0F172A]"}`}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-14 max-w-xl text-sm text-[#5B6472] leading-relaxed font-manrope border-l-2 border-[#FF6A00]/30 pl-4">
          Stella Review identifica riesgos metodológicos en el paso de Cálculo.
          No calcula el SROI ni reemplaza la revisión humana.
        </p>
      </div>
    </section>
  )
}
