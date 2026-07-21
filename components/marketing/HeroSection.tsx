"use client"

import React from "react"
import Link from "next/link"
import { ArrowRight, Activity, ShieldCheck, Zap } from "lucide-react"
import { motion } from "framer-motion"

export function HeroSection() {
  return (
    <section
      id="inicio"
      aria-label="Sección principal"
      className="relative overflow-hidden bg-[#0A101E] px-4 pt-32 pb-20 sm:pt-40 sm:pb-28 lg:pt-48 lg:pb-36 min-h-screen flex items-center"
    >
      {/* Background glow effects */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] bg-uellix-orange/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-600/10 blur-[100px] rounded-full pointer-events-none" />

      {/* Grid pattern */}
      <div className="absolute inset-0 bg-[url('/grid.svg')] bg-center opacity-[0.05] [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))]" />

      <div className="relative z-10 mx-auto max-w-5xl text-center">

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex justify-center mb-8"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-uellix-orange/30 bg-uellix-orange/10 px-4 py-2 text-xs font-semibold text-[#FF8C33] font-ibm-plex-mono tracking-widest uppercase shadow-[0_0_15px_rgba(255,106,0,0.2)]">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-uellix-orange opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-uellix-orange"></span>
            </span>
            Ledger Cívico de Impacto
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="font-sora font-extrabold tracking-tight text-white mb-8 text-[clamp(3rem,8vw,5.5rem)] leading-[1.05]"
        >
          Convierte el impacto social en{" "}
          <br className="hidden md:block" />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-uellix-orange to-[#FFB067] relative inline-block">
            evidencia defendible.
            {/* Underline glow */}
            <span className="absolute -bottom-2 left-0 w-full h-1 bg-gradient-to-r from-uellix-orange/0 via-uellix-orange to-uellix-orange/0 blur-sm" />
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="font-manrope text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-12 leading-relaxed"
        >
          Uellix estructura proyectos, conecta evidencias, documenta proxies SROI y genera reportes <strong className="text-white font-semibold">audit-ready</strong> preparados para revisión externa.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="flex flex-col sm:flex-row gap-4 items-center justify-center w-full"
        >
          <Link
            href="/demo"
            className="group relative inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-uellix-orange to-[#FF8C33] px-8 py-4 text-lg font-bold text-white overflow-hidden shadow-[0_0_30px_rgba(255,106,0,0.4)] hover:shadow-[0_0_50px_rgba(255,106,0,0.6)] transition-all w-full sm:w-auto"
          >
            <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
            <span className="relative flex items-center gap-2">
              Solicitar demo interactiva
              <ArrowRight className="h-5 w-5 group-hover:translate-x-1 transition-transform" />
            </span>
          </Link>

          <a
            href="#metodologia"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 backdrop-blur-md px-8 py-4 text-lg font-semibold text-white hover:bg-white/10 hover:border-white/30 transition-all w-full sm:w-auto"
          >
            Ver metodología
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.8 }}
          className="mt-16 pt-8 border-t border-white/10 flex flex-col md:flex-row justify-center items-center gap-8 md:gap-16 text-sm text-slate-400 font-medium"
        >
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#FFB067]" />
            Cálculo SROI en tiempo real
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#FFB067]" />
            Trazabilidad Audit-Ready
          </div>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-[#FFB067]" />
            Revisión IA con Stella
          </div>
        </motion.div>

      </div>
    </section>
  )
}
