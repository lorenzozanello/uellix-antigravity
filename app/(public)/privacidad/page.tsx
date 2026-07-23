import type { Metadata } from "next";

export const metadata: Metadata = {
  // Plain string → the root template ("%s | Uellix") appends the brand. Do NOT
  // repeat "Uellix" here or the title renders as "… · Uellix | Uellix".
  title: "Política de Privacidad",
  description:
    "Política de Privacidad de Uellix: cómo la plataforma trata y protege los datos de cada organización.",
  alternates: { canonical: "/privacidad" },
  // Draft pending legal review (see on-page banner). Keep it reachable for users
  // but out of Google's index until it's a binding document. Flip to `index: true`
  // and re-add to app/sitemap.ts once legal signs off.
  robots: { index: false, follow: true },
};

export default function PrivacidadPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <div className="mb-4 rounded-md border border-[#fc4c0d]/30 bg-[#fc4c0d]/5 px-4 py-3 text-sm text-[#0F172A]">
        <strong className="font-semibold">Borrador pendiente de revisión legal.</strong>{" "}
        Este documento describe de buena fe cómo maneja datos la plataforma hoy, pero
        todavía no fue revisado ni aprobado por un abogado especializado en protección
        de datos. No debe considerarse vinculante hasta que el equipo de Uellix lo
        confirme.
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-[#0F172A] font-sora">
        Política de Privacidad
      </h1>
      <p className="mt-2 text-sm text-[#64748B]">
        Última actualización: [PENDIENTE — completar al publicar]
      </p>

      <div
        className="mt-10 max-w-none space-y-5 text-[15px] leading-relaxed text-[#334155]
          [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-sora [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[#0F172A] [&_h2]:first:mt-0
          [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1.5 [&_strong]:font-semibold [&_strong]:text-[#0F172A]
          [&_a]:text-[#fc4c0d] [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-[#db420b]"
      >
        <h2>1. Quiénes somos</h2>
        <p>
          Esta política describe cómo [RAZÓN SOCIAL PENDIENTE] (&ldquo;Uellix&rdquo;)
          recolecta, usa y protege los datos que procesa a través de la plataforma
          Uellix.
        </p>

        <h2>2. Qué datos recolectamos</h2>
        <p><strong>Datos de cuenta:</strong> email, nombre, y los datos de la organización a la que pertenecés (nombre, razón social, país, sector).</p>
        <p><strong>Contenido del Cliente:</strong> narrativas, evidencias (PDF, Excel, CSV, imágenes, Word, enlaces, texto/testimonios, actas), indicadores, proxies financieros y resultados de cálculo SROI que vos o tu organización cargan a la Plataforma.</p>
        <p><strong>Metadatos de evidencia:</strong> cada archivo de evidencia se procesa con un hash criptográfico (SHA-256) para garantizar su integridad, además de metadatos de quién lo cargó, cuándo, y su estado de revisión.</p>
        <p><strong>Registros de auditoría:</strong> quedan registrados los cambios metodológicos relevantes (creación de proxies, cambios de estado de evidencia, ajustes de parámetros de cálculo) con el usuario y la fecha correspondiente, con fines de trazabilidad y auditoría — no se pueden editar ni eliminar retroactivamente.</p>
        <p><strong>Interacciones con Stella:</strong> cuando usás las funciones de asesor, validador o compositor de Stella, se registra la interacción (rol de Stella, paso del pipeline, respuesta generada) para mantener el rastro de auditoría exigido por la metodología SROI.</p>

        <h2>3. Cómo usamos tus datos</h2>
        <ul>
          <li>Para operar la Plataforma: autenticación, aislamiento de datos por organización, cálculo del SROI, generación de reportes.</li>
          <li>Para las funciones de Stella, cuando las activás explícitamente.</li>
          <li>Para enviarte correos operativos: invitaciones a una organización, recuperación de contraseña, notificaciones relacionadas con tu cuenta.</li>
          <li>Para seguridad: límites de tasa (rate limiting) en acciones sensibles como inicio de sesión, y registros de auditoría append-only.</li>
        </ul>
        <p>No usamos tus datos para publicidad ni los vendemos a terceros.</p>

        <h2>4. Con quién compartimos datos</h2>
        <p>
          Uellix se apoya en proveedores de infraestructura para operar. Estos
          proveedores procesan datos en nuestro nombre bajo sus propios acuerdos de
          procesamiento de datos, no como terceros independientes:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — hosting de base de datos, autenticación y
            almacenamiento de archivos de evidencia. Aplica Row Level Security (RLS) a
            nivel de base de datos como capa adicional de aislamiento entre
            organizaciones.
          </li>
          <li>
            <strong>Google (Gemini API)</strong> — motor de IA detrás de Stella. Antes
            de enviar cualquier texto al modelo, la Plataforma excluye explícitamente
            rutas de archivo, contenido completo de evidencia y valores crudos de
            proxies financieros del contexto enviado, y filtra automáticamente
            patrones que parezcan credenciales, contraseñas o claves de API. Stella
            solo recibe el contexto mínimo necesario del proyecto (narrativas,
            resúmenes de indicadores/outcomes) para poder asesorar o validar.
          </li>
          <li>
            <strong>Resend</strong> — envío de correos transaccionales (invitaciones,
            recuperación de contraseña).
          </li>
        </ul>
        <p>
          No compartimos Contenido del Cliente con otras organizaciones de la
          Plataforma, salvo los proxies financieros globales que tu organización
          decida enviar para revisión y aprobación por el equipo de Uellix como
          referencia metodológica compartida.
        </p>

        <h2>5. Aislamiento y seguridad</h2>
        <ul>
          <li>Cada organización tiene su espacio de datos aislado, verificado tanto a nivel de aplicación como de base de datos (RLS).</li>
          <li>Los roles y permisos dentro de tu organización controlan quién puede ver o modificar qué información.</li>
          <li>La evidencia cargada se verifica con hash SHA-256 para garantizar que no fue alterada.</li>
          <li>Los registros de auditoría son de solo-agregado (append-only): no se pueden modificar ni borrar retroactivamente.</li>
        </ul>

        <h2>6. Cookies y sesión</h2>
        <p>
          Usamos cookies estrictamente necesarias para mantener tu sesión iniciada,
          gestionadas por nuestro proveedor de autenticación (Supabase Auth). No
          usamos cookies de publicidad ni de seguimiento entre sitios.
        </p>

        <h2>7. Tus derechos sobre tus datos</h2>
        <p>Podés solicitarnos, escribiendo a <a href="mailto:hola@uellix.com">hola@uellix.com</a>:</p>
        <ul>
          <li>Acceso a los datos personales que tenemos sobre vos.</li>
          <li>Corrección de datos inexactos.</li>
          <li>Eliminación de tu cuenta, sujeto a las obligaciones de trazabilidad y auditoría de tu organización sobre el Contenido del Cliente ya cargado.</li>
          <li>Exportación de tus datos en un formato utilizable.</li>
        </ul>
        <p>
          [PENDIENTE — confirmar con asesoría legal si aplica un marco normativo
          específico (por ejemplo, protección de datos personales del país de
          constitución de la empresa o de los países donde operan las organizaciones
          clientes) y documentar el proceso formal de ejercicio de estos derechos].
        </p>

        <h2>8. Retención de datos</h2>
        <p>
          Conservamos el Contenido del Cliente mientras tu organización mantenga una
          cuenta activa en la Plataforma, y por un período razonable después de la
          baja para permitir exportación de datos, salvo que una obligación legal
          exija un plazo distinto. Los registros de auditoría se conservan de forma
          indefinida como parte del rastro de trazabilidad metodológica.
        </p>

        <h2>9. Menores de edad</h2>
        <p>
          Uellix es una herramienta B2B dirigida a organizaciones y profesionales; no
          está destinada a ser usada directamente por menores de edad.
        </p>

        <h2>10. Cambios a esta política</h2>
        <p>
          Si hacemos cambios significativos a esta política, lo comunicaremos a través
          de la Plataforma o por correo antes de que entren en vigencia.
        </p>

        <h2>11. Contacto</h2>
        <p>
          Preguntas sobre esta política o sobre tus datos: <a href="mailto:hola@uellix.com">hola@uellix.com</a>.
        </p>
      </div>
    </div>
  );
}
