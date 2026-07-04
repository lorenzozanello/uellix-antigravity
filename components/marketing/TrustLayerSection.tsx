import React from "react"
import { Link2, Fingerprint, ShieldCheck, UserCheck, FileDown } from "lucide-react"

const layers = [
  {
    icon: Link2,
    tag: "SOURCE",
    title: "Fuente verificable",
    description: "Cada evidencia queda vinculada a su fuente original, documentada y exportable para revisión externa.",
  },
  {
    icon: Fingerprint,
    tag: "SHA-256",
    title: "Huella de integridad",
    description: "Los documentos de evidencia se registran con una huella de integridad. Cualquier modificación posterior es detectable.",
  },
  {
    icon: ShieldCheck,
    tag: "ASSUMPTION",
    title: "Supuesto metodológico",
    description: "Ningún supuesto queda implícito. Cada proxy, filtro y decisión metodológica se registra con su justificación.",
  },
  {
    icon: UserCheck,
    tag: "REVIEWER",
    title: "Revisión humana",
    description: "Uellix no reemplaza el juicio experto. El paso final siempre es tuyo: el sistema da la estructura, tú das la validación.",
  },
  {
    icon: FileDown,
    tag: "EXPORT",
    title: "Exportación audit-ready",
    description: "El rastro completo se exporta como un expediente coherente, revisable por terceros, listo para escrutinio externo.",
  },
]

export function TrustLayerSection() {
  return (
    <section
      id="confianza"
      aria-label="Capa de trazabilidad y confianza"
      className="bg-[var(--uellix-paper)] px-4 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-x-12 gap-y-12 lg:grid-cols-12 lg:items-start">

          {/* Heading */}
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-28">
              <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-6">
                <span className="h-px w-8 bg-[#FF6A00]/50" aria-hidden="true" />
                Centro de confianza
              </span>
              <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-semibold leading-[1.05] tracking-[-0.015em] text-[#0F172A]">
                Cada dato tiene origen, huella y contexto.
              </h2>
              <p className="mt-6 text-base text-[#475569] max-w-md leading-relaxed font-manrope">
                Un análisis de impacto es tan sólido como su rastro metodológico.
                Uellix construye ese rastro en cada paso, no al final.
              </p>

              <div className="mt-8 inline-flex items-center gap-3 rounded-xl border border-[#0F172A]/10 bg-white/70 backdrop-blur-sm px-4 py-3 shadow-sm">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 border border-emerald-200">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-[#0F172A] font-sora">Listo para revisión</p>
                  <p className="font-ibm-plex-mono text-[10px] text-[#5B6472] tracking-wide uppercase">audit-ready · trazable</p>
                </div>
              </div>
            </div>
          </div>

          {/* Stacked trust layers — expediente depth */}
          <div className="lg:col-span-7">
            <ol className="flex flex-col">
              {layers.map(({ icon: Icon, tag, title, description }, i) => (
                <li
                  key={tag}
                  className="group relative flex gap-5 rounded-xl border border-[#0F172A]/10 bg-white/80 backdrop-blur-sm p-5 sm:p-6 card-lift"
                  style={{
                    marginTop: i === 0 ? 0 : "-0.5rem",
                    zIndex: i + 1,
                    boxShadow: "0 -1px 0 rgba(15,23,42,0.03), 0 12px 30px -20px rgba(15,23,42,0.25)",
                  }}
                >
                  {/* copper index */}
                  <div className="flex shrink-0 flex-col items-center gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#0F172A]/10 bg-[var(--uellix-paper)] transition-premium group-hover:border-[#FF6A00]/40 group-hover:bg-[#FF6A00]/5">
                      <Icon className="h-4 w-4 text-[#0F172A] transition-premium group-hover:text-[#FF6A00]" aria-hidden="true" />
                    </span>
                    <span className="font-ibm-plex-mono text-[9px] font-bold text-[#CBD5E1] tabular-nums" aria-hidden="true">
                      0{i + 1}
                    </span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <span className="inline-flex items-center rounded border border-[#0F172A]/10 bg-[var(--uellix-paper)] px-2 py-0.5 font-ibm-plex-mono text-[9px] text-[#5B6472] tracking-[0.14em] uppercase mb-2">
                      {tag}
                    </span>
                    <h3 className="text-base font-semibold text-[#0F172A] font-sora">{title}</h3>
                    <p className="mt-1 text-sm text-[#5B6472] leading-relaxed font-manrope">{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
