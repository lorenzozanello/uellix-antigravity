import React from "react"
import Link from "next/link"

const productLinks = [
  { label: "Plataforma",   href: "#producto" },
  { label: "Metodología",  href: "#metodologia" },
  { label: "Trust Center", href: "#confianza" },
  { label: "Stella",       href: "#stella" },
]

const resourceLinks = [
  { label: "Casos de uso",        href: "#casos" },
  { label: "Preguntas frecuentes", href: "#faq" },
]

const companyLinks = [
  { label: "Sobre Uellix", href: "mailto:hola@uellix.com" },
  { label: "Contacto",     href: "mailto:hola@uellix.com" },
  { label: "Privacidad",   href: "/privacidad" },
  { label: "Términos",     href: "/terminos" },
]

export function Footer() {
  return (
    <footer
      className="bg-[#0F172A] px-4 pt-16 pb-8"
      aria-label="Pie de página"
    >
      <div className="mx-auto max-w-7xl">

        {/* Top: logo + columns */}
        <div className="grid grid-cols-2 gap-8 lg:grid-cols-4 mb-12">

          {/* Brand column */}
          <div className="col-span-2 lg:col-span-1">
            <Link href="/" className="mb-4 w-fit inline-block hover:opacity-80 transition-opacity duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]" aria-label="Uellix — Inicio">
              <img
                src="/brand/uellix-logo-horizontal-reversed.svg"
                alt="Uellix"
                width="120"
                height="30"
                className="h-8 w-auto"
              />
            </Link>
            <p className="text-sm text-[#475569] leading-relaxed max-w-[220px]">
              Ledger cívico de relatos a valor defendible.
            </p>
          </div>

          {/* Producto */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#475569] mb-4 font-sora">
              Producto
            </p>
            <ul className="flex flex-col gap-2.5">
              {productLinks.map(({ label, href }) => (
                <li key={label}>
                  <a
                    href={href}
                    className="text-sm text-[#64748B] hover:text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Recursos */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#475569] mb-4 font-sora">
              Recursos
            </p>
            <ul className="flex flex-col gap-2.5">
              {resourceLinks.map(({ label, href }) => (
                <li key={label}>
                  <a
                    href={href}
                    className="text-sm text-[#64748B] hover:text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
                  >
                    {label}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href="mailto:hola@uellix.com?subject=Solicitar%20demo"
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#FF6A00] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#e05e00] transition-colors duration-150 mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
                >
                  Solicitar demo
                </a>
              </li>
            </ul>
          </div>

          {/* Empresa */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#475569] mb-4 font-sora">
              Empresa
            </p>
            <ul className="flex flex-col gap-2.5">
              {companyLinks.map(({ label, href }) => (
                <li key={label}>
                  <a
                    href={href}
                    className="text-sm text-[#64748B] hover:text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-[#1E293B] mb-6" />

        {/* Bottom bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-[#334155]">
            &copy; {new Date().getFullYear()} Uellix. Todos los derechos reservados.
          </p>
          <p className="font-ibm-plex-mono text-[11px] text-[#334155] tracking-wide">
            audit-ready · trazable · defendible
          </p>
        </div>
      </div>
    </footer>
  )
}
