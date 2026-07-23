import React from "react"
import { MessageSquare, ShieldAlert, AlertTriangle } from "lucide-react"

const capabilities = [
  { role: "Advisor",   text: "Orienta la definición de resultados, stakeholders, indicadores y proxies. Sugiere; tú decides qué incluir." },
  { role: "Validator", text: "Detecta riesgos metodológicos en el paso de Cálculo: evidencia, proxy, atribución y claims. No modifica el cálculo." },
]

const reviewRows = [
  {
    label: "Riesgo de evidencia",
    level: "Medio",
    value: 2,
    dot: "bg-amber-400",
    tone: "text-amber-200",
    badge: "border-amber-400/35 bg-amber-400/12",
    meter: "bg-amber-400",
  },
  {
    label: "Riesgo de proxy",
    level: "Bajo",
    value: 1,
    dot: "bg-emerald-400",
    tone: "text-emerald-200",
    badge: "border-emerald-400/35 bg-emerald-400/12",
    meter: "bg-emerald-400",
  },
  {
    label: "Riesgo de atribución",
    level: "Medio",
    value: 2,
    dot: "bg-amber-400",
    tone: "text-amber-200",
    badge: "border-amber-400/35 bg-amber-400/12",
    meter: "bg-amber-400",
  },
]

export function StellaSection() {
  return (
    <section
      id="stella"
      aria-label="Stella: criterio metodológico aumentado"
      className="section-seam relative overflow-hidden bg-[var(--uellix-carbon)] px-4 py-24 sm:py-32"
    >
      <div className="texture-grain-c" aria-hidden="true" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_60%_at_15%_20%,rgba(252,76,13,0.06),transparent_60%)]"
      />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-2 lg:items-center">

          {/* Left — narrative */}
          <div>
            <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-uellix-orange mb-6">
              <span className="h-px w-8 bg-uellix-orange/30" aria-hidden="true" />
              Stella
            </span>
            <h2 className="font-sora text-[clamp(2rem,4.2vw,3.4rem)] font-bold leading-[1.04] tracking-[-0.015em] text-white">
              Criterio aumentado.{" "}
              <span className="text-uellix-orange">Nunca delegado.</span>
            </h2>
            <p className="mt-6 text-base text-[#94A3B8] max-w-md leading-relaxed font-manrope">
              Stella apoya con orientación metodológica y revisión de riesgos.
              Sugiere, orienta y detecta — pero no reemplaza la revisión humana.
            </p>

            <div className="mt-8 flex flex-col gap-4">
              {capabilities.map(({ role, text }) => (
                <div key={role} className="flex gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-white/[0.04]">
                    {role === "Advisor" ? (
                      <MessageSquare className="h-4 w-4 text-uellix-orange" aria-hidden="true" />
                    ) : (
                      <ShieldAlert className="h-4 w-4 text-uellix-orange" aria-hidden="true" />
                    )}
                  </span>
                  <div>
                    <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#64748B] mb-1">
                      Stella {role}
                    </p>
                    <p className="text-sm text-[#CBD5E1] leading-relaxed font-manrope max-w-sm">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right — review sheet (glass) */}
          <div className="relative">
            <div className="rounded-2xl border border-white/12 bg-white/[0.05] backdrop-blur-md p-6 shadow-[0_30px_70px_-30px_rgba(0,0,0,0.7)]">
              <div className="h-[3px] w-full rounded-full bg-gradient-to-r from-uellix-orange via-[#C2703F] to-transparent mb-5" />

              <div className="flex items-center justify-between gap-3 mb-5">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-uellix-orange" aria-hidden="true" />
                  <span className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/80">
                    Hoja de revisión · Stella
                  </span>
                </div>
                <span className="font-ibm-plex-mono text-[9px] text-white/40 uppercase tracking-wide">Muestra conceptual</span>
              </div>

              <div className="flex flex-col divide-y divide-white/8">
                {reviewRows.map(({ label, level, value, dot, tone, badge, meter }) => (
                  <div key={label} className="flex items-center justify-between gap-4 py-3.5">
                    <span className="flex items-center gap-2.5 text-sm text-[#CBD5E1] font-manrope">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                      {label}
                    </span>
                    <span className="flex items-center gap-3">
                      {/* risk meter — 3 ticks, filled by severity */}
                      <span className="flex items-center gap-1" aria-hidden="true">
                        {[1, 2, 3].map((tick) => (
                          <span
                            key={tick}
                            className={`h-3.5 w-1 rounded-full ${tick <= value ? meter : "bg-white/10"}`}
                          />
                        ))}
                      </span>
                      <span
                        className={`rounded-full border px-2.5 py-1 font-ibm-plex-mono text-[10px] font-bold uppercase tracking-wide ${badge} ${tone}`}
                      >
                        {level}
                      </span>
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <p className="font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.16em] text-uellix-orange mb-1.5">
                  Recomendación metodológica
                </p>
                <p className="text-sm text-[#CBD5E1] leading-relaxed font-manrope">
                  Ampliar la base de evidencia del outcome principal y documentar el
                  supuesto de atribución antes de la validación final.
                </p>
              </div>

              <div className="mt-4 flex items-center gap-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-5 py-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-400/40 bg-amber-400/15">
                  <AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-amber-200/80 mb-0.5">
                    Estado
                  </p>
                  <p className="text-base font-semibold text-amber-100 font-sora leading-tight">
                    Requiere revisión humana
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Guardrail */}
        <div
          role="note"
          aria-label="Aclaración sobre los límites de Stella"
          className="mt-12 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-5 flex flex-col sm:flex-row items-start gap-4"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-uellix-orange mt-0.5" aria-hidden="true" />
          <p className="text-sm text-[#94A3B8] leading-relaxed font-manrope">
            Stella{" "}
            <strong className="text-white font-semibold">sugiere, orienta y detecta riesgos metodológicos</strong>.
            No calcula el SROI, no certifica el impacto, no realiza auditorías
            automáticas y{" "}
            <strong className="text-white font-semibold">no reemplaza la revisión humana</strong>.
            La validación final permanece siempre en manos del equipo experto.
          </p>
        </div>
      </div>
    </section>
  )
}
