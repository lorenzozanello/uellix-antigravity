import { requireAuth } from '@/lib/auth/session'
import { getCurrentMembership } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { createFirstOrganization } from './actions'

export default async function OnboardingPage() {
  const user = await requireAuth()

  // If user already has an org, redirect to dashboard
  const membership = await getCurrentMembership(user.id)
  if (membership) {
    redirect('/app/dashboard')
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Bienvenido a Uellix
          </h1>
          <p className="mt-2 text-slate-400">
            Crea tu organización para comenzar a medir impacto social.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-xl">
          <h2 className="text-lg font-semibold text-white mb-6">
            Crear organización
          </h2>

          <form action={createFirstOrganization} className="space-y-5">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-slate-300 mb-1.5">
                Nombre de la organización <span className="text-red-400">*</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                maxLength={255}
                placeholder="Ej: Fundación Impacto Positivo"
                className="w-full rounded-lg bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>

            <div>
              <label htmlFor="slug" className="block text-sm font-medium text-slate-300 mb-1.5">
                Identificador único (slug) <span className="text-red-400">*</span>
              </label>
              <input
                id="slug"
                name="slug"
                type="text"
                required
                maxLength={255}
                pattern="[a-z0-9-]+"
                placeholder="Ej: fundacion-impacto"
                className="w-full rounded-lg bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
              <p className="mt-1 text-xs text-slate-500">Solo minúsculas, números y guiones.</p>
            </div>

            <div>
              <label htmlFor="legalName" className="block text-sm font-medium text-slate-300 mb-1.5">
                Razón social (opcional)
              </label>
              <input
                id="legalName"
                name="legalName"
                type="text"
                maxLength={255}
                placeholder="Ej: Fundación Impacto Positivo A.C."
                className="w-full rounded-lg bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="country" className="block text-sm font-medium text-slate-300 mb-1.5">
                  País (código ISO)
                </label>
                <input
                  id="country"
                  name="country"
                  type="text"
                  maxLength={2}
                  placeholder="MX"
                  className="w-full rounded-lg bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 uppercase"
                />
              </div>

              <div>
                <label htmlFor="sector" className="block text-sm font-medium text-slate-300 mb-1.5">
                  Sector
                </label>
                <select
                  id="sector"
                  name="sector"
                  className="w-full rounded-lg bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="">Seleccionar</option>
                  <option value="educacion">Educación</option>
                  <option value="salud">Salud</option>
                  <option value="medio_ambiente">Medio Ambiente</option>
                  <option value="inclusion_social">Inclusión Social</option>
                  <option value="desarrollo_economico">Desarrollo Económico</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              id="btn-create-organization"
              className="w-full mt-2 rounded-lg bg-teal-500 hover:bg-teal-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-slate-900"
            >
              Crear organización
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
