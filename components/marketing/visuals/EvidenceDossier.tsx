import React from "react"
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react"

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceDossier — conceptual sample of an impact-evidence file ("expediente").
// Decorative (aria-hidden). No real client, project, or metric — this is a
// conceptual sample, explicitly labelled "Muestra conceptual".
// ─────────────────────────────────────────────────────────────────────────────

const evidencias = [
  { indicador: "Tasa de empleabilidad",     fuente: "Fuente pública",   estado: "verified" as const },
  { indicador: "Salario referencia sector", fuente: "Fuente oficial",   estado: "verified" as const },
  { indicador: "Horas de capacitación",     fuente: "Registro interno", estado: "review"   as const },
]

const stats = [
  { label: "Evidencias vinculadas", value: "12" },
  { label: "Proxies registrados",   value: "8" },
  { label: "Supuestos explícitos",  value: "14" },
]

const riskLines = [
  { label: "Riesgo de evidencia",  level: "Medio", dot: "bg-amber-400" },
  { label: "Riesgo de proxy",      level: "Bajo",  dot: "bg-emerald-400" },
  { label: "Riesgo de atribución", level: "Medio", dot: "bg-amber-400" },
]

/** Left-edge "case file spine" — a continuous trace line linking every block
 *  of the dossier, with small connector nodes at each section boundary. Makes
 *  the fuente → evidencia → proxy → cálculo traceability visually explicit
 *  instead of merely implied by stacking. */
function TraceSpine() {
  return (
    <div
      aria-hidden="true"
      className="absolute left-0 top-0 bottom-0 w-5 flex flex-col items-center"
    >
      <span className="mt-[26px] h-1.5 w-1.5 rounded-full bg-uellix-orange shrink-0 ring-2 ring-white" />
      <span className="flex-1 w-px bg-gradient-to-b from-uellix-orange/50 via-[#0F172A]/12 to-[#0F172A]/12 transition-colors duration-[280ms] group-hover:via-uellix-orange/30 group-hover:to-uellix-orange/25" />
      <span className="h-1.5 w-1.5 rounded-full bg-[#0F172A]/25 shrink-0 ring-2 ring-white transition-colors duration-[240ms] delay-[70ms] group-hover:bg-uellix-orange/70 motion-reduce:transition-none motion-reduce:delay-0" />
      <span className="flex-1 w-px bg-[#0F172A]/12 transition-colors duration-[280ms] group-hover:bg-uellix-orange/25" />
      <span className="h-1.5 w-1.5 rounded-full bg-[#0F172A]/25 shrink-0 ring-2 ring-white transition-colors duration-[240ms] delay-[140ms] group-hover:bg-uellix-orange/70 motion-reduce:transition-none motion-reduce:delay-0" />
      <span className="flex-1 w-px bg-[#0F172A]/12 transition-colors duration-[280ms] group-hover:bg-uellix-orange/25" />
      <span className="mb-[18px] h-1.5 w-1.5 rounded-full bg-uellix-orange shrink-0 ring-2 ring-white" />
    </div>
  )
}

/** Small shared header used by both the full and compact variants. */
function DossierHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-ibm-plex-mono text-[9px] font-bold tracking-[0.2em] text-uellix-orange uppercase">
            Dossier de evidencia
          </span>
          <span className="text-[#CBD5E1] text-[9px]">/</span>
          <span className="font-ibm-plex-mono text-[9px] tracking-[0.12em] text-[#5B6472] uppercase">
            Muestra
          </span>
        </div>
        <h3 className="font-sora text-base font-semibold text-[#0F172A] leading-snug">
          Proyecto de impacto social
        </h3>
        <p className="text-[11px] text-[#5B6472] mt-0.5 font-manrope">
          Inclusión laboral · período de medición
        </p>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 shrink-0 whitespace-nowrap">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 animate-pulse-glow motion-reduce:animate-none" />
        <span className="hidden sm:inline">Lista para revisión humana</span>
        <span className="sm:hidden">Lista para revisión</span>
      </span>
    </div>
  )
}

/** Stella Risk Review mini-panel — full detail on sm+, collapsed to a single
 *  summary badge on mobile to keep the compact variant scannable. */
