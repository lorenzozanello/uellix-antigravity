import React from "react";
import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col justify-center items-center px-4 py-20 text-center relative overflow-hidden bg-slate-950">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,#1e293b,transparent_60%)] z-0" />
      <div className="relative z-10 max-w-4xl mx-auto flex flex-col items-center">
        <span className="inline-flex items-center rounded-full bg-teal-500/10 px-3 py-1 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20 mb-6">
          SaaS B2B de Inteligencia de Impacto
        </span>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl text-white mb-6 leading-none">
          Uellix convierte el impacto social en{" "}
          <span className="bg-gradient-to-r from-teal-400 via-cyan-400 to-blue-500 bg-clip-text text-transparent">
            evidencia defendible
          </span>
        </h1>
        <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mb-10">
          Uellix no es un certificador automático. Es una infraestructura metodológica y de trazabilidad que estructura narrativas, evidencias hasheadas y proxies financieros oficiales en un rastro SROI transparente y audit-ready.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link
            href="/login"
            className="rounded-md bg-teal-500 px-6 py-3 text-base font-semibold text-slate-950 shadow-sm hover:bg-teal-400 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 w-full sm:w-auto"
          >
            Iniciar análisis SROI
          </Link>
          <Link
            href="/login"
            className="rounded-md bg-slate-900 border border-slate-800 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-slate-800 transition-all w-full sm:w-auto"
          >
            Ver demo
          </Link>
        </div>
      </div>
    </div>
  );
}
