import React from "react"
import Link from "next/link"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import { ImpactLedgerPanel } from "@/components/marketing/visuals/ImpactLedgerPanel"

const trustItems = [
  "Trazabilidad de extremo a extremo",
  "Fuentes verificables y metodologías rigurosas",
  "Revisión humana requerida",
]

export function HeroSection() {
  return (
    <section
      id="inicio"
      aria-label="Sección principal"
      className="relative overflow-hidden bg-[#FBFAFC] px-4 pt-20 pb-24 sm:pt-24 sm:pb-32 lg:pt-28 lg:pb-36"
    >
      {/* Subtle grid pattern */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.025)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_80%_70%_at_50%_0%,black_40%,transparent)]"
      />

      {/* Orange accent glow — very subtle */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[-10%] top-[-5%] h-[500px] w-[500px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,106,0,0.05),transparent_65%)]"
      />

      <div className="relative z-10 mx-auto max-w-7xl">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-10 xl:gap-16">

          {/* ── Left: copy column ── */}
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#FF6A00]/25 bg-[#FF6A00]/8 px-4 py-1.5 text-xs font-semibold text-[#FF6A00] mb-8 font-ibm-plex-mono tracking-wide uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-[#FF6A00] shrink-0" aria-hidden="true" />
              Ledger cívico
            </span>

            <h1 className="font-sora text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-[3.2rem] xl:text-[3.5rem] text-[#0F172A] mb-6 leading-[1.07]">
              Uellix convierte el impacto social en{" "}
              <span className="text-[#FF6A00]">
                evidencia defendible.
              </span>
            </h1>

            <p className="font-manrope text-base sm:text-lg text-[#64748B] max-w-xl mb-10 leading-relaxed">
              Un sistema audit-ready para medir, gestionar y comunicar impacto
              con rigor, transparencia y trazabilidad.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 items-center w-full sm:w-auto">
              <a
                href="mailto:hola@uellix.com?subject=Solicitud%20de%20demo"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#FF6A00] px-6 py-3 text-base font-semibold text-white hover:bg-[#e05e00] active:bg-[#cc5500] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] transition-colors duration-150 min-h-[44px] w-full sm:w-auto font-sora"
              >
                Solicitar demo
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-6 py-3 text-base font-semibold text-[#0F172A] hover:bg-[#F1F5F9] hover:border-[#CBD5E1] active:bg-[#E2E8F0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] transition-colors duration-150 min-h-[44px] w-full sm:w-auto font-sora"
              >
                Entrar a la plataforma
              </Link>
            </div>

            <ul
              aria-label="Beneficios clave de la plataforma"
              className="mt-8 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2"
            >
              {trustItems.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-1.5 text-xs text-[#64748B] font-manrope"
                >
                  <CheckCircle2
                    className="h-3.5 w-3.5 shrink-0 text-[#FF6A00]"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>

            <p className="mt-6 text-xs text-[#94A3B8] max-w-md leading-relaxed font-manrope">
              Stella asiste y detecta riesgos metodológicos. La revisión humana
              es siempre el paso final requerido.
            </p>
          </div>

          {/* ── Right: Impact Ledger Panel (desktop) ── */}
          <div className="hidden lg:flex items-center justify-center">
            <ImpactLedgerPanel />
          </div>
        </div>
      </div>
    </section>
  )
}
