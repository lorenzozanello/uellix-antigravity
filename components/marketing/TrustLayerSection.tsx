import React from "react"
import { Link2, Hash, ShieldCheck, Users } from "lucide-react"

const ledgerEntries = [
  {
    icon: Link2,
    number: "01",
    title: "Fuente verificable",
    description:
      "Cada evidencia queda vinculada a su fuente original, documentada y exportable para revisión externa.",
    tag: "source",
    tagLabel: "SOURCE",
  },
  {
    icon: Hash,
    number: "02",
    title: "Hash de integridad",
    description:
      "Los documentos de evidencia se registran con un hash de integridad. Cualquier modificación posterior es detectable.",
    tag: "integrity",
    tagLabel: "SHA-256",
  },
  {
    icon: ShieldCheck,
    number: "03",
    title: "Supuesto metodológico",
    description:
      "Ningún supuesto queda implícito. Cada proxy, filtro y decisión metodológica queda registrada con su justificación.",
    tag: "assumption",
    tagLabel: "ASSUMPTION",
  },
  {
    icon: Users,
    number: "04",
    title: "Revisión humana requerida",
    description:
      "Uellix no reemplaza el juicio experto. El paso final siempre es tuyo: el sistema te da la estructura, tú das la validación.",
    tag: "reviewer",
    tagLabel: "REVIEWER",
  },
]

export function TrustLayerSection() {
  return (
    <section
      id="trazabilidad"
      aria-label="Capa de trazabilidad y confianza"
      className="bg-slate-950 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            Trust Layer
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Cada decisión, visible. Cada supuesto, defendible.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Un análisis de impacto es tan sólido como su rastro metodológico. Uellix construye
            ese rastro en cada paso, no al final.
          </p>
        </div>

        {/* Audit trail / ledger layout */}
        <div className="mx-auto max-w-4xl">
          <div className="relative">
            {/* Vertical timeline line */}
            <div
              aria-hidden="true"
              className="absolute left-6 top-6 bottom-6 w-px bg-gradient-to-b from-teal-500/30 via-teal-500/15 to-transparent hidden sm:block"
            />

            <div className="flex flex-col gap-4">
              {ledgerEntries.map(({ icon: Icon, number, title, description, tagLabel }) => (
                <div
                  key={title}
                  className="group relative flex gap-5 rounded-xl border border-slate-800 bg-slate-900 p-5 sm:p-6 card-lift"
                >
                  {/* Timeline dot */}
                  <div
                    aria-hidden="true"
                    className="relative z-10 hidden sm:flex h-12 w-12 shrink-0 flex-col items-center justify-center self-start"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-teal-500/30 bg-slate-950 ring-4 ring-slate-900 transition-all duration-150 group-hover:border-teal-500/55 group-hover:bg-teal-500/10">
                      <Icon className="h-3.5 w-3.5 text-teal-400" aria-hidden="true" />
                    </div>
                  </div>

                  {/* Mobile: icon only, no timeline */}
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 sm:hidden">
                    <Icon className="h-5 w-5 text-teal-400" aria-hidden="true" />
                  </div>

                  <div className="flex flex-1 flex-col gap-2 min-w-0">
                    {/* Entry header with mono tag */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <span
                        className="font-mono text-[10px] font-bold tracking-[0.18em] text-slate-600 uppercase"
                        aria-hidden="true"
                      >
                        {number}
                      </span>
                      <span className="inline-flex items-center rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 font-mono text-[10px] text-slate-500 tracking-wider">
                        {tagLabel}
                      </span>
                    </div>
                    <h3 className="text-base font-semibold text-white">{title}</h3>
                    <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
                  </div>

                  {/* Entry index in background (decorative) */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute right-4 top-4 font-mono text-5xl font-black text-slate-800/40 select-none tabular-nums"
                  >
                    {number}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
