import React from "react"
import { Sparkles, FileCheck2, ChevronRight, ChevronDown } from "lucide-react"

const row1: Step[] = [
  { label: "Narrativa",    number: 1 },
  { label: "Stakeholders", number: 2 },
  { label: "Resultados",   number: 3 },
  { label: "Indicadores",  number: 4 },
  { label: "Evidencias",   number: 5 },
]

const row2: Step[] = [
  { label: "Proxies",       number: 6 },
  { label: "Filtros SROI",  number: 7 },
  { label: "Cálculo",       number: 8 },
  { label: "Stella Review", number: 9,  stella: true },
  { label: "Impact Deck",   number: 10, output: true },
]

const delayClasses: Record<number, string> = {
  1: "pipeline-delay-1",
  2: "pipeline-delay-2",
  3: "pipeline-delay-3",
  4: "pipeline-delay-4",
  5: "pipeline-delay-5",
  6: "pipeline-delay-6",
  7: "pipeline-delay-7",
  8: "pipeline-delay-8",
  9: "pipeline-delay-9",
  10: "pipeline-delay-10",
}

type Step = { label: string; number: number; stella?: boolean; output?: boolean }

function PipelineStep({ step, isLast }: { step: Step; isLast: boolean }) {
  const { label, number, stella, output } = step
  return (
    <div className="flex items-center gap-2">
      <div
        className={`group relative flex cursor-default items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-all duration-200 animate-fade-up motion-reduce:animate-none ${delayClasses[number]} ${
          output
            ? "border-teal-400/50 bg-teal-500 text-slate-950 shadow-lg shadow-teal-500/25"
            : stella
            ? "border-teal-500/35 bg-teal-500/10 text-teal-300 hover:border-teal-500/55 hover:bg-teal-500/15"
            : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600 hover:bg-slate-700/80 hover:text-white"
        }`}
      >
        {stella && (
          <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {output && (
          <FileCheck2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {!stella && !output && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-700/60 text-[10px] font-bold text-slate-400"
            aria-hidden="true"
          >
            {number}
          </span>
        )}
        {label}

        {/* Soft glow on stella/output */}
        {(stella || output) && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 rounded-lg ${
              output
                ? "bg-[radial-gradient(ellipse_80%_60%_at_50%_50%,rgba(255,255,255,0.08),transparent)]"
                : "bg-[radial-gradient(ellipse_80%_60%_at_50%_50%,rgba(45,212,191,0.08),transparent)]"
            }`}
          />
        )}
      </div>

      {!isLast && (
        <ChevronRight
          className="h-4 w-4 shrink-0 text-slate-600"
          aria-hidden="true"
        />
      )}
    </div>
  )
}

export function PipelineSection() {
  return (
    <section
      id="pipeline"
      aria-label="Flujo del pipeline de impacto"
      className="bg-slate-900 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            El pipeline
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Del dato al informe: un flujo trazable
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Cada paso del análisis queda registrado, conectado y disponible para revisión.
            Ningún supuesto queda oculto. Ninguna evidencia, desvinculada.
          </p>
        </div>

        {/* Mobile: vertical ordered list */}
        <ol aria-label="Pasos del pipeline" className="flex flex-col gap-3 sm:hidden">
          {[...row1, ...row2].map(({ label, number, stella, output }) => (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  output
                    ? "bg-teal-500 text-slate-950"
                    : stella
                    ? "border border-teal-500/30 bg-teal-500/20 text-teal-400"
                    : "bg-slate-800 text-slate-400"
                }`}
                aria-hidden="true"
              >
                {number}
              </span>
              <span
                className={`text-sm font-medium ${
                  output ? "text-teal-400" : stella ? "text-teal-300" : "text-slate-300"
                }`}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>

        {/* Desktop: two-row intelligence flow */}
        <div className="hidden sm:block">
          {/* Row 1 */}
          <div className="flex flex-wrap items-center justify-center gap-2" role="list" aria-label="Pasos 1 a 5 del pipeline">
            {row1.map((step, i) => (
              <div key={step.label} role="listitem">
                <PipelineStep step={step} isLast={i === row1.length - 1} />
              </div>
            ))}
          </div>

          {/* Vertical connector from row1 to row2 */}
          <div className="flex justify-center my-2" aria-hidden="true">
            <div className="flex flex-col items-center gap-0.5">
              <div className="h-4 w-px bg-slate-700" />
              <ChevronDown className="h-3.5 w-3.5 text-slate-600" />
            </div>
          </div>

          {/* Row 2 */}
          <div className="flex flex-wrap items-center justify-center gap-2" role="list" aria-label="Pasos 6 a 10 del pipeline">
            {row2.map((step, i) => (
              <div key={step.label} role="listitem">
                <PipelineStep step={step} isLast={i === row2.length - 1} />
              </div>
            ))}
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-slate-500 max-w-xl mx-auto leading-relaxed">
          Stella Review identifica riesgos metodológicos en el paso de Cálculo. No calcula el SROI
          ni reemplaza la revisión humana.
        </p>
      </div>
    </section>
  )
}
