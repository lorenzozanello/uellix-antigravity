import React from 'react'

export const metadata = {
  title: 'Términos de Servicio | Uellix',
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[var(--uellix-carbon)] py-20 px-4">
      <div className="max-w-3xl mx-auto bg-[#0F172A]/50 border border-[#1E293B] rounded-2xl p-8 md:p-12 shadow-xl backdrop-blur-sm prose prose-invert prose-orange">
        <h1 className="text-3xl font-bold font-sora text-white mb-2">Términos de Servicio</h1>
        <p className="text-slate-400 text-sm mb-8">Última actualización: {new Date().toLocaleDateString('es-MX')}</p>

        <div className="space-y-6 text-slate-300">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Aceptación de los Términos</h2>
            <p>
              Al acceder y utilizar Uellix (operado por The Balance Corp), usted acepta estar sujeto a estos Términos de Servicio.
              Si actúa en nombre de una organización, declara que tiene la autoridad legal para vincular a dicha organización a estos términos.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Plataforma SROI y Stella AI</h2>
            <p>
              Uellix proporciona herramientas para calcular el Retorno Social de la Inversión (SROI) utilizando algoritmos e inteligencia artificial (Stella AI).
              <strong>Renuncia de Responsabilidad:</strong> Los resultados generados, incluyendo multiplicadores SROI y asignaciones de proxies,
              son estimaciones basadas en los datos proporcionados por el usuario y nuestros repositorios de proxies. No constituyen asesoramiento financiero,
              legal o de auditoría formal. The Balance Corp no garantiza la exactitud absoluta de las predicciones de impacto.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Datos de la Organización</h2>
            <p>
              Usted retiene todos los derechos sobre los datos de impacto que ingrese en Uellix. Al utilizar nuestro servicio, otorga a Uellix
              una licencia limitada para procesar estos datos con el fin exclusivo de prestar el servicio.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Uso Aceptable y Rate Limiting</h2>
            <p>
              Está prohibido el uso de medios automatizados, scraping, o cualquier acción que imponga una carga irrazonable en nuestra infraestructura
              o en la API de Stella AI. The Balance Corp se reserva el derecho de limitar temporal o permanentemente el acceso (Rate Limiting) para
              proteger la estabilidad de la plataforma corporativa.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Auditorías e Inmutabilidad</h2>
            <p>
              Los reportes exportados y sellados con un hash de auditoría son inmutables. The Balance Corp no modificará los registros históricos
              una vez cerrados los periodos de reporte. Los enlaces públicos de auditoría son de solo lectura y su distribución es responsabilidad de la organización.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
