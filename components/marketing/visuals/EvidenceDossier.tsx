import React from "react"
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react"

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceDossier — conceptual sample of an impact-evidence file ("expediente").
// Decorative (aria-hidden). No real client, project, or metric — this is a
// conceptual sample, explicitly labelled "Muestra conceptual".
// ─────────────────────────────────────────────────────────────────────────────

const evidencias = [
  { indicador: "Tasa de empleabilidad",     fuente: "Fuente pública",  estado: "verified" as const },
  { indicador: "Salario referencia sector", fuente: "Fuente oficial",  estado: "verified" as const },
  { indicador: "Horas de capacitación",     fuente: "Registro interno", estado: "review"  as const },
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

/** Small shared header used by both the full and compact variants. */
function DossierHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-ibm-plex-mono text-[9px] font-bold tracking-[0.2em] text-[#FF6A00] uppercase">
            Dossier de evidencia
          </span>
          <span className="text-[#CBD5E1] text-[9px]">/</span>
          <span className="font-ibm-plex-mono text-[9px] tracking-[0.12em] text-[#5B6472] uppercase">
            Muestra
          </span>
        </div>
        <h3 className="font-sora text-[15px] font-semibold text-[#0F172A] leading-snug">
          Proyecto de impacto social
        </h3>
        <p className="text-[11px] text-[#5B6472] mt-0.5 font-manrope">
          Inclusión laboral · período de medición
        </p>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 shrink-0 whitespace-nowrap">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 animate-pulse-glow motion-reduce:animate-none" />
        Lista para revisión humana
      </span>
    </div>
  )
}

/** Stella Risk Review mini-panel — shared. */
function StellaRiskMini() {
  return (
    <div className="rounded-lg border border-[#0F172A]/8 bg-[#FBFAFC]/80 backdrop-blur-sm p-3.5">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5 text-[#FF6A00]" />
          <span className="font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#475569]">
            Stella Risk Review
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded border border-amber-300/70 bg-amber-50 px-2 py-0.5 font-ibm-plex-mono text-[9px] font-semibold uppercase tracking-wide text-amber-700">
          Riesgo general · Medio
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
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

export function EvidenceDossier() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-[500px] select-none">
      {/* "Muestra conceptual" ribbon — sits above the stack */}
      <div className="absolute -top-3 left-4 z-20">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FF6A00]/25 bg-[var(--uellix-paper)] px-3 py-1 font-ibm-plex-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#B85200] shadow-sm">
          <span className="h-1 w-1 rounded-full bg-[#FF6A00]" />
          Muestra conceptual
        </span>
      </div>

      {/* Depth: stacked expediente layers behind the main panel */}
      <div className="absolute inset-0 translate-x-[10px] translate-y-[12px] rounded-2xl border border-[#0F172A]/8 bg-white/40" />
      <div className="absolute inset-0 translate-x-[5px] translate-y-[6px] rounded-2xl border border-[#0F172A]/8 bg-white/70" />

      {/* Main panel — subtle glass + fine lines */}
      <div className="relative rounded-2xl border border-[#0F172A]/10 bg-white/90 backdrop-blur-sm shadow-[0_24px_60px_-24px_rgba(15,23,42,0.30),0_2px_8px_rgba(15,23,42,0.06)] overflow-hidden">
        {/* copper hairline top accent */}
        <div className="h-[3px] w-full bg-gradient-to-r from-[#FF6A00] via-[#C2703F] to-transparent" />

        <div className="px-5 py-4 border-b border-[#0F172A]/8">
          <DossierHeader />
        </div>

        {/* Stats — hairline divided */}
        <div className="grid grid-cols-3 gap-px bg-[#0F172A]/8 border-b border-[#0F172A]/8">
          {stats.map(({ label, value }) => (
            <div key={label} className="bg-white/90 px-3 py-3">
              <p className="font-sora text-2xl font-semibold text-[#0F172A] leading-none">{value}</p>
              <p className="text-[9.5px] text-[#5B6472] mt-1.5 font-manrope leading-tight">{label}</p>
            </div>
          ))}
        </div>

        {/* Evidence table */}
        <div className="px-5 py-4">
          <p className="font-ibm-plex-mono text-[9px] font-bold tracking-[0.16em] text-[#475569] uppercase mb-3">
            Evidencias clave
          </p>
          <table className="w-full">
            <tbody>
              {evidencias.map(({ indicador, fuente, estado }) => (
                <tr key={indicador} className="border-b border-[#F1F5F9] last:border-0">
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
        </div>

        {/* Stella Risk Review mini-panel */}
        <div className="px-5 pb-4 pt-1">
          <StellaRiskMini />
        </div>

        {/* Traceability footer bar */}
        <div className="px-5 py-3 bg-[#0F172A] flex items-center justify-between gap-3">
          <span className="font-ibm-plex-mono text-[9px] text-white/50 tracking-wide uppercase">
            fuente · huella · supuesto · cálculo
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-[#FF6A00] shrink-0" />
            <span className="font-ibm-plex-mono text-[9px] text-[#FF6A00] font-medium tracking-wide uppercase">
              Audit-ready
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
