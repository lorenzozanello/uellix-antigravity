import React from "react"
import { MessageSquare, ShieldAlert, AlertTriangle, CheckCircle, Sparkles } from "lucide-react"

const advisorCapabilities = [
  "Orienta la definición de resultados y stakeholders",
  "Sugiere indicadores relevantes para el contexto",
  "Recomienda proxies sin sustituir tu criterio metodológico",
]

const validatorCapabilities = [
  "Identifica brechas de evidencia y riesgos de proxy",
  "Señala riesgos de atribución y claims metodológicos",
  "Genera reporte de revisión con nivel de riesgo metodológico",
]

const riskFlags = [
  { label: "Riesgo de evidencia", severity: "medio",  dot: "bg-amber-400" },
  { label: "Riesgo de proxy",     severity: "bajo",   dot: "bg-emerald-400" },
  { label: "Riesgo de atribución",severity: "medio",  dot: "bg-amber-400" },
]

export function StellaSection() {
  return (
    <section
      id="stella"
      aria-label="Stella: revisión metodológica asistida"
      className="bg-slate-900 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            Stella
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Un consejero metodológico antes de presentar al mundo
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Stella no reemplaza tu juicio. Te prepara para defenderlo.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-8">
          {/* Stella Advisor */}
          <div className="group relative rounded-xl border border-slate-800 bg-slate-950 p-8 flex flex-col gap-5 card-lift overflow-hidden">
            {/* Ambient glow */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-xl bg-[radial-gradient(ellipse_70%_50%_at_0%_0%,rgba(20,184,166,0.06),transparent)]"
            />

            <div className="relative flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-teal-500/25 bg-teal-500/10 transition-colors group-hover:bg-teal-500/15">
                <MessageSquare className="h-5 w-5 text-teal-400" aria-hidden="true" />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-400/70">
                  Stella Advisor
                </p>
                <h3 className="text-lg font-semibold text-white">Orientación paso a paso</h3>
              </div>
            </div>

            <p className="relative text-sm text-slate-400 leading-relaxed">
              Stella Advisor te acompaña durante la construcción del análisis: te orienta al
              definir stakeholders, resultados, indicadores y proxies. Sus sugerencias son
              orientativas; tú decides qué incluir.
            </p>

            <ul className="relative flex flex-col gap-2.5" aria-label="Capacidades de Stella Advisor">
              {advisorCapabilities.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-slate-300">
                  <CheckCircle
                    className="h-4 w-4 shrink-0 text-teal-400 mt-0.5"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Stella Validator */}
          <div className="group relative rounded-xl border border-slate-800 bg-slate-950 p-8 flex flex-col gap-5 card-lift overflow-hidden">
            {/* Ambient glow */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-xl bg-[radial-gradient(ellipse_70%_50%_at_100%_0%,rgba(20,184,166,0.06),transparent)]"
            />

            <div className="relative flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-teal-500/25 bg-teal-500/10 transition-colors group-hover:bg-teal-500/15">
                <ShieldAlert className="h-5 w-5 text-teal-400" aria-hidden="true" />
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-400/70">
                  Stella Validator
                </p>
                <h3 className="text-lg font-semibold text-white">Revisión de riesgos en Cálculo</h3>
              </div>
            </div>

            <p className="relative text-sm text-slate-400 leading-relaxed">
              Stella Validator analiza el contexto del paso de Cálculo e identifica posibles riesgos
              metodológicos: brechas de evidencia, riesgos de proxy, riesgos de atribución y
              riesgos en los claims. No modifica el cálculo.
            </p>

            <ul className="relative flex flex-col gap-2.5" aria-label="Capacidades de Stella Validator">
              {validatorCapabilities.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-slate-300">
                  <CheckCircle
                    className="h-4 w-4 shrink-0 text-teal-400 mt-0.5"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>

            {/* Risk flags — illustrative example panel */}
            <div className="relative mt-1 rounded-lg border border-slate-800 bg-slate-900/50 p-4 flex flex-col gap-2">
              <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-slate-600 mb-1">
                Ejemplo de reporte de revisión
              </p>
              {riskFlags.map(({ label, severity, dot }) => (
                <div key={label} className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 text-slate-400">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                    {label}
                  </div>
                  <span className="font-medium text-slate-500 capitalize">{severity}</span>
                </div>
              ))}
              <p className="text-[10px] text-slate-600 mt-1 italic">Ejemplo ilustrativo — no datos reales</p>
            </div>
          </div>
        </div>

        {/* Disclaimer — prominent, above fold */}
        <div
          role="note"
          aria-label="Aclaración sobre los límites de Stella"
          className="rounded-xl border border-amber-500/25 bg-amber-500/6 px-6 py-5 flex flex-col sm:flex-row items-start gap-4"
        >
          <AlertTriangle
            className="h-5 w-5 shrink-0 text-amber-400 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold text-amber-300">
              Sobre los límites de Stella
            </p>
            <p className="text-sm text-slate-400 leading-relaxed">
              Stella{" "}
              <strong className="text-slate-300">no calcula el SROI</strong>,{" "}
              <strong className="text-slate-300">no certifica impacto</strong>,{" "}
              <strong className="text-slate-300">no realiza auditorías automáticas</strong> y{" "}
              <strong className="text-slate-300">no garantiza resultados</strong>. Su función es
              orientar y señalar riesgos metodológicos. La revisión humana es siempre el paso
              final requerido antes de cualquier uso externo del análisis.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
