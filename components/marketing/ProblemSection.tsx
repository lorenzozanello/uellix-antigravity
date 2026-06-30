import React from "react"
import { AlertCircle, FileX, Search } from "lucide-react"

const problems = [
  {
    icon: FileX,
    title: "Datos desconectados",
    description:
      "Los análisis de impacto quedan fragmentados en documentos, hojas de cálculo y evidencias sin conexión entre sí. La trazabilidad metodológica se pierde antes de llegar al reporte.",
  },
  {
    icon: AlertCircle,
    title: "Supuestos no verificables",
    description:
      "Los proxies y supuestos metodológicos son cuestionados en revisiones externas porque no hay un registro claro de su fuente, justificación ni su aplicación en el cálculo.",
  },
  {
    icon: Search,
    title: "Riesgo metodológico",
    description:
      "Los informes externos exigen trazabilidad completa: fuente, supuesto, evidencia y cálculo. Sin esa estructura, la defensa del análisis queda expuesta ante cualquier auditoría.",
  },
]

export function ProblemSection() {
  return (
    <section
      id="desafio"
      aria-label="El desafío de la medición de impacto"
      className="bg-white px-4 py-20 sm:py-28 border-b border-[#E2E8F0]"
    >
      <div className="mx-auto max-w-7xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-[#0F172A]/5 border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#64748B] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            El desafío
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-[#0F172A]">
            La evidencia está dispersa.{" "}
            <br className="hidden sm:block" />
            El impacto es difícil de defender.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#64748B] max-w-2xl mx-auto leading-relaxed font-manrope">
            Las organizaciones invierten semanas construyendo análisis SROI que
            no resisten el escrutinio porque la metodología, la evidencia y los
            supuestos no están conectados de forma trazable.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {problems.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="group rounded-xl border border-[#E2E8F0] bg-white p-6 flex flex-col gap-4 card-lift"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] transition-colors group-hover:bg-[#0F172A]/5">
                <Icon
                  className="h-5 w-5 text-[#0F172A] transition-colors"
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-base font-semibold text-[#0F172A] font-sora">{title}</h3>
              <p className="text-sm text-[#64748B] leading-relaxed font-manrope">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
