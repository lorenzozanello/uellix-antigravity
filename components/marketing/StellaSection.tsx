import React from "react"
import { MessageSquare, AlertTriangle, CheckCircle } from "lucide-react"

export function StellaSection() {
  return (
    <section
      id="stella"
      aria-label="Stella: revisión metodológica asistida"
      className="bg-slate-900 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            Stella
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Revisión metodológica asistida
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Stella no calcula el SROI. Stella revisa los riesgos metodológicos de tu análisis y te
            orienta en cada paso, siempre con revisión humana como paso final.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-10">
          {/* Stella Advisor */}
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-8 flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <MessageSquare className="h-5 w-5 text-teal-400" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-medium text-teal-400 uppercase tracking-wider">
                  Stella Advisor
                </p>
                <h3 className="text-lg font-semibold text-white">Orientación paso a paso</h3>
              </div>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">
              Stella Advisor te acompaña durante la construcción del análisis: te orienta al
              definir stakeholders, resultados, indicadores y proxies. Sus sugerencias son
              orientativas; tú decides qué incluir.
            </p>
            <ul className="flex flex-col gap-2" aria-label="Capacidades de Stella Advisor">
              {[
                "Orienta la definición de resultados y stakeholders",
                "Sugiere indicadores relevantes para el contexto",
                "Recomienda proxies sin sustituir tu criterio metodológico",
              ].map((item) => (
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
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-8 flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <AlertTriangle className="h-5 w-5 text-teal-400" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-medium text-teal-400 uppercase tracking-wider">
                  Stella Validator
                </p>
                <h3 className="text-lg font-semibold text-white">Revisión de riesgos en Cálculo</h3>
              </div>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">
              Stella Validator analiza el contexto del paso de Cálculo e identifica posibles riesgos
              metodológicos: brechas de evidencia, riesgos de proxy, riesgos de atribución y
              riesgos en los claims. No modifica el cálculo.
            </p>
            <ul className="flex flex-col gap-2" aria-label="Capacidades de Stella Validator">
              {[
                "Identifica brechas de evidencia y riesgos de proxy",
                "Señala riesgos de atribución y claims metodológicos",
                "Genera reporte de revisión con nivel de riesgo",
              ].map((item) => (
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
        </div>

        {/* Disclaimer */}
        <div
          role="note"
          aria-label="Aclaración sobre los límites de Stella"
          className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-6 py-5 flex flex-col sm:flex-row items-start gap-4"
        >
          <AlertTriangle
            className="h-5 w-5 shrink-0 text-amber-400 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold text-amber-300">
              Stella no certifica ni reemplaza la revisión humana
            </p>
            <p className="text-sm text-slate-400 leading-relaxed">
              Stella <strong className="text-slate-300">no calcula el SROI</strong>,{" "}
              <strong className="text-slate-300">no certifica impacto</strong>,{" "}
              <strong className="text-slate-300">no realiza auditorías automáticas</strong> y{" "}
              <strong className="text-slate-300">no garantiza resultados</strong>. Su función es
              orientar y señalar riesgos metodológicos. La revisión humana es siempre el paso final
              requerido antes de cualquier uso externo del análisis.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
