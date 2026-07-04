"use client"

import React, { useState } from "react"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import { submitDemoRequest } from "@/app/actions/marketing/demo-request"

type FormState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success" }
  | { status: "error"; message: string }

const inputClass =
  "w-full rounded-lg border border-[#0F172A]/12 bg-white/80 px-4 py-3 text-sm text-[#0F172A] placeholder:text-[#5B6472] transition-premium focus:outline-none focus:border-uellix-orange/50 focus:ring-2 focus:ring-uellix-orange/15 font-manrope"

export function DemoRequestForm() {
  const [state, setState] = useState<FormState>({ status: "idle" })

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState({ status: "loading" })

    const formData = new FormData(event.currentTarget)
    const result = await submitDemoRequest({
      name: String(formData.get("name") ?? ""),
      organization: String(formData.get("organization") ?? ""),
      email: String(formData.get("email") ?? ""),
      message: String(formData.get("message") ?? ""),
      website: String(formData.get("website") ?? ""),
    })

    if (result.ok) {
      setState({ status: "success" })
    } else {
      setState({ status: "error", message: result.error })
    }
  }

  if (state.status === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 flex flex-col items-center text-center gap-3"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 border border-emerald-200">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" aria-hidden="true" />
        </span>
        <p className="font-sora text-lg font-semibold text-[#0F172A]">Solicitud enviada</p>
        <p className="text-sm text-[#475569] leading-relaxed font-manrope max-w-sm">
          Gracias por tu interés. Nuestro equipo te va a contactar en las próximas 24-48 horas hábiles.
        </p>
      </div>
    )
  }

  const isLoading = state.status === "loading"

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
      {/* Honeypot — visually hidden, never reached by keyboard/screen reader users */}
      <div aria-hidden="true" className="absolute left-[-9999px] w-px h-px overflow-hidden">
        <label htmlFor="website">No completar este campo</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div>
        <label htmlFor="name" className="block text-xs font-semibold text-[#0F172A] mb-1.5 font-manrope">
          Nombre
        </label>
        <input id="name" name="name" type="text" required maxLength={200} className={inputClass} placeholder="Tu nombre completo" />
      </div>

      <div>
        <label htmlFor="organization" className="block text-xs font-semibold text-[#0F172A] mb-1.5 font-manrope">
          Organización
        </label>
        <input id="organization" name="organization" type="text" required maxLength={200} className={inputClass} placeholder="Fundación, empresa, universidad…" />
      </div>

      <div>
        <label htmlFor="email" className="block text-xs font-semibold text-[#0F172A] mb-1.5 font-manrope">
          Email
        </label>
        <input id="email" name="email" type="email" required maxLength={320} className={inputClass} placeholder="tu@organizacion.org" />
      </div>

      <div>
        <label htmlFor="message" className="block text-xs font-semibold text-[#0F172A] mb-1.5 font-manrope">
          Contanos brevemente tu caso <span className="text-[#5B6472] font-normal">(opcional)</span>
        </label>
        <textarea id="message" name="message" rows={4} maxLength={2000} className={inputClass} placeholder="¿Qué proyecto o programa querés medir?" />
      </div>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 font-manrope">
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="btn-premium inline-flex items-center justify-center gap-2 rounded-lg bg-uellix-orange px-7 py-3.5 text-base font-semibold text-white hover:bg-uellix-orange-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-uellix-orange min-h-[48px] disabled:opacity-60 disabled:cursor-not-allowed shadow-[0_6px_20px_-6px_rgba(255,106,0,0.55)]"
      >
        {isLoading ? "Enviando…" : "Enviar solicitud"}
        {!isLoading && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
      </button>
    </form>
  )
}
