import React from 'react'

export const metadata = {
  title: 'Política de Privacidad | Uellix',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--uellix-carbon)] py-20 px-4">
      <div className="max-w-3xl mx-auto bg-[#0F172A]/50 border border-[#1E293B] rounded-2xl p-8 md:p-12 shadow-xl backdrop-blur-sm prose prose-invert prose-orange">
        <h1 className="text-3xl font-bold font-sora text-white mb-2">Política de Privacidad y DPA</h1>
        <p className="text-slate-400 text-sm mb-8">Última actualización: {new Date().toLocaleDateString('es-MX')}</p>

        <div className="space-y-6 text-slate-300">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Compromiso de Cero Retención para IA (Zero Data Retention)</h2>
            <p>
              Uellix (The Balance Corp) emplea modelos fundacionales de IA (como Stella AI). Garantizamos contractualmente que los
              datos privados de su organización, proyectos y métricas financieras <strong>no serán utilizados</strong> para entrenar
              modelos base públicos ni compartidos con proveedores externos de LLM para su aprendizaje.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Recopilación de Datos Funcionales</h2>
            <p>
              Recopilamos exclusivamente los datos necesarios para la prestación del servicio: información de perfiles corporativos,
              métricas de impacto ingresadas en la plataforma, y telemetría anónima de rendimiento de la aplicación.
              No utilizamos cookies de rastreo para publicidad cruzada; limitamos el uso de cookies a sesiones autenticadas y seguridad.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Data Processing Agreement (DPA)</h2>
            <p>
              Esta política sirve como Acuerdo de Procesamiento de Datos (DPA) inicial. The Balance Corp actúa como Procesador de
              los datos ingresados en la plataforma, mientras que su Organización actúa como Controlador. Aseguramos el cifrado en
              tránsito y en reposo (AES-256) en toda nuestra infraestructura gestionada.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Telemetría y Monitoreo de Errores</h2>
            <p>
              Para garantizar la estabilidad y rendimiento del sistema, utilizamos herramientas de observabilidad que pueden
              capturar contexto técnico durante errores del sistema (excluyendo datos sensibles de usuario PII).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Contacto Legal</h2>
            <p>
              Para consultas relacionadas con protección de datos institucionales o solicitudes de auditoría, contacte a nuestro
              oficial de privacidad en <strong>privacy@uellix.com</strong>.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
