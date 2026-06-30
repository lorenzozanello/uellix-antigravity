import React from "react"
import { MessageSquare, ShieldAlert, AlertTriangle, CheckCircle } from "lucide-react"

const advisorCapabilities = [
  "Acompaña buenas prácticas metodológicas y guías SROI",
  "Sugiere indicadores y proxies relevantes para el contexto",
  "Orienta la definición de resultados y stakeholders",
]

const validatorCapabilities = [
  "Detecta riesgos metodológicos y brechas de evidencia",
  "Señala riesgos de atribución y claims metodológicos",
  "Genera reporte de revisión con nivel de riesgo metodológico",
]

const riskFlags = [
  { label: "Riesgo de evidencia",   severity: "Medio", dot: "bg-amber-400" },
  { label: "Riesgo de proxy",       severity: "Bajo",  dot: "bg-emerald-400" },
  { label: "Riesgo de atribución",  severity: "Medio", dot: "bg-amber-400" },
]

export function StellaSection() {
  return (
    <section
      id="stella"
      aria-label="Stella: asesoría y revisión metodológica"
      className="bg-[#FBFAFC] px-4 py-20 sm:py-28 border-b border-[#E2E8F0]"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A]/5 border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#64748B] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            Stella
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-[#0F172A]">
            Asesoría y revisión metodológica,
            <br className="hidden sm:block" /> no magia.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto leading-relaxed font-manrope">
            Stella apoya con orientación metodológica y revisión de riesgos,
            pero no reemplaza la revisión humana.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-8">

          {/* Stella Advisor */}
          <div className="group relative rounded-xl border border-[#E2E8F0] bg-white p-8 flex flex-col gap-5 card-lift overflow-hidden">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] transition-colors group-hover:border-[#FF6A00]/25 group-hover:bg-[#FF6A00]/5">
                <MessageSquare className="h-5 w-5 text-[#0F172A]" aria-hidden="true" />
              </div>
              <div>
                <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#64748B]">
                  Stella Advisor
                </p>
                <h3 className="font-sora text-lg font-semibold text-[#0F172A]">
                  Orientación paso a paso
                </h3>
              </div>
            </div>

            <p className="text-sm text-[#64748B] leading-relaxed font-manrope">
              Stella Advisor te acompaña durante la construcción del análisis: te orienta al
              definir stakeholders, resultados, indicadores y proxies. Sus sugerencias son
              orientativas; tú decides qué incluir.
            </p>

            <ul className="flex flex-col gap-2.5" aria-label="Capacidades de Stella Advisor">
              {advisorCapabilities.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-[#0F172A] font-manrope">
                  <CheckCircle
                    className="h-4 w-4 shrink-0 text-[#FF6A00] mt-0.5"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Stella Validator */}
          <div className="group relative rounded-xl border border-[#E2E8F0] bg-white p-8 flex flex-col gap-5 card-lift overflow-hidden">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] transition-colors group-hover:border-[#FF6A00]/25 group-hover:bg-[#FF6A00]/5">
                <ShieldAlert className="h-5 w-5 text-[#0F172A]" aria-hidden="true" />
              </div>
              <div>
                <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#64748B]">
                  Stella Validator
                </p>
                <h3 className="font-sora text-lg font-semibold text-[#0F172A]">
                  Revisión de riesgos en Cálculo
                </h3>
              </div>
            </div>

            <p className="text-sm text-[#64748B] leading-relaxed font-manrope">
              Stella Validator analiza el contexto del paso de Cálculo e identifica posibles
              riesgos metodológicos: brechas de evidencia, riesgos de proxy, riesgos de
              atribución y riesgos en los claims. No modifica el cálculo.
            </p>

            <ul className="flex flex-col gap-2.5" aria-label="Capacidades de Stella Validator">
              {validatorCapabilities.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-[#0F172A] font-manrope">
                  <CheckCircle
                    className="h-4 w-4 shrink-0 text-[#FF6A00] mt-0.5"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>

            {/* Risk flags — illustrative */}
            <div className="mt-1 rounded-lg border border-[#E2E8F0] bg-[#FBFAFC] p-4 flex flex-col gap-2">
              <p className="font-ibm-plex-mono text-[9px] font-bold uppercase tracking-widest text-[#94A3B8] mb-1">
                Ejemplo de reporte de revisión
              </p>
              {riskFlags.map(({ label, severity, dot }) => (
                <div key={label} className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 text-[#64748B] font-manrope">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                    {label}
                  </div>
                  <span className="font-medium text-[#94A3B8] font-ibm-plex-mono capitalize">{severity}</span>
                </div>
              ))}
              <p className="font-ibm-plex-mono text-[9px] text-[#CBD5E1] mt-1 italic">
                Ejemplo ilustrativo — no datos reales
              </p>
            </div>
          </div>
        </div>

        {/* Disclaimer — guardrail prominente */}
        <div
          role="note"
          aria-label="Aclaración sobre los límites de Stella"
          className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-5 flex flex-col sm:flex-row items-start gap-4"
        >
          <AlertTriangle
            className="h-5 w-5 shrink-0 text-amber-500 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold text-amber-800 font-sora">
              Sobre los límites de Stella
            </p>
            <p className="text-sm text-amber-700 leading-relaxed font-manrope">
              Stella{" "}
              <strong className="text-amber-900">no calcula el SROI</strong>,{" "}
              <strong className="text-amber-900">no certifica el impacto</strong>,{" "}
              <strong className="text-amber-900">no realiza auditorías automáticas</strong>.
              Su función es orientar y señalar riesgos metodológicos. La revisión humana
              es siempre el paso final requerido antes de cualquier uso externo del análisis.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
