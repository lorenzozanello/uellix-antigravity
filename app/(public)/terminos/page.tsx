import type { Metadata } from "next";

export const metadata: Metadata = {
  // Plain string → the root template ("%s | Uellix") appends the brand. Do NOT
  // repeat "Uellix" here or the title renders as "… · Uellix | Uellix".
  title: "Términos de Servicio",
  description:
    "Términos de Servicio de Uellix: condiciones de uso de la plataforma de inteligencia de impacto social audit-ready.",
  alternates: { canonical: "/terminos" },
  // Draft pending legal review (see on-page banner). Keep it reachable for users
  // but out of Google's index until it's a binding document. Flip to `index: true`
  // and re-add to app/sitemap.ts once legal signs off.
  robots: { index: false, follow: true },
};

export default function TerminosPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <div className="mb-4 rounded-md border border-[#FF6A00]/30 bg-[#FF6A00]/5 px-4 py-3 text-sm text-[#0F172A]">
        <strong className="font-semibold">Borrador pendiente de revisión legal.</strong>{" "}
        Este documento describe de buena fe las prácticas reales de la plataforma, pero
        todavía no fue revisado ni aprobado por un abogado. No debe considerarse
        vinculante hasta que el equipo de Uellix lo confirme.
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-[#0F172A] font-sora">
        Términos de Servicio
      </h1>
      <p className="mt-2 text-sm text-[#64748B]">
        Última actualización: [PENDIENTE — completar al publicar]
      </p>

      <div
        className="mt-10 max-w-none space-y-5 text-[15px] leading-relaxed text-[#334155]
          [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-sora [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[#0F172A] [&_h2]:first:mt-0
          [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1.5 [&_strong]:font-semibold [&_strong]:text-[#0F172A]
          [&_a]:text-[#FF6A00] [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-[#e05e00]"
      >
        <h2>1. Quiénes somos</h2>
        <p>
          Uellix es operado por [RAZÓN SOCIAL PENDIENTE — completar con la entidad legal
          registrada], en adelante &ldquo;Uellix&rdquo;, &ldquo;nosotros&rdquo; o
          &ldquo;la Plataforma&rdquo;. Estos Términos rigen el uso de la plataforma SaaS
          B2B de inteligencia de impacto social disponible en este sitio y sus
          aplicaciones asociadas.
        </p>

        <h2>2. Qué es Uellix</h2>
        <p>
          Uellix convierte narrativas, evidencias, indicadores, proxies financieros y
          cálculos de impacto social en un rastro SROI (Retorno Social de la Inversión)
          trazable, auditable y audit-ready.
        </p>
        <p>
          <strong>Uellix no certifica automáticamente el impacto social de ningún
          programa u organización.</strong> La Plataforma prepara, estructura, fortalece
          y documenta evidencia e indicadores de impacto para hacerlos trazables,
          verificables y defendibles ante terceros (financiadores, auditores,
          reguladores). La validación final de cualquier reporte de impacto sigue
          siendo responsabilidad humana de la organización usuaria.
        </p>
        <p>
          Uellix incluye una capa de inteligencia artificial (&ldquo;Stella&rdquo;) que
          actúa como asesora metodológica, validadora estructurada y redactora de
          borradores de narrativa. Stella no reemplaza la revisión humana, no aprueba
          proxies financieros de forma autónoma, no inventa fuentes o evidencias, y no
          emite dictámenes legales o de certificación.
        </p>

        <h2>3. Cuentas y acceso</h2>
        <ul>
          <li>
            Para usar Uellix necesitás crear una cuenta con un email válido y
            pertenecer a una organización dentro de la Plataforma (propia o por
            invitación).
          </li>
          <li>
            Sos responsable de mantener la confidencialidad de tus credenciales y de
            toda actividad que ocurra bajo tu cuenta.
          </li>
          <li>
            El acceso de autoservicio para crear organizaciones nuevas puede estar
            sujeto a un proceso de habilitación controlada por parte de Uellix.
          </li>
          <li>
            Los roles y permisos dentro de una organización (administrador, gestor de
            impacto, analista, revisor, solo lectura) determinan qué acciones puede
            realizar cada usuario; es responsabilidad del administrador de la
            organización asignarlos correctamente.
          </li>
        </ul>

        <h2>4. Datos y contenido que subís</h2>
        <p>
          Al usar Uellix, vos y tu organización mantienen la titularidad de todo el
          contenido que cargan a la Plataforma: narrativas, evidencias, indicadores,
          proxies, resultados de cálculo y reportes (&ldquo;Contenido del Cliente&rdquo;).
          Uellix no reclama propiedad sobre ese contenido.
        </p>
        <p>
          Nos otorgás una licencia limitada para almacenar, procesar y mostrar ese
          contenido únicamente con el fin de operar la Plataforma para vos y tu
          organización, incluyendo el procesamiento por parte de Stella cuando
          activás explícitamente esa funcionalidad.
        </p>
        <p>
          Sos responsable de contar con los derechos y consentimientos necesarios
          sobre cualquier evidencia, testimonio o dato personal de terceros
          (beneficiarios, encuestados) que subas a la Plataforma, y de aplicar las
          opciones de anonimización disponibles cuando corresponda.
        </p>

        <h2>5. Aislamiento entre organizaciones</h2>
        <p>
          Cada organización en Uellix opera en un espacio de datos aislado. El
          Contenido del Cliente de tu organización no es visible para otras
          organizaciones de la Plataforma, salvo los proxies financieros globales
          curados y aprobados por el equipo de Uellix, que están explícitamente
          diseñados para ser compartidos como referencia metodológica.
        </p>

        <h2>6. Uso aceptable</h2>
        <p>No podés usar Uellix para:</p>
        <ul>
          <li>Cargar evidencia falsa, fuentes inventadas o datos que sepas inexactos con el fin de inflar resultados de impacto.</li>
          <li>Presentar reportes generados en Uellix como una certificación oficial o garantía de impacto sin la debida revisión humana.</li>
          <li>Intentar acceder a datos de otra organización sin autorización.</li>
          <li>Sobrecargar, interferir o intentar comprometer la seguridad de la Plataforma.</li>
          <li>Usar la Plataforma en violación de cualquier ley aplicable.</li>
        </ul>

        <h2>7. Disponibilidad y cambios al servicio</h2>
        <p>
          Trabajamos para mantener la Plataforma disponible de forma continua, pero no
          garantizamos disponibilidad ininterrumpida. Podemos modificar, agregar o
          remover funcionalidades con el tiempo; cambios que afecten significativamente
          el uso habitual del servicio serán comunicados con antelación razonable
          cuando sea posible.
        </p>

        <h2>8. Terminación</h2>
        <p>
          Podés dejar de usar Uellix en cualquier momento. Nos reservamos el derecho de
          suspender o cancelar cuentas que violen estos Términos, con notificación
          previa salvo en casos de riesgo de seguridad. Al finalizar la relación, el
          Contenido del Cliente se conserva por un período razonable para permitir la
          exportación de datos, salvo obligación legal en contrario.
        </p>

        <h2>9. Limitación de responsabilidad</h2>
        <p>
          Uellix se provee &ldquo;tal cual&rdquo;. En la máxima medida permitida por la
          ley aplicable, Uellix no será responsable por decisiones de negocio,
          financiamiento o cumplimiento que tu organización tome con base en los
          reportes generados en la Plataforma, incluyendo sugerencias generadas por
          Stella. La validación final de cualquier afirmación de impacto es
          responsabilidad de la organización usuaria.
        </p>

        <h2>10. Ley aplicable</h2>
        <p>
          [PENDIENTE — definir jurisdicción y legislación aplicable con asesoría
          legal antes de publicar].
        </p>

        <h2>11. Contacto</h2>
        <p>
          Preguntas sobre estos Términos: <a href="mailto:hola@uellix.com">hola@uellix.com</a>.
        </p>
      </div>
    </div>
  );
}
