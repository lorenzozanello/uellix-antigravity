"use client"

import React, { useState } from "react"
import { ChevronDown } from "lucide-react"

const faqs = [
  {
    question: "¿Uellix certifica el impacto?",
    answer:
      "No. Uellix no es un certificador. Es una plataforma que te ayuda a estructurar tu metodología, asociar evidencias y calcular el ratio SROI de forma trazable y audit-ready. La validación del análisis la realiza siempre un experto humano. Uellix te da la estructura y el rastro; la certificación formal depende del organismo o proceso que aplique en tu caso.",
  },
  {
    question: "¿Stella calcula el SROI?",
    answer:
      "No. Stella no calcula el SROI. El cálculo lo realiza el motor determinístico de Uellix en función de los datos, proxies y filtros que tú defines. Stella Validator revisa los riesgos metodológicos del contexto del cálculo e identifica posibles brechas de evidencia, riesgos de proxy o riesgos en los claims. Stella es asistencia metodológica, no cálculo automático.",
  },
  {
    question: "¿Qué significa audit-ready?",
    answer:
      "Audit-ready significa que el análisis tiene la estructura necesaria para ser revisado por un tercero: cada resultado está asociado a su evidencia, cada proxy tiene su fuente declarada, cada filtro aplicado queda registrado, y el rastro metodológico es completo y exportable. No implica que el análisis haya sido auditado, sino que está preparado para serlo.",
  },
  {
    question: "¿Qué tipo de evidencia puedo asociar?",
    answer:
      "Puedes asociar documentos, referencias, informes de campo, fuentes secundarias y cualquier material que respalde tus resultados e indicadores. La plataforma registra la fuente y permite documentar el vínculo entre la evidencia y el resultado al que corresponde. La calidad y pertinencia de la evidencia es responsabilidad del equipo metodológico.",
  },
  {
    question: "¿Puedo usar Uellix antes de una revisión externa?",
    answer:
      "Sí. Uellix está diseñado precisamente para preparar el análisis antes de una revisión externa o auditoría de impacto. La plataforma te ayuda a organizar el rastro metodológico, identificar riesgos con Stella Validator y generar reportes revisables. El análisis generado en Uellix es un insumo para la revisión humana, no un sustituto de ella.",
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
      className="bg-slate-900 px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-3xl">
        <div className="text-center mb-14">
          <span className="inline-flex items-center rounded-full bg-teal-500/10 px-4 py-1.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-5">
            Preguntas frecuentes
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl text-white">
            Todo lo que necesitas saber
          </h2>
        </div>

        <dl className="flex flex-col gap-3">
          {faqs.map(({ question, answer }, index) => {
            const isOpen = openIndex === index
            const panelId = `faq-panel-${index}`
            const buttonId = `faq-button-${index}`

            return (
              <div
                key={question}
                className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden"
              >
                <dt>
                  <button
                    id={buttonId}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggle(index)}
                    className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left text-sm font-semibold text-white hover:text-teal-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-500 focus-visible:outline-offset-[-2px] transition-colors min-h-[44px]"
                  >
                    <span>{question}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${
                        isOpen ? "rotate-180" : ""
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
                  <p className="text-sm text-slate-400 leading-relaxed">{answer}</p>
                </dd>
              </div>
            )
          })}
        </dl>
      </div>
    </section>
  )
}
