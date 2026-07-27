import { Clock, Mail, ShieldCheck } from 'lucide-react'

export interface OrganizationAdmin {
  email: string
  fullName: string | null
}

/**
 * Pantalla de espera para miembros que NO pueden completar el onboarding.
 *
 * F0-03: antes, un analista, revisor o visor de una organización sin onboarding
 * quedaba atrapado sin salida — toda ruta `/app/*` lo devolvía al formulario, y
 * al enviarlo recibía «Only organization admins can complete onboarding», en
 * inglés y sin ninguna indicación de qué hacer.
 *
 * Ahora ve quién puede desbloquearlo, con qué contactar, y puede cerrar sesión.
 */
export function OnboardingPending({
  organizationName,
  roleLabel,
  admins,
}: {
  organizationName: string
  roleLabel: string
  admins: OrganizationAdmin[]
}) {
  return (
    <div className="min-h-screen bg-[var(--uellix-paper)] flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-[#0F172A]/10 p-8 md:p-12">
        <div className="flex justify-center mb-6">
          <div className="h-12 w-12 rounded-xl bg-uellix-orange/10 flex items-center justify-center">
            <Clock className="h-6 w-6 text-uellix-orange" aria-hidden="true" />
          </div>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold font-sora text-[#0F172A] mb-3">
            Configuración pendiente
          </h1>
          <p className="text-[#475569] text-sm leading-relaxed">
            Tu cuenta en <strong className="text-[#0F172A]">{organizationName}</strong> ya está
            activa, pero la organización todavía no ha completado su configuración inicial.
            Hasta que eso ocurra no es posible crear ni consultar proyectos.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 mb-6">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#0F172A] mb-1">
                Sólo un administrador puede completarla
              </p>
              <p className="text-sm text-[#475569]">
                Tu rol actual es <strong className="text-[#0F172A]">{roleLabel}</strong>, que no
                incluye permisos para definir el país, el sector ni la moneda base de la
                organización.
              </p>
            </div>
          </div>
        </div>

        {admins.length > 0 ? (
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
              {admins.length === 1
                ? 'Contacta a tu administrador'
                : 'Contacta a alguno de tus administradores'}
            </p>
            <ul className="space-y-2">
              {admins.map((admin) => (
                <li
                  key={admin.email}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3"
                >
                  <Mail className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    {admin.fullName && (
                      <p className="text-sm font-medium text-[#0F172A] truncate">
                        {admin.fullName}
                      </p>
                    )}
                    <a
                      href={`mailto:${admin.email}`}
                      className="text-sm text-[#B85200] hover:underline break-all"
                    >
                      {admin.email}
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-900">
              No hay ningún administrador activo en esta organización. Escribe a{' '}
              <a href="mailto:soporte@uellix.com" className="font-medium underline">
                soporte@uellix.com
              </a>{' '}
              para que podamos ayudarte.
            </p>
          </div>
        )}

        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="w-full h-11 rounded-lg border border-slate-200 text-sm font-semibold text-[#475569] hover:bg-slate-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uellix-orange"
          >
            Cerrar sesión
          </button>
        </form>
      </div>
    </div>
  )
}
