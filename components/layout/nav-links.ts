// components/layout/nav-links.ts
//
// Single source of truth for primary authenticated navigation. Sidebar.tsx
// and MobileNav.tsx previously each carried their own copy of this list,
// which let desktop and mobile silently diverge (RE-U1 U1-F10) — most
// visibly by both drifting out of sync with the routes that actually exist
// under app/app/**.

import type { LucideIcon } from 'lucide-react'
import { LayoutDashboard, FolderKanban, ShieldCheck, Users, CreditCard } from 'lucide-react'

export interface NavLink {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_LINKS: NavLink[] = [
  { href: '/app/dashboard', label: 'Panel', icon: LayoutDashboard },
  { href: '/app/projects', label: 'Proyectos SROI', icon: FolderKanban },
  { href: '/app/trust-center', label: 'Centro de confianza', icon: ShieldCheck },
  { href: '/app/organization/members', label: 'Miembros', icon: Users },
  { href: '/app/organization/billing', label: 'Facturación', icon: CreditCard },
]

/** Dashboard matches exactly (it's also the /app/* landing point); every other entry matches its subtree. */
export function isNavLinkActive(href: string, currentPath: string): boolean {
  if (href === '/app/dashboard') return currentPath === '/app/dashboard'
  return currentPath.startsWith(href)
}
