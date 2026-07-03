import React from "react"
import { FileCheck2 } from "lucide-react"

const flowSteps = [
  { label: "Definir alcance", number: 1 },
  { label: "Mapear cambio",   number: 2 },
  { label: "Evidenciar",      number: 3 },
  { label: "Valorar",         number: 4 },
  { label: "Revisar",         number: 5 },
  { label: "Reportar",        number: 6, output: true },
]

const fullSteps: Array<{ label: string; number: number; stella?: boolean; output?: boolean }> = [
  { label: "Narrativa",      number: 1 },
  { label: "Stakeholders",   number: 2 },
  { label: "Resultados",     number: 3 },
  { label: "Indicadores",    number: 4 },
  { label: "Evidencias",     number: 5 },
  { label: "Proxies",        number: 6 },
  { label: "Filtros SROI",   number: 7 },
  { label: "Cálculo",        number: 8 },
  { label: "Stella Validator", number: 9,  stella: true },
  { label: "Impact Deck",    number: 10, output: true },
]

export function PipelineSection() {
  return (
    <section
      id="metodologia"
      aria-label="Flujo de trazabilidad de impacto"
      className="bg-[#FBFAFC] px-4 py-20 sm:py-28 border-b border-[#E2E8F0]"
    >
      {/* Hidden sub-anchor for #flujo */}
      <span id="flujo" aria-hidden="true" className="absolute -mt-20" />

      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-16">
          <span className="inline-flex items-center rounded-full bg-[#0F172A]/5 border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#64748B] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            Metodología
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-[#0F172A]">
            Un camino claro, rastreable y defendible.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto leading-relaxed font-manrope">
            Cada paso del análisis queda registrado, conectado y disponible para revisión.
            Ningún supuesto queda oculto. Ninguna evidencia, desvinculada.
          </p>
        </div>

        {/* Desktop: horizontal flow */}
        <div className="hidden sm:block mb-12" aria-label="Flujo de pasos del pipeline">
          <div className="flex items-start justify-center gap-0">
            {flowSteps.map((step, i) => (
              <div key={step.label} className="flex items-start">
                <div className="flex flex-col items-center gap-2 px-2 w-[110px]">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 font-sora text-sm font-bold transition-colors ${
                      step.output
                        ? "border-[#FF6A00] bg-[#FF6A00] text-white"
                        : "border-[#E2E8F0] bg-white text-[#0F172A] shadow-sm"
                    }`}
                  >
                    {step.output
                      ? <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                      : step.number
                    }
                  </div>
                  <p className={`text-xs font-medium text-center leading-snug font-manrope ${
                    step.output ? "text-[#FF6A00]" : "text-[#64748B]"
                  }`}>
                    {step.label}
                  </p>
                </div>

                {/* Connector line */}
                {i < flowSteps.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="mt-5 h-px flex-1 min-w-[16px] bg-gradient-to-r from-[#E2E8F0] via-[#FF6A00]/30 to-[#E2E8F0]"
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Full 10-step pipeline detail — desktop */}
        <div className="hidden sm:block">
          <div className="mx-auto max-w-4xl">
            <p className="font-ibm-plex-mono text-[10px] font-bold tracking-[0.16em] text-[#94A3B8] uppercase text-center mb-5">
              Pipeline completo
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2" role="list" aria-label="Pasos del pipeline de análisis">
              {fullSteps.map(({ label, number, stella, output }) => (
                <div
                  key={label}
                  role="listitem"
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium font-manrope transition-colors ${
                    output
                      ? "border-[#FF6A00]/40 bg-[#FF6A00] text-white"
                      : stella
                      ? "border-[#FF6A00]/25 bg-[#FF6A00]/8 text-[#FF6A00]"
                      : "border-[#E2E8F0] bg-white text-[#0F172A] shadow-sm"
                  }`}
                >
                  {!stella && !output && (
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#F1F5F9] text-[9px] font-bold text-[#64748B] font-ibm-plex-mono"
                      aria-hidden="true"
                    >
                      {number}
                    </span>
                  )}
                  {stella && (
                    <span className="font-ibm-plex-mono text-[9px] font-bold tracking-wide text-[#FF6A00]" aria-hidden="true">S</span>
                  )}
                  {output && (
                    <FileCheck2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Mobile: vertical ordered list */}
        <ol aria-label="Pasos del pipeline" className="flex flex-col gap-3 sm:hidden">
          {fullSteps.map(({ label, number, stella, output }) => (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold font-ibm-plex-mono ${
                  output
                    ? "bg-[#FF6A00] text-white"
                    : stella
                    ? "border border-[#FF6A00]/30 bg-[#FF6A00]/10 text-[#FF6A00]"
                    : "bg-white border border-[#E2E8F0] text-[#0F172A] shadow-sm"
                }`}
                aria-hidden="true"
              >
                {number}
              </span>
              <span
                className={`text-sm font-medium font-manrope ${
                  output ? "text-[#FF6A00]" : stella ? "text-[#FF6A00]" : "text-[#0F172A]"
                }`}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-10 text-center text-xs text-[#94A3B8] max-w-xl mx-auto leading-relaxed font-manrope">
          Stella Validator identifica riesgos metodológicos en el paso de Cálculo.
          No calcula el SROI ni reemplaza la revisión humana.
        </p>
      </div>
    </section>
  )
}
