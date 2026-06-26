import { Badge } from '@/components/ui/badge'
import { Breadcrumbs } from './Breadcrumbs'
import { MobileNav } from './MobileNav'

interface TopBarProps {
  orgName: string
  roleLabel: string
}

export function TopBar({ orgName, roleLabel }: TopBarProps) {
  return (
    <header className="h-16 shrink-0 border-b border-border bg-background flex items-center px-6 gap-4">
      <MobileNav />

      {/* Breadcrumbs fill available space */}
      <div className="flex-1 min-w-0">
        <Breadcrumbs />
      </div>

      {/* Org + role context */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="hidden sm:block text-sm text-muted-foreground truncate max-w-[200px]">
          {orgName}
        </span>
        <Badge variant="teal">{roleLabel}</Badge>
      </div>
    </header>
  )
}
