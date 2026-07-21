"use client"

import React, { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Calculator, ArrowRight, CheckCircle2 } from 'lucide-react'

export function SroiDemoCalculator() {
  const [investment, setInvestment] = useState(50000)
  const [beneficiaries, setBeneficiaries] = useState(500)
  const [proxyValue, setProxyValue] = useState(200)

  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const sroiRatio = useMemo(() => {
    const grossValue = beneficiaries * proxyValue
    const ratio = grossValue / investment
    return ratio.toFixed(2)
  }, [investment, beneficiaries, proxyValue])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const response = await fetch('/api/marketing/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          sroiResult: sroiRatio,
          source: 'sroi_demo_calculator'
        })
      })

      if (!response.ok) {
        throw new Error(`Lead request failed with status ${response.status}`)
      }

      setIsSuccess(true)
    } catch {
      setSubmitError('No pudimos registrar tu solicitud. Intenta nuevamente.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto rounded-3xl bg-[#0F172A]/80 backdrop-blur-2xl border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)] overflow-hidden">
      <div className="grid md:grid-cols-2">
        {/* Left: Inputs */}
        <div className="p-8 md:p-10 border-b md:border-b-0 md:border-r border-white/10">
          <div className="flex items-center gap-3 mb-8">
            <div className="p-2.5 bg-uellix-orange/20 rounded-xl">
              <Calculator className="w-6 h-6 text-uellix-orange" />
            </div>
            <h3 className="text-xl font-bold text-white font-sora">Calculadora SROI</h3>
          </div>

          <div className="space-y-8">
            {/* Slider 1 */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-slate-400">Inversión Estimada (USD)</label>
                <span className="text-sm font-bold text-white">${investment.toLocaleString()}</span>
              </div>
              <input
                type="range" min="10000" max="1000000" step="5000"
                value={investment} onChange={e => setInvestment(Number(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-uellix-orange"
              />
            </div>

            {/* Slider 2 */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-slate-400">Personas Beneficiadas</label>
                <span className="text-sm font-bold text-white">{beneficiaries.toLocaleString()}</span>
              </div>
              <input
                type="range" min="10" max="100000" step="10"
                value={beneficiaries} onChange={e => setBeneficiaries(Number(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-uellix-orange"
              />
            </div>

            {/* Slider 3 */}
            <div>
              <div className="flex justify-between mb-2">
                <label className="text-sm font-medium text-slate-400">Valor Proxy Promedio (USD)</label>
                <span className="text-sm font-bold text-white">${proxyValue.toLocaleString()}</span>
              </div>
              <input
                type="range" min="50" max="5000" step="50"
                value={proxyValue} onChange={e => setProxyValue(Number(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-uellix-orange"
              />
            </div>
          </div>
        </div>

        {/* Right: Results & Lead Form */}
        <div className="p-8 md:p-10 bg-[#0A101E]/50 flex flex-col justify-center">
          <div className="text-center mb-8">
            <p className="text-sm font-semibold text-uellix-orange uppercase tracking-widest mb-2 font-ibm-plex-mono">Ratio SROI Proyectado</p>
            <motion.div
              key={sroiRatio}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-6xl font-black text-white font-sora"
            >
              {sroiRatio}:1
            </motion.div>
            <p className="text-sm text-slate-400 mt-3">Por cada $1 invertido, se generan ${sroiRatio} en valor social.</p>
          </div>

          <AnimatePresence mode="wait">
            {!isSuccess ? (
              <motion.form
                key="form"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onSubmit={handleSubmit}
                className="space-y-4"
              >
                <input
                  type="email" required placeholder="Tu correo corporativo"
                  value={email} onChange={e => setEmail(e.target.value)}
                  className="w-full bg-[#0F172A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-slate-500 focus:outline-none focus:border-uellix-orange/50 focus:ring-1 focus:ring-uellix-orange/50 transition-colors"
                />
                <button
                  type="submit" disabled={isSubmitting}
                  className="w-full flex items-center justify-center gap-2 bg-uellix-orange hover:bg-[#FF8C33] text-white font-bold rounded-xl px-4 py-3 transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Procesando...' : 'Obtener Análisis Completo'}
                  <ArrowRight className="w-4 h-4" />
                </button>
                {submitError ? (
                  <p role="alert" className="text-sm text-center text-red-300">
                    {submitError}
                  </p>
                ) : null}
                <p className="text-xs text-center text-slate-500">Recibe un template de reporte PDF audit-ready en tu correo.</p>
              </motion.form>
            ) : (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                className="bg-green-500/10 border border-green-500/20 rounded-xl p-6 text-center"
              >
                <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
                <h4 className="text-lg font-bold text-white mb-1">¡Solicitud recibida!</h4>
                <p className="text-sm text-slate-400">Te enviaremos el análisis completo y acceso a la plataforma en breve.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
