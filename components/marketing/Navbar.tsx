"use client"

import React, { useState } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"

const navLinks = [
  { label: "Plataforma", href: "#producto" },
  { label: "Método",     href: "#metodologia" },
  { label: "Stella",     href: "#stella" },
  { label: "Confianza",  href: "#confianza" },
]

export function Navbar() {
  const [open, setOpen] = useState(false)

  return (
    <header
      className="sticky top-0 z-50 w-full bg-[var(--uellix-paper)]/85 backdrop-blur-xl border-b border-[#0F172A]/8"
      role="banner"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-6">

          {/* Logo */}
          <Link
            href="/"
            className="shrink-0 group transition-premium hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
            aria-label="Uellix — Inicio"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
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
                className="px-3.5 py-1.5 text-sm font-medium text-[#475569] hover:text-[#0F172A] hover:bg-[#0F172A]/5 rounded-md transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Desktop actions */}
          <div className="hidden lg:flex items-center gap-3 shrink-0">
            <Link
              href="/login"
              className="px-3 py-1.5 text-sm font-medium text-[#475569] hover:text-[#0F172A] rounded-md transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
            >
              Iniciar sesión
            </Link>
            <Link
              href="/demo"
              className="btn-premium inline-flex items-center gap-1.5 rounded-lg bg-[#FF6A00] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#e05e00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[36px] shadow-[0_1px_2px_rgba(15,23,42,0.12)]"
            >
              Solicitar demo
            </Link>
          </div>

          {/* Mobile menu button */}
          <button
            type="button"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen(!open)}
            className="lg:hidden flex items-center justify-center h-10 w-10 rounded-lg border border-[#0F172A]/10 text-[#475569] hover:text-[#0F172A] hover:bg-[#0F172A]/5 transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
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
          className="lg:hidden border-t border-[#0F172A]/8 bg-[var(--uellix-paper)]"
        >
          <nav aria-label="Navegación móvil" className="flex flex-col px-4 py-3 gap-0.5">
            {navLinks.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                onClick={() => setOpen(false)}
                className="flex items-center px-4 py-3 text-base font-medium text-[#0F172A] hover:bg-[#0F172A]/5 rounded-lg transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[44px]"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="px-4 pb-5 pt-3 flex flex-col gap-2.5 border-t border-[#0F172A]/8">
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center px-4 py-3 text-base font-medium text-[#475569] hover:text-[#0F172A] hover:bg-[#0F172A]/5 rounded-lg transition-premium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[44px]"
            >
              Iniciar sesión
            </Link>
            <Link
              href="/demo"
              onClick={() => setOpen(false)}
              className="btn-premium flex items-center justify-center gap-2 rounded-lg bg-[#FF6A00] px-4 py-3 text-base font-semibold text-white hover:bg-[#e05e00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] min-h-[44px]"
            >
              Solicitar demo
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
