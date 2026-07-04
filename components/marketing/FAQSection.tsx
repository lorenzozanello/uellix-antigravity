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

// FAQPage structured data — generated from the same `faqs` source so the
// rich-snippet schema can never drift from the rendered content.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: { "@type": "Answer", text: answer },
  })),
}

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  function toggle(index: number) {
    setOpenIndex(openIndex === index ? null : index)
  }

  return (
    <section
      id="faq"
      aria-label="Preguntas frecuentes"
      className="section-seam relative overflow-hidden bg-[var(--uellix-carbon)] px-4 py-24 sm:py-32"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="texture-grain-b" aria-hidden="true" />
      <div className="relative z-10 mx-auto max-w-3xl">
        <div className="mb-14">
          <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#FF6A00] mb-6">
            <span className="h-px w-8 bg-[#FF6A00]/50" aria-hidden="true" />
            Preguntas frecuentes
          </span>
          <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-semibold tracking-[-0.015em] leading-[1.05] text-white">
            Lo que un equipo riguroso necesita saber.
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
                      className={`h-4 w-4 shrink-0 text-[#94A3B8] transition-premium motion-reduce:transition-none ${
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
