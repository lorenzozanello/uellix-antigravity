import React from 'react'
import Link from 'next/link'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLE_LABELS } from '@/lib/auth/roles'

export default async function PrivateLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { organization, membership } = await requireOrganizationAccess()
  const roleLabel = ROLE_LABELS[membership.role] ?? membership.role

  return (
    <div className="flex min-h-screen bg-slate-950 text-white selection:bg-teal-500 selection:text-slate-950">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 bg-slate-900/50 backdrop-blur-md flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-slate-800">
          <Link href="/app/dashboard" className="text-xl font-bold tracking-tight text-teal-400">
            Uellix App
          </Link>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <Link
            href="/app/dashboard"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Dashboard
          </Link>
          <Link
            href="/app/projects"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Proyectos SROI
          </Link>
          <div className="pt-4 mt-4 border-t border-slate-800">
            <span className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Herramientas
            </span>
            <div className="mt-2 space-y-1">
              <span className="flex items-center px-4 py-2 text-xs font-medium text-slate-500">
                Trust Center (Soon)
              </span>
              <span className="flex items-center px-4 py-2 text-xs font-medium text-slate-500">
                Proxy Bank (Soon)
              </span>
              <span className="flex items-center px-4 py-2 text-xs font-medium text-slate-500">
                Stella Assistant (Soon)
              </span>
            </div>
          </div>
        </nav>
        <div className="p-4 border-t border-slate-800">
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="w-full flex items-center px-4 py-2 text-sm font-medium rounded-md text-red-400 hover:bg-red-500/10 transition-colors text-left"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-900/30">
          <h2 className="text-lg font-semibold text-slate-200">
            Organización: {organization.name}
          </h2>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center rounded-full bg-teal-500/10 px-2.5 py-0.5 text-xs font-medium text-teal-400 ring-1 ring-inset ring-teal-500/20">
              {roleLabel}
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
    </div>
  )
}
