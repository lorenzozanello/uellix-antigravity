import React from "react"
import { FileCheck2, Sparkles } from "lucide-react"

// MethodTraceMap — a traceability map, not a basic stepper. Grouped into four
// phases (fuente → evidencia → cálculo → reporte) so the ten steps read as a
// coherent methodology rather than a flat list. Static for this sprint;
// structure is animation-ready (nodes + hairline connectors).
type Node = { n: number; label: string; kind?: "stella" | "output" }

const phases: Array<{ phase: string; nodes: Node[] }> = [
  {
    phase: "Definición",
    nodes: [
      { n: 1, label: "Narrativa" },
      { n: 2, label: "Stakeholders" },
      { n: 3, label: "Resultados" },
      { n: 4, label: "Indicadores" },
    ],
  },
  {
    phase: "Evidencia",
    nodes: [
      { n: 5, label: "Evidencias" },
      { n: 6, label: "Proxies" },
      { n: 7, label: "Filtros SROI" },
    ],
  },
  {
    phase: "Cálculo y revisión",
    nodes: [
      { n: 8, label: "Cálculo" },
      { n: 9, label: "Stella Review", kind: "stella" },
    ],
  },
  {
    phase: "Reporte",
    nodes: [
      { n: 10, label: "Impact Deck", kind: "output" },
    ],
  },
]

function NodeCircle({ n, kind, size }: Omit<Node, "label"> & { size: "lg" | "sm" }) {
  const dims = size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm"
  return (
    <span
      className={`flex ${dims} shrink-0 items-center justify-center rounded-full border-2 font-sora font-bold transition-premium group-hover:-translate-y-0.5 ${
        kind === "output"
          ? "border-uellix-orange bg-uellix-orange text-white shadow-[0_8px_20px_-6px_rgba(252,76,13,0.65)]"
          : kind === "stella"
          ? "border-uellix-orange/40 bg-uellix-orange/10 text-[#B85200]"
          : "border-[#0F172A]/14 bg-white text-[#0F172A] shadow-sm"
      }`}
    >
      {kind === "output" ? (
        <FileCheck2 className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} aria-hidden="true" />
      ) : kind === "stella" ? (
        <Sparkles className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} aria-hidden="true" />
      ) : (
        <span className="tabular-nums">{n}</span>
      )}
    </span>
  )
}

export function PipelineSection() {
  return (
    <section
      id="metodologia"
      aria-label="Mapa de trazabilidad del método"
      className="bg-[var(--uellix-paper-deep)] px-4 py-28 sm:py-36"
    >
      <span id="flujo" aria-hidden="true" className="absolute -mt-20" />

      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-20">
          <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-6">
            <span className="h-px w-8 bg-uellix-orange/30" aria-hidden="true" />
            Método · Mapa de trazabilidad
          </span>
          <h2 className="font-sora text-[clamp(2.1rem,4.3vw,3.4rem)] font-bold leading-[1.05] tracking-[-0.015em] text-[#0F172A]">
            Un camino claro, rastreable y defendible.
          </h2>
          <p className="mt-6 text-base text-[#475569] max-w-xl leading-relaxed font-manrope">
            Cada paso queda registrado, conectado y disponible para revisión.
            Ningún supuesto queda oculto. Ninguna evidencia, desvinculada.
          </p>
        </div>

        {/* Desktop / tablet: horizontal trace map, grouped by phase */}
        <div className="hidden md:block" aria-label="Nodos del método">
          <div className="relative flex items-start">
            {/* baseline connector — draws in as the section scrolls into view */}
            <span
              aria-hidden="true"
              className="trace-line-draw absolute left-4 right-4 top-6 h-px bg-gradient-to-r from-[#CBD5E1] via-uellix-orange/40 to-uellix-orange"
            />
            {phases.map(({ phase, nodes }, gi) => (
              <div
                key={phase}
                className={`relative flex flex-1 flex-col items-center ${
                  gi !== 0 ? "border-l border-dashed border-[#0F172A]/12 pl-2" : ""
                }`}
              >
                <p className="mb-5 font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#5B6472]">
                  {phase}
                </p>
                <ol className="flex items-start justify-center gap-1 w-full">
                  {nodes.map((node) => (
                    <li key={node.n} className="relative z-10 flex flex-1 flex-col items-center gap-2.5 group">
                      <NodeCircle {...node} size="lg" />
                      <span
                        className={`font-ibm-plex-mono text-[10px] font-medium text-center leading-tight tracking-tight px-1 ${
                          node.kind ? "text-[#B85200]" : "text-[#5B6472]"
                        }`}
                      >
                        {node.label}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>

        {/* Mobile: vertical trace map with spine, grouped by phase */}
        <div className="md:hidden flex flex-col gap-8">
          {phases.map(({ phase, nodes }) => (
            <div key={phase}>
              <p className="mb-3 font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#5B6472]">
                {phase}
              </p>
              <ol className="relative flex flex-col gap-1 pl-2" aria-label={`Nodos de la fase ${phase}`}>
                <span
                  aria-hidden="true"
                  className="absolute left-[22px] top-4 bottom-4 w-px bg-gradient-to-b from-[#CBD5E1] via-uellix-orange/40 to-uellix-orange"
                />
                {nodes.map((node) => (
                  <li key={node.n} className="relative z-10 flex items-center gap-4 py-2">
                    <NodeCircle {...node} size="sm" />
                    <span
                      className={`font-manrope text-sm font-medium ${node.kind ? "text-[#B85200]" : "text-[#0F172A]"}`}
                    >
                      {node.label}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <p className="mt-16 max-w-xl text-sm text-[#5B6472] leading-relaxed font-manrope border-l-2 border-uellix-orange/30 pl-4">
          Stella Review identifica riesgos metodológicos en el paso de Cálculo.
          No calcula el SROI ni reemplaza la revisión humana.
        </p>
      </div>
    </section>
  )
}
