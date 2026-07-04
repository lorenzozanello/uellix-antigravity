import React from "react"
import Link from "next/link"

const productLinks = [
  { label: "Plataforma",          href: "#producto" },
  { label: "Método",              href: "#metodologia" },
  { label: "Stella",              href: "#stella" },
  { label: "Centro de confianza", href: "#confianza" },
]

const resourceLinks = [
  { label: "Casos de uso",         href: "#casos" },
  { label: "Preguntas frecuentes", href: "#faq" },
]

const companyLinks = [
  { label: "Contacto",   href: "mailto:hola@uellix.com" },
  { label: "Privacidad", href: "/privacidad" },
  { label: "Términos",   href: "/terminos" },
]

export function Footer() {
  return (
    <footer
      className="relative overflow-hidden bg-[var(--uellix-carbon)] px-4 pt-16 pb-8"
      aria-label="Pie de página"
    >
      <div className="texture-grain" aria-hidden="true" />
      <div className="relative z-10 mx-auto max-w-7xl">

        <div className="grid grid-cols-2 gap-8 lg:grid-cols-4 mb-12">
          {/* Brand column */}
          <div className="col-span-2 lg:col-span-1">
            <Link
              href="/"
              className="mb-4 w-fit inline-block transition-premium hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange"
              aria-label="Uellix — Inicio"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/uellix-logo-horizontal-reversed.svg"
                alt="Uellix"
                width="120"
                height="30"
                className="h-8 w-auto"
              />
            </Link>
            <p className="text-sm text-[#64748B] leading-relaxed max-w-[230px] font-manrope">
              Ledger cívico de impacto: del relato a la evidencia defendible.
            </p>
          </div>

          {/* Producto */}
          <div>
            <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#475569] mb-4">
              Producto
            </p>
            <ul className="flex flex-col gap-2.5">
              {productLinks.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm text-[#94A3B8] hover:text-white transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Recursos */}
          <div>
            <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#475569] mb-4">
              Recursos
            </p>
            <ul className="flex flex-col gap-2.5">
              {resourceLinks.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm text-[#94A3B8] hover:text-white transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange">
                    {label}
                  </a>
                </li>
              ))}
              <li>
                <Link
                  href="/demo"
                  className="btn-premium inline-flex items-center gap-1.5 rounded-md bg-uellix-orange px-3 py-1.5 text-xs font-semibold text-white hover:bg-uellix-orange-strong mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange"
                >
                  Solicitar demo
                </Link>
              </li>
            </ul>
          </div>

          {/* Empresa */}
          <div>
            <p className="font-ibm-plex-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#475569] mb-4">
              Empresa
            </p>
            <ul className="flex flex-col gap-2.5">
              {companyLinks.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm text-[#94A3B8] hover:text-white transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-white/8 mb-6" />

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-[#475569] font-manrope">
            &copy; {new Date().getFullYear()} Uellix · The Balance Corp. Todos los derechos reservados.
          </p>
          <p className="font-ibm-plex-mono text-[11px] text-[#475569] tracking-[0.1em] uppercase">
            audit-ready · trazable · defendible
          </p>
        </div>
      </div>
    </footer>
  )
}
