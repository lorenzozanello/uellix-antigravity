"use client"

import React, { useState } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"

const navLinks = [
  { label: "Producto",     href: "#producto" },
  { label: "Metodología",  href: "#metodologia" },
  { label: "Casos de uso", href: "#casos" },
  { label: "Recursos",     href: "#faq" },
  { label: "Sobre Uellix", href: "mailto:hola@uellix.com" },
]

export function Navbar() {
  const [open, setOpen] = useState(false)

  return (
    <header
      className="sticky top-0 z-50 w-full bg-[#FBFAFC]/95 backdrop-blur-md border-b border-[#E2E8F0]"
      role="banner"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-6">

          {/* Logo */}
          <Link
            href="/"
            className="shrink-0 group hover:opacity-80 transition-opacity duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
            aria-label="Uellix — Inicio"
          >
            <img
              src="/brand/uellix-logo-horizontal.svg"
              alt="Uellix"
              width="120"
              height="30"
              className="h-8 w-auto"
            />
          </Link>

          {/* Desktop nav links */}
          <nav
            aria-label="Navegación principal"
            className="hidden lg:flex items-center gap-0.5"
          >
            {navLinks.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                className="px-3.5 py-1.5 text-sm font-medium text-[#64748B] hover:text-[#0F172A] hover:bg-[#E2E8F0]/60 rounded-md transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Desktop actions */}
          <div className="hidden lg:flex items-center gap-3 shrink-0">
            <Link
              href="/login"
              className="px-3 py-1.5 text-sm font-medium text-[#64748B] hover:text-[#0F172A] rounded-md transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
            >
              Iniciar sesión
            </Link>
            <a
              href="mailto:hola@uellix.com?subject=Solicitud%20de%20demo"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#FF6A00] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#e05e00] active:bg-[#cc5500] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] transition-colors duration-150 min-h-[36px]"
            >
              Solicitar demo
            </a>
          </div>

          {/* Mobile menu button */}
          <button
            type="button"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen(!open)}
            className="lg:hidden flex items-center justify-center h-10 w-10 rounded-lg border border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A] hover:bg-[#E2E8F0]/60 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
          >
            {open
              ? <X className="h-5 w-5" aria-hidden="true" />
              : <Menu className="h-5 w-5" aria-hidden="true" />
            }
          </button>
        </div>
      </div>

      {/* Mobile menu panel */}
      {open && (
        <div
          id="mobile-menu"
          role="dialog"
          aria-modal="false"
          aria-label="Menú de navegación"
          className="lg:hidden border-t border-[#E2E8F0] bg-[#FBFAFC]"
        >
          <nav aria-label="Navegación móvil" className="flex flex-col px-4 py-3 gap-0.5">
            {navLinks.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                onClick={() => setOpen(false)}
                className="flex items-center px-4 py-3 text-base font-medium text-[#0F172A] hover:bg-[#E2E8F0]/60 rounded-lg transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[44px]"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="px-4 pb-5 pt-3 flex flex-col gap-2.5 border-t border-[#E2E8F0]">
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center px-4 py-3 text-base font-medium text-[#64748B] hover:text-[#0F172A] hover:bg-[#E2E8F0]/60 rounded-lg transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[44px]"
            >
              Iniciar sesión
            </Link>
            <a
              href="mailto:hola@uellix.com?subject=Solicitud%20de%20demo"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-2 rounded-lg bg-[#FF6A00] px-4 py-3 text-base font-semibold text-white hover:bg-[#e05e00] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[44px]"
            >
              Solicitar demo
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
