import React from 'react'
import Link from 'next/link'
import { requireAdminAccess } from '@/lib/auth/session'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await requireAdminAccess()

  return (
    <div className="flex min-h-screen bg-slate-950 text-white selection:bg-red-500 selection:text-white">
      {/* Sidebar */}
      <aside className="w-64 border-r border-red-900/30 bg-slate-900/50 backdrop-blur-md flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-red-900/30">
          <Link href="/admin" className="text-xl font-bold tracking-tight text-red-500">
            Uellix Admin
          </Link>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <Link
            href="/admin"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Consola del Sistema
          </Link>
          <Link
            href="/admin/organizations"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Organizaciones
          </Link>
          <Link
            href="/admin/proxies"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Proxies Globales
          </Link>
          <Link
            href="/admin/logs"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Logs Globales
          </Link>
          <Link
            href="/admin/access"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Acceso (Signup)
          </Link>
          <Link
            href="/admin/services"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md hover:bg-slate-800 transition-colors text-slate-300 hover:text-white"
          >
            Servicios Stella
          </Link>
        </nav>
        <div className="p-4 border-t border-red-900/30 space-y-2">
          <Link
            href="/app/dashboard"
            className="flex items-center px-4 py-2 text-sm font-medium rounded-md text-slate-400 hover:bg-slate-800 transition-colors"
          >
            Volver a la App
          </Link>
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
        <header className="h-16 border-b border-red-900/30 flex items-center justify-between px-8 bg-slate-900/30">
          <h2 className="text-lg font-semibold text-red-500">Consola de Control Global</h2>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400">{user.email}</span>
            <span className="inline-flex items-center rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
              Super Administrador
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
    </div>
  )
}