function StellaRiskMini() {
  return (
    <div className="rounded-lg border border-[#0F172A]/8 bg-[#FBFAFC]/80 backdrop-blur-sm p-3.5">
      <div className="flex items-center justify-between gap-3 mb-2.5 sm:mb-2.5">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5 text-uellix-orange" />
          <span className="font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#475569]">
            Stella Risk Review
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded border border-amber-300/70 bg-amber-50 px-2 py-0.5 font-ibm-plex-mono text-[9px] font-semibold uppercase tracking-wide text-amber-700">
          Riesgo general · Medio
        </span>
      </div>
      {/* Full detail — hidden on the compact mobile variant */}
      <div className="hidden sm:flex flex-col gap-1.5">
        {riskLines.map(({ label, level, dot }) => (
          <div key={label} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="flex items-center gap-2 text-[#5B6472] font-manrope">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              {label}
            </span>
            <span className="font-ibm-plex-mono text-[10px] font-medium text-[#5B6472] uppercase tracking-wide">
              {level}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// The four traceability stages surfaced in the footer chain. On hover of the
// dossier they light up left-to-right (pure CSS, staggered transition-delay),
// making the fuente → evidencia → proxy → cálculo lineage the "signature
// moment" of the hero. Motion is colour-only + reduced-motion safe.
const chainStages = [
  { label: "fuente",   delay: "delay-[0ms]" },
  { label: "huella",   delay: "delay-[70ms]" },
  { label: "supuesto", delay: "delay-[140ms]" },
  { label: "cálculo",  delay: "delay-[210ms]" },
]

export function EvidenceDossier() {
  return (
    <div aria-hidden="true" className="group relative mx-auto w-full max-w-[560px] select-none">
      {/* "Muestra conceptual" ribbon — sits above the stack */}
      <div className="absolute -top-3 left-4 z-20">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-uellix-orange/25 bg-[var(--uellix-paper)] px-3 py-1 font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#B85200] shadow-sm">
          <span className="h-1 w-1 rounded-full bg-uellix-orange" />
          Muestra conceptual
        </span>
      </div>

      {/* Depth: stacked expediente layers behind the main panel — slight
          rotation on the rearmost sheet reads as loose physical pages in a
          folder, not a flat drop-shadow trick. */}
      <div className="absolute inset-0 translate-x-[14px] translate-y-[16px] rotate-[1.1deg] rounded-2xl border border-[#0F172A]/8 bg-white/35" />
      <div className="absolute inset-0 translate-x-[7px] translate-y-[8px] rounded-2xl border border-[#0F172A]/9 bg-white/65" />

      {/* Main panel — subtle glass + fine lines */}
      <div className="relative rounded-2xl border border-[#0F172A]/10 bg-white/92 backdrop-blur-sm shadow-[0_32px_70px_-28px_rgba(15,23,42,0.32),0_2px_8px_rgba(15,23,42,0.06)] overflow-hidden">
        {/* copper hairline top accent */}
        <div className="h-[3px] w-full bg-gradient-to-r from-uellix-orange via-[#C2703F] to-transparent" />

        <div className="relative pl-8 pr-5 sm:pl-9 sm:pr-6">
          <TraceSpine />

          <div className="py-4 border-b border-[#0F172A]/8">
            <DossierHeader />
          </div>

          {/* Stats — hairline divided */}
          <div className="grid grid-cols-3 -mx-8 sm:-mx-9 px-8 sm:px-9 gap-px bg-[#0F172A]/8 border-b border-[#0F172A]/8">
            {stats.map(({ label, value }) => (
              <div key={label} className="bg-white/90 px-2 sm:px-3 py-3">
                <p className="font-sora text-2xl sm:text-[28px] font-semibold text-[#0F172A] leading-none">{value}</p>
                <p className="text-[9.5px] text-[#5B6472] mt-1.5 font-manrope leading-tight">{label}</p>
              </div>
            ))}
          </div>

          {/* Evidence table — full list on sm+, first row only on mobile */}
          <div className="py-4">
            <p className="font-ibm-plex-mono text-[9px] font-bold tracking-[0.16em] text-[#475569] uppercase mb-3">
              Evidencias clave
            </p>
            <table className="w-full">
              <tbody>
                {evidencias.map(({ indicador, fuente, estado }, i) => (
                  <tr
                    key={indicador}
                    className={`border-b border-[#F1F5F9] last:border-0 ${i > 0 ? "hidden sm:table-row" : ""}`}
                  >
                    <td className="py-2 pr-3 text-[11px] text-[#0F172A] font-medium font-manrope leading-snug">
                      {indicador}
                      <span className="block font-ibm-plex-mono text-[9px] text-[#5B6472] font-normal">{fuente}</span>
                    </td>
                    <td className="py-2 text-right align-top">
                      {estado === "verified" ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600">
                          <CheckCircle2 className="h-3 w-3 shrink-0" />
                          Verificada
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600">
                          <Clock className="h-3 w-3 shrink-0" />
                          En revisión
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sm:hidden mt-2 font-ibm-plex-mono text-[9px] text-[#94A3B8] tracking-wide">
              + 2 evidencias más registradas
            </p>
          </div>

          {/* Stella Risk Review mini-panel */}
          <div className="pb-4 pt-1">
            <StellaRiskMini />
          </div>
        </div>

        {/* Traceability footer bar — the chain lights up left-to-right on hover */}
        <div className="px-5 sm:px-6 py-3 bg-[#0F172A] flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 font-ibm-plex-mono text-[9px] tracking-wide uppercase">
            {chainStages.map(({ label, delay }, i) => (
              <React.Fragment key={label}>
                {i > 0 && <span className="text-white/25">·</span>}
                <span
                  className={`text-white/45 transition-colors duration-[240ms] ease-[cubic-bezier(0.25,1,0.5,1)] group-hover:text-uellix-orange ${delay} motion-reduce:transition-none motion-reduce:delay-0`}
                >
                  {label}
                </span>
              </React.Fragment>
            ))}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-uellix-orange shrink-0 transition-transform duration-[240ms] group-hover:scale-150 motion-reduce:transition-none" />
            <span className="font-ibm-plex-mono text-[9px] text-uellix-orange font-medium tracking-wide uppercase">
              Audit-ready
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
