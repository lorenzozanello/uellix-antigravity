"use client"

import React, { useState, useEffect } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

const navLinks = [
  { label: "Plataforma", href: "#producto" },
  { label: "Método",     href: "#metodologia" },
  { label: "Stella",     href: "#stella" },
  { label: "Confianza",  href: "#confianza" },
]

export function Navbar() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20)
    }
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <header
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        scrolled
          ? "bg-[#0A101E]/70 backdrop-blur-xl border-b border-white/10 shadow-lg shadow-black/20 py-2"
          : "bg-transparent py-4"
      }`}
      role="banner"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-6">

          {/* Logo */}
          <Link
            href="/"
            className="shrink-0 group transition-all duration-300 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange relative"
            aria-label="Uellix — Inicio"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/uellix-logo-horizontal.svg"
              alt="Uellix"
              width="120"
              height="30"
              className="h-8 w-auto brightness-0 invert opacity-90 transition-opacity group-hover:opacity-100"
            />
          </Link>

          {/* Desktop nav links */}
          <nav
            aria-label="Navegación principal"
            className="hidden lg:flex items-center bg-white/5 border border-white/10 rounded-full px-2 py-1.5 backdrop-blur-md"
          >
            {navLinks.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                className="px-4 py-1.5 text-sm font-medium text-slate-300 hover:text-white hover:bg-white/10 rounded-full transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange"
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Desktop actions */}
          <div className="hidden lg:flex items-center gap-4 shrink-0">
            <Link
              href="/login"
              className="text-sm font-medium text-slate-300 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange"
            >
              Iniciar sesión
            </Link>
            <Link
              href="/demo"
              className="group relative inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-uellix-orange to-[#FF8C33] px-5 py-2 text-sm font-bold text-white overflow-hidden shadow-[0_0_20px_rgba(252,76,13,0.3)] hover:shadow-[0_0_30px_rgba(252,76,13,0.5)] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange min-h-[36px]"
            >
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
              <span className="relative">Solicitar demo</span>
            </Link>
          </div>

          {/* Mobile menu button */}
          <button
            type="button"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen(!open)}
            className="lg:hidden flex items-center justify-center h-10 w-10 rounded-full bg-white/5 border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange"
          >
            {open
              ? <X className="h-5 w-5" aria-hidden="true" />
              : <Menu className="h-5 w-5" aria-hidden="true" />
            }
          </button>
        </div>
      </div>

      {/* Mobile menu panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="lg:hidden border-t border-white/10 bg-[#0A101E]/95 backdrop-blur-2xl overflow-hidden"
          >
            <div
              id="mobile-menu"
              role="dialog"
              aria-modal="true"
              aria-label="Menú de navegación"
            >
              <nav aria-label="Navegación móvil" className="flex flex-col px-4 py-6 gap-2">
                {navLinks.map(({ label, href }) => (
                  <a
                    key={label}
                    href={href}
                    onClick={() => setOpen(false)}
                    className="flex items-center px-4 py-3 text-lg font-medium text-slate-300 hover:text-white hover:bg-white/5 rounded-xl transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange min-h-[44px]"
                  >
                    {label}
                  </a>
                ))}
              </nav>
              <div className="px-6 pb-8 flex flex-col gap-4">
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-center px-4 py-3 text-base font-medium text-slate-300 hover:text-white bg-white/5 border border-white/10 hover:bg-white/10 rounded-xl transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange min-h-[44px]"
                >
                  Iniciar sesión
                </Link>
                <Link
                  href="/demo"
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-uellix-orange to-[#FF8C33] px-4 py-3 text-base font-bold text-white shadow-[0_0_20px_rgba(252,76,13,0.3)] min-h-[44px]"
                >
                  Solicitar demo
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
