'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, FolderKanban, ShieldCheck } from 'lucide-react'

const NAV_LINKS = [
  { href: '/app/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/app/projects', label: 'SROI Projects', icon: FolderKanban },
  { href: '/app/trust-center', label: 'Trust Center', icon: ShieldCheck },
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
          className="text-xl font-bold tracking-tight text-sidebar-primary-foreground hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded"
        >
          Uellix
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
                'flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
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
