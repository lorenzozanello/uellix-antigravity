import React from "react"

const problems = [
  {
    n: "01",
    title: "Evidencia dispersa",
    description:
      "Los análisis quedan fragmentados en documentos, hojas de cálculo y archivos sueltos. La trazabilidad metodológica se pierde antes de llegar al reporte.",
  },
  {
    n: "02",
    title: "Supuestos frágiles",
    description:
      "Los proxies y supuestos se cuestionan en revisiones externas porque no hay registro claro de su fuente, su justificación ni su aplicación en el cálculo.",
  },
  {
    n: "03",
    title: "Reportes difíciles de sostener",
    description:
      "El escrutinio externo exige trazabilidad completa: fuente, supuesto, evidencia y cálculo. Sin esa estructura, la defensa del análisis queda expuesta.",
  },
]

export function ProblemSection() {
  return (
    <section
      id="desafio"
      aria-label="El desafío de la medición de impacto"
      className="bg-[var(--uellix-paper)] px-4 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-7xl">
        <div className="grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-12">

          {/* Left rail — sticky heading (asymmetric) */}
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-28">
              <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-6">
                <span className="h-px w-8 bg-uellix-orange/30" aria-hidden="true" />
                El desafío
              </span>
              <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-bold leading-[1.05] tracking-[-0.015em] text-[#0F172A]">
                La evidencia está dispersa. El impacto es difícil de defender.
              </h2>
              <p className="mt-6 text-base text-[#475569] max-w-md leading-relaxed font-manrope">
                Las organizaciones invierten semanas construyendo análisis SROI que
                no resisten el escrutinio, porque metodología, evidencia y supuestos
                no están conectados de forma trazable.
              </p>
            </div>
          </div>

          {/* Right — editorial numbered list, hairline divided */}
          <div className="lg:col-span-7">
            <div className="flex flex-col">
              {problems.map(({ n, title, description }, i) => (
                <div
                  key={n}
                  className={`group grid grid-cols-[auto_1fr] gap-6 py-8 ${
                    i !== 0 ? "border-t border-[#0F172A]/10" : ""
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="font-sora text-4xl sm:text-5xl font-semibold text-[#0F172A]/12 tabular-nums leading-none transition-premium group-hover:text-uellix-orange/60"
                  >
                    {n}
                  </span>
                  <div>
                    <h3 className="font-sora text-xl font-semibold text-[#0F172A] mb-2">
                      {title}
                    </h3>
                    <p className="text-[15px] text-[#5B6472] leading-relaxed font-manrope max-w-lg">
                      {description}
                    </p>
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
