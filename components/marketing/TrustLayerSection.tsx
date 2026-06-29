import React from "react"
import { Hash, Link2, ShieldCheck, Users } from "lucide-react"

const pillars = [
  {
    icon: Link2,
    title: "Evidencias asociadas",
    description:
      "Cada resultado está conectado a su evidencia de respaldo. La vinculación es explícita, revisable y exportable.",
  },
  {
    icon: Hash,
    title: "Fuentes hasheadas",
    description:
      "Los documentos de evidencia se registran con su hash de integridad. Cualquier modificación es detectable.",
  },
  {
    icon: ShieldCheck,
    title: "Supuestos explícitos",
    description:
      "Ningún supuesto queda implícito. Cada proxy, filtro y decisión metodológica queda registrada con su justificación.",
  },
  {
    icon: Users,
    title: "Revisión humana requerida",
    description:
      "Uellix no reemplaza el juicio experto. El paso final siempre es tuyo: el sistema te da la estructura, tú das la validación.",
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
            Trazabilidad
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Cada dato, trazable y defendible
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Un análisis de impacto es tan sólido como su rastro metodológico. Uellix construye ese
            rastro en cada paso, no al final.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {pillars.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900 p-6"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                <Icon className="h-5 w-5 text-teal-400" aria-hidden="true" />
              </div>
              <h3 className="text-base font-semibold text-white">{title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
