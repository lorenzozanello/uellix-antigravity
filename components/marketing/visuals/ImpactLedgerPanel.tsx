import React from "react"
import { CheckCircle2, Clock } from "lucide-react"

const evidencias = [
  { indicador: "Tasa de empleabilidad",     fuente: "CEPAL 2023",        estado: "verified" as const },
  { indicador: "Salario referencia sector", fuente: "Min. Trabajo 2024", estado: "verified" as const },
  { indicador: "Horas de capacitación",     fuente: "Estudio interno",   estado: "review"   as const },
]

const stats = [
  { label: "Valor social estimado", value: "$2.847.320", mono: true  },
  { label: "Evidencias vinculadas", value: "12",         mono: false },
  { label: "Proxies registrados",   value: "8 fuentes",  mono: false },
  { label: "Supuestos explícitos",  value: "14",         mono: false },
]

export function ImpactLedgerPanel() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto w-full max-w-[520px] select-none"
    >
      {/* Stack layers — isotipo reference */}
      <div className="absolute inset-0 translate-x-[8px] translate-y-[8px] rounded-2xl border border-[#E2E8F0] bg-white opacity-50" />
      <div className="absolute inset-0 translate-x-[4px] translate-y-[4px] rounded-2xl border border-[#E2E8F0] bg-white opacity-75" />

      {/* Main panel */}
      <div className="relative rounded-2xl border border-[#E2E8F0] bg-white shadow-xl shadow-[#0F172A]/6 overflow-hidden">

        {/* Header */}
        <div className="px-5 py-4 border-b border-[#E2E8F0] flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-ibm-plex-mono text-[9px] font-bold tracking-[0.18em] text-[#64748B] uppercase">
                LEDGER CÍVICO
              </span>
              <span className="text-[#E2E8F0] text-[9px]">/</span>
              <span className="font-ibm-plex-mono text-[9px] tracking-[0.1em] text-[#94A3B8] uppercase">
                SROI 2020
              </span>
            </div>
            <h3 className="font-sora text-sm font-semibold text-[#0F172A] leading-snug">
              Fundación Horizonte Social
            </h3>
            <p className="text-xs text-[#64748B] mt-0.5">
              Inclusión Laboral · 2024–2025
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 shrink-0 whitespace-nowrap">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 animate-pulse-glow motion-reduce:animate-none" />
            Listo para revisión
          </span>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-px bg-[#E2E8F0] border-b border-[#E2E8F0]">
          {stats.map(({ label, value, mono }) => (
            <div key={label} className="bg-white px-4 py-3">
              <p className="text-[10px] text-[#94A3B8] mb-1 font-manrope">{label}</p>
              <p className={`text-base font-bold text-[#0F172A] leading-none ${mono ? "font-ibm-plex-mono tracking-tight" : "font-sora"}`}>
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* Evidence table */}
        <div className="px-5 py-4">
          <p className="font-ibm-plex-mono text-[9px] font-bold tracking-[0.16em] text-[#64748B] uppercase mb-3">
            EVIDENCIAS CLAVE
          </p>
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#E2E8F0]">
                <th className="text-left text-[10px] font-medium text-[#94A3B8] pb-2 font-manrope pr-3">Indicador</th>
                <th className="text-left text-[10px] font-medium text-[#94A3B8] pb-2 font-manrope pr-3">Fuente</th>
                <th className="text-right text-[10px] font-medium text-[#94A3B8] pb-2 font-manrope">Estado</th>
              </tr>
            </thead>
            <tbody>
              {evidencias.map(({ indicador, fuente, estado }) => (
                <tr key={indicador} className="border-b border-[#F8FAFC] last:border-0">
                  <td className="py-2 pr-3 text-[11px] text-[#0F172A] font-medium font-manrope leading-snug">
                    {indicador}
                  </td>
                  <td className="py-2 pr-3 text-[11px] text-[#64748B] font-ibm-plex-mono">
                    {fuente}
                  </td>
                  <td className="py-2 text-right">
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

        {/* Traceability footer bar */}
        <div className="px-5 py-3 bg-[#FBFAFC] border-t border-[#E2E8F0] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="font-ibm-plex-mono text-[9px] text-[#94A3B8] tracking-wide">SROI 2020</span>
            <span className="text-[#E2E8F0] text-[10px]">·</span>
            <span className="text-[10px] text-[#94A3B8] font-manrope">312 participantes</span>
            <span className="text-[#E2E8F0] text-[10px]">·</span>
            <span className="text-[10px] text-[#94A3B8] font-manrope">Revisión humana requerida</span>
          </div>
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
