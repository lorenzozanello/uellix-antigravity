"use client"

import React, { useState, useEffect } from "react"

const sections = [
  { id: "inicio",      label: "Inicio" },
  { id: "desafio",     label: "El problema" },
  { id: "producto",    label: "Plataforma" },
  { id: "metodologia", label: "Metodología" },
  { id: "confianza",   label: "Confianza" },
  { id: "stella",      label: "Stella" },
  { id: "casos",       label: "Casos" },
  { id: "faq",         label: "FAQ" },
  { id: "demo",        label: "Demo" },
]

export function NavigationProgress() {
  const [active, setActive] = useState("inicio")

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id)
          }
        }
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0 }
    )
    sections.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [])

  return (
    <nav
      aria-label="Progreso de sección"
      className="hidden xl:flex fixed right-5 top-1/2 -translate-y-1/2 z-40 flex-col gap-2.5"
    >
      {sections.map(({ id, label }) => {
        const isActive = active === id
        return (
          <a
            key={id}
            href={`#${id}`}
            tabIndex={-1}
            aria-label={label}
            className="group flex items-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange rounded-sm"
          >
            <span
              className={`rounded-full transition-all duration-200 ${
                isActive
                  ? "h-2 w-2 bg-uellix-orange scale-110"
                  : "h-1.5 w-1.5 bg-[#CBD5E1] group-hover:bg-[#64748B]"
              }`}
            />
            <span
              className={`text-[10px] font-medium font-manrope transition-all duration-200 whitespace-nowrap ${
                isActive
                  ? "text-uellix-orange opacity-100 translate-x-0"
                  : "text-[#94A3B8] opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0"
              }`}
            >
              {label}
            </span>
          </a>
        )
      })}
    </nav>
  )
}
