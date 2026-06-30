import React from "react"
import { Link2, Hash, ShieldCheck, Users } from "lucide-react"

const ledgerEntries = [
  {
    icon: Link2,
    number: "01",
    title: "Fuente verificable",
    description:
      "Cada evidencia queda vinculada a su fuente original, documentada y exportable para revisión externa.",
    tagLabel: "SOURCE",
  },
  {
    icon: Hash,
    number: "02",
    title: "Hash de integridad",
    description:
      "Los documentos de evidencia se registran con un hash de integridad. Cualquier modificación posterior es detectable.",
    tagLabel: "SHA-256",
  },
  {
    icon: ShieldCheck,
    number: "03",
    title: "Supuesto metodológico",
    description:
      "Ningún supuesto queda implícito. Cada proxy, filtro y decisión metodológica queda registrada con su justificación.",
    tagLabel: "ASSUMPTION",
  },
  {
    icon: Users,
    number: "04",
    title: "Revisión humana requerida",
    description:
      "Uellix no reemplaza el juicio experto. El paso final siempre es tuyo: el sistema te da la estructura, tú das la validación.",
    tagLabel: "REVIEWER",
  },
]

export function TrustLayerSection() {
  return (
    <section
      id="confianza"
      aria-label="Capa de trazabilidad y confianza"
      className="bg-white px-4 py-20 sm:py-28 border-b border-[#E2E8F0]"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-[#0F172A]/5 border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#64748B] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            Trust Layer
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-[#0F172A]">
            Cada dato tiene origen, huella y contexto.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto leading-relaxed font-manrope">
            Un análisis de impacto es tan sólido como su rastro metodológico. Uellix
            construye ese rastro en cada paso, no al final.
          </p>
        </div>

        {/* Audit ledger layout */}
        <div className="mx-auto max-w-4xl">
          <div className="relative">
            {/* Vertical timeline line */}
            <div
              aria-hidden="true"
              className="absolute left-6 top-6 bottom-6 w-px bg-gradient-to-b from-[#FF6A00]/40 via-[#FF6A00]/15 to-transparent hidden sm:block"
            />

            <div className="flex flex-col gap-4">
              {ledgerEntries.map(({ icon: Icon, number, title, description, tagLabel }) => (
                <div
                  key={title}
                  className="group relative flex gap-5 rounded-xl border border-[#E2E8F0] bg-[#FBFAFC] p-5 sm:p-6 card-lift hover:bg-white"
                >
                  {/* Timeline dot — desktop */}
                  <div
                    aria-hidden="true"
                    className="relative z-10 hidden sm:flex h-12 w-12 shrink-0 flex-col items-center justify-center self-start"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-[#E2E8F0] bg-white ring-4 ring-[#FBFAFC] transition-all duration-150 group-hover:border-[#FF6A00]/40 group-hover:ring-white shadow-sm">
                      <Icon className="h-3.5 w-3.5 text-[#0F172A]" aria-hidden="true" />
                    </div>
                  </div>

                  {/* Mobile: icon only, no timeline */}
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] sm:hidden">
                    <Icon className="h-5 w-5 text-[#0F172A]" aria-hidden="true" />
                  </div>

                  <div className="flex flex-1 flex-col gap-2 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span
                        className="font-ibm-plex-mono text-[10px] font-bold tracking-[0.18em] text-[#94A3B8] uppercase"
                        aria-hidden="true"
                      >
                        {number}
                      </span>
                      <span className="inline-flex items-center rounded border border-[#E2E8F0] bg-white px-2 py-0.5 font-ibm-plex-mono text-[9px] text-[#64748B] tracking-wider uppercase shadow-sm">
                        {tagLabel}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold text-[#0F172A] font-sora">{title}</h3>
                    <p className="text-sm text-[#64748B] leading-relaxed font-manrope">{description}</p>
                  </div>

                  {/* Entry index in background — decorative */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute right-4 top-4 font-ibm-plex-mono text-5xl font-black text-[#E2E8F0]/80 select-none tabular-nums"
                  >
                    {number}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Status card */}
          <div className="mt-6 rounded-xl border border-[#E2E8F0] bg-white p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 border border-emerald-200">
                <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-[#0F172A] font-sora">Listo para revisión</p>
                <p className="text-xs text-[#64748B] font-manrope">Rastro metodológico completo y exportable</p>
              </div>
            </div>
            <div className="sm:ml-auto flex items-center gap-2">
              <span className="font-ibm-plex-mono text-[10px] text-[#94A3B8] tracking-wide uppercase">audit-ready</span>
              <span className="h-1.5 w-1.5 rounded-full bg-[#FF6A00]" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
