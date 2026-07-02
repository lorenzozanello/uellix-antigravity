'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, FolderKanban, ShieldCheck, Users } from 'lucide-react'

const NAV_LINKS = [
  { href: '/app/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/app/projects', label: 'SROI Projects', icon: FolderKanban },
  { href: '/app/trust-center', label: 'Trust Center', icon: ShieldCheck },
  { href: '/app/organization/members', label: 'Miembros', icon: Users },
]

function isActive(href: string, currentPath: string) {
  if (href === '/app/dashboard') return currentPath === '/app/dashboard'
  return currentPath.startsWith(href)
}

export function Sidebar() {
  const pathname = usePathname() ?? ''

  return (
    // Scoped dark class so sidebar-* tokens resolve to the dark palette
    <aside className="dark hidden lg:flex w-64 shrink-0 border-r border-sidebar-border bg-sidebar flex-col">
      {/* Brand */}
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
        <Link
          href="/app/dashboard"
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
      </div>

      {/* Primary navigation */}
      <nav aria-label="Main navigation" className="flex-1 px-3 py-4 space-y-1">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = isActive(href, pathname)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors border-l-2',
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
            className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring text-left"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  )
}
