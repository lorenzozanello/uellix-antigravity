"use client"

import React, { useState } from "react"
import { ChevronDown } from "lucide-react"

const faqs = [
  {
    question: "¿Uellix está alineado con SROI 2020?",
    answer:
      "El pipeline de Uellix está diseñado siguiendo los principios del SROI 2020: trazabilidad de resultados, evidencias asociadas, proxies con fuente declarada y filtros aplicados con justificación. El análisis generado está estructurado para ser revisable según esos estándares.",
  },
  {
    question: "¿Qué tan trazable es la evidencia?",
    answer:
      "Cada evidencia queda vinculada a su fuente original con hash de integridad. El rastro metodológico es completo y exportable: fuente, supuesto, proxy, indicador y cálculo están conectados en cada paso del pipeline.",
  },
  {
    question: "¿Quién realiza la revisión final?",
    answer:
      "Siempre un experto humano. Uellix no reemplaza el juicio experto. Stella puede identificar riesgos metodológicos y orientar la construcción del análisis, pero la validación y el uso externo del análisis siempre requieren revisión humana.",
  },
  {
    question: "¿Puedo exportar mis informes?",
    answer:
      "Sí. La plataforma genera reportes audit-ready exportables con supuestos explícitos, fuentes citadas y el rastro completo de decisiones metodológicas. El Impact Deck está diseñado para ser revisable por terceros.",
  },
  {
    question: "¿Qué nivel de soporte ofrecen?",
    answer:
      "Ofrecemos implementación guiada, capacitación en buenas prácticas metodológicas y soporte metodológico continuo. Nuestro equipo acompaña la adopción de la plataforma y responde consultas sobre metodología SROI.",
  },
  {
    question: "¿Es segura mi información?",
    answer:
      "Sí. La plataforma está construida con controles de acceso y seguridad de datos enterprise. Cada organización accede únicamente a su propia información. Para más detalles, contáctanos en hola@uellix.com.",
  },
]

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  function toggle(index: number) {
    setOpenIndex(openIndex === index ? null : index)
  }

  return (
    <section
      id="faq"
      aria-label="Preguntas frecuentes"
      className="bg-[#0F172A] px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-3xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full border border-[#FF6A00]/30 bg-[#FF6A00]/10 px-4 py-1.5 text-xs font-semibold text-[#FF6A00] mb-5 font-ibm-plex-mono tracking-wide uppercase">
            Preguntas frecuentes
          </span>
          <h2 className="font-sora text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Lo que necesitas saber.
          </h2>
        </div>

        <dl className="flex flex-col gap-2">
          {faqs.map(({ question, answer }, index) => {
            const isOpen = openIndex === index
            const panelId = `faq-panel-${index}`
            const buttonId = `faq-button-${index}`

            return (
              <div
                key={question}
                className={`rounded-xl border overflow-hidden transition-colors ${
                  isOpen
                    ? "border-[#FF6A00]/25 bg-[#FF6A00]/5"
                    : "border-[#1E293B] bg-[#0A1220]"
                }`}
              >
                <dt>
                  <button
                    id={buttonId}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggle(index)}
                    className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left text-sm font-semibold text-white hover:text-[#FF6A00]/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF6A00] focus-visible:outline-offset-[-2px] transition-colors min-h-[44px] font-sora"
                  >
                    <span>{question}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-[#64748B] transition-transform duration-200 motion-reduce:transition-none ${
                        isOpen ? "rotate-180 text-[#FF6A00]" : ""
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                </dt>
                <dd
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  hidden={!isOpen}
                  className="px-6 pb-5"
                >
                  <p className="text-sm text-[#94A3B8] leading-relaxed font-manrope">{answer}</p>
                </dd>
              </div>
            )
          })}
        </dl>
      </div>
    </section>
  )
}
