import React from "react"
import type { Metadata } from "next"
import { CheckCircle2 } from "lucide-react"
import { DemoRequestForm } from "@/components/marketing/DemoRequestForm"

export const metadata: Metadata = {
  title: "Solicitar demo",
  description:
    "Solicitá una demo privada de Uellix: implementación guiada, capacitación metodológica y soporte continuo.",
  alternates: { canonical: "/demo" },
}

const benefits = [
  "Implementación guiada",
  "Capacitación metodológica",
  "Soporte continuo",
]

export default function DemoRequestPage() {
  return (
    <section
      aria-label="Solicitar demo"
      className="relative overflow-hidden bg-[var(--uellix-paper)] px-4 py-20 sm:py-28"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:radial-gradient(ellipse_85%_65%_at_50%_0%,black_35%,transparent)]"
      />

      <div className="relative z-10 mx-auto max-w-5xl grid grid-cols-1 gap-14 lg:grid-cols-[0.85fr_1fr] lg:items-start">
        {/* Left — narrative */}
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-[#FF6A00]/25 bg-[#FF6A00]/8 px-3.5 py-1.5 text-[11px] font-semibold text-[#B85200] mb-7 font-ibm-plex-mono tracking-[0.14em] uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-[#FF6A00] shrink-0" aria-hidden="true" />
            Demo privada
          </span>
          <h1 className="font-sora font-semibold tracking-[-0.02em] text-[#0F172A] mb-6 text-[clamp(2.2rem,4.5vw,3.2rem)] leading-[1.05]">
            Trae un proyecto. Te mostramos cómo se convierte en un{" "}
            <span className="text-[#FF6A00]">análisis defendible.</span>
          </h1>
          <p className="font-manrope text-base text-[#475569] leading-relaxed mb-8 max-w-md">
            Contanos brevemente sobre tu organización y tu proyecto. Nuestro equipo
            te va a contactar para coordinar una demo guiada de la plataforma.
          </p>
          <ul aria-label="Incluido con Uellix" className="flex flex-col gap-2.5 mb-8">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex items-center gap-2.5 text-sm text-[#0F172A] font-manrope">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[#FF6A00]" aria-hidden="true" />
                {benefit}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[#64748B] leading-relaxed font-manrope border-l-2 border-[#FF6A00]/30 pl-3 max-w-sm">
            Stella ayuda a identificar riesgos metodológicos. La validación final
            permanece en manos del equipo experto.
          </p>
        </div>

        {/* Right — form panel */}
        <div className="rounded-2xl border border-[#0F172A]/10 bg-white/70 backdrop-blur-sm shadow-[0_24px_60px_-24px_rgba(15,23,42,0.20)] p-6 sm:p-8">
          <DemoRequestForm />
        </div>
      </div>
    </section>
  )
}
