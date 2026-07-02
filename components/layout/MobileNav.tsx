'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X, LayoutDashboard, FolderKanban, ShieldCheck, Users } from 'lucide-react'

const NAV_LINKS = [
  { href: '/app/dashboard', label: 'Panel', icon: LayoutDashboard },
  { href: '/app/projects', label: 'Proyectos SROI', icon: FolderKanban },
  { href: '/app/trust-center', label: 'Centro de confianza', icon: ShieldCheck },
  { href: '/app/organization/members', label: 'Miembros', icon: Users },
]

function isActive(href: string, path: string) {
  if (href === '/app/dashboard') return path === '/app/dashboard'
  return path.startsWith(href)
}

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname() ?? ''
  const close = () => setOpen(false)

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center rounded-md p-2 min-h-11 min-w-11 text-muted-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Abrir menú de navegación"
        aria-expanded={open}
        aria-controls="mobile-nav-drawer"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          {/* Drawer */}
          <div
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Menú de navegación"
            className="dark fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar border-r border-sidebar-border"
          >
            {/* Brand + close */}
            <div className="flex h-16 items-center justify-between px-6 border-b border-sidebar-border">
              <Link
                href="/app/dashboard"
                onClick={close}
                aria-label="Uellix — Inicio"
                className="hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded"
              >
                <img
                  src="/brand/uellix-logo-horizontal-reversed.svg"
                  alt="Uellix"
                  width="120"
                  height="30"
                  className="h-7 w-auto"
                />
              </Link>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center justify-center rounded-md p-1.5 min-h-11 min-w-11 text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                aria-label="Cerrar menú de navegación"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* Nav links */}
            <nav aria-label="Navegación principal" className="flex-1 px-3 py-4 space-y-1">
              {NAV_LINKS.map(({ href, label, icon: Icon }) => {
                const active = isActive(href, pathname)
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={close}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'flex items-center gap-3 px-3 py-3 text-sm font-medium rounded-md transition-colors min-h-11 border-l-2',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                      active
                        ? 'bg-sidebar-accent text-white border-[#FF6A00]'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground border-transparent',
                    ].join(' ')}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {label}
                  </Link>
                )
              })}
            </nav>

            {/* Sign-out footer */}
            <div className="px-3 py-4 border-t border-sidebar-border">
              <form action="/auth/signout" method="post">
                <button
                  type="submit"
                  className="w-full flex items-center gap-3 px-3 py-3 text-sm font-medium rounded-md text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring text-left min-h-11"
                >
                  Cerrar sesión
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
