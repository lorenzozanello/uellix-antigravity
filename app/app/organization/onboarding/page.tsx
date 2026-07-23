'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { completeOnboarding } from '@/app/actions/onboarding'
import { Building, Globe, DollarSign, ArrowRight, Activity } from 'lucide-react'
import { getErrorMessage } from '@/lib/errors/get-error-message'

export default function OnboardingPage() {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError(null)

    try {
      const formData = new FormData(e.currentTarget)
      await completeOnboarding(formData)
      router.push('/app')
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Error completando el registro'))
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--uellix-paper)] flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-[#0F172A]/10 p-8 md:p-12">
        <div className="flex justify-center mb-6">
          <div className="h-12 w-12 rounded-xl bg-uellix-orange/10 flex items-center justify-center">
            <Activity className="h-6 w-6 text-uellix-orange" />
          </div>
        </div>

        <div className="text-center mb-10">
          <h1 className="text-2xl font-bold font-sora text-[#0F172A] mb-2">Bienvenido a Uellix</h1>
          <p className="text-[#475569] text-sm">Completa el perfil de tu organización para calibrar la Inteligencia de Impacto.</p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-[#0F172A] mb-2 flex items-center gap-2">
              <Globe className="w-4 h-4 text-slate-400" />
              País de Operación Principal
            </label>
            <select name="country" required className="w-full h-11 px-4 rounded-lg border border-slate-200 bg-white text-sm focus:border-uellix-orange focus:ring-1 focus:ring-uellix-orange outline-none transition-colors">
              <option value="">Selecciona un país...</option>
              <option value="MX">México</option>
              <option value="CO">Colombia</option>
              <option value="PE">Perú</option>
              <option value="CL">Chile</option>
              <option value="AR">Argentina</option>
              <option value="ES">España</option>
              <option value="US">Estados Unidos</option>
              <option value="ZZ">Otro</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-[#0F172A] mb-2 flex items-center gap-2">
              <Building className="w-4 h-4 text-slate-400" />
              Sector Principal
            </label>
            <select name="sector" required className="w-full h-11 px-4 rounded-lg border border-slate-200 bg-white text-sm focus:border-uellix-orange focus:ring-1 focus:ring-uellix-orange outline-none transition-colors">
              <option value="">Selecciona un sector...</option>
              <option value="Education">Educación</option>
              <option value="Health">Salud y Bienestar</option>
              <option value="Environment">Medio Ambiente y Clima</option>
              <option value="Economic_Development">Desarrollo Económico</option>
              <option value="Social_Justice">Justicia Social e Inclusión</option>
              <option value="Housing">Vivienda e Infraestructura</option>
              <option value="Technology">Tecnología para el Bien</option>
              <option value="Other">Otro</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-[#0F172A] mb-2 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-slate-400" />
              Moneda Base (para cálculos SROI)
            </label>
            <select name="baseCurrency" required className="w-full h-11 px-4 rounded-lg border border-slate-200 bg-white text-sm focus:border-uellix-orange focus:ring-1 focus:ring-uellix-orange outline-none transition-colors">
              <option value="">Selecciona una moneda...</option>
              <option value="USD">Dólares Estadounidenses (USD)</option>
              <option value="EUR">Euros (EUR)</option>
              <option value="MXN">Pesos Mexicanos (MXN)</option>
              <option value="COP">Pesos Colombianos (COP)</option>
              <option value="PEN">Soles Peruanos (PEN)</option>
              <option value="CLP">Pesos Chilenos (CLP)</option>
              <option value="ARS">Pesos Argentinos (ARS)</option>
            </select>
            <p className="text-xs text-slate-500 mt-2">La moneda base se utilizará como referencia principal en todos los reportes consolidados y proxies financieros.</p>
          </div>

          <div className="pt-4">
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 bg-[#0F172A] hover:bg-[#1E293B] text-white font-semibold h-11 rounded-lg transition-colors disabled:opacity-50"
            >
              {isSubmitting ? 'Configurando...' : 'Comenzar a usar Uellix'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
