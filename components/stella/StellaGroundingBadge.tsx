'use client'
// components/stella/StellaGroundingBadge.tsx
// PRODUCT TRAIN 1 -- visual badge for one claim's EvidenceSupportLevel.

import { CheckCircle2, AlertTriangle, HelpCircle, GitCompareArrows } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EvidenceSupportLevel } from './grounding-model'

const SUPPORT_META: Record<
  EvidenceSupportLevel,
  { label: string; badgeClass: string; Icon: typeof CheckCircle2 }
> = {
  grounded: {
    label: 'Fundamentado',
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  partially_grounded: {
    label: 'Parcialmente fundamentado',
    badgeClass: 'bg-uellix-orange/10 text-uellix-orange-strong',
    Icon: AlertTriangle,
  },
  insufficient_evidence: {
    label: 'Evidencia insuficiente',
    badgeClass: 'bg-muted text-muted-foreground',
    Icon: HelpCircle,
  },
  contradictory_evidence: {
    label: 'Evidencia contradictoria',
    badgeClass: 'bg-danger-light text-danger',
    Icon: GitCompareArrows,
  },
}

export interface StellaGroundingBadgeProps {
  level: EvidenceSupportLevel
  className?: string
}

export function StellaGroundingBadge({ level, className }: StellaGroundingBadgeProps) {
  const meta = SUPPORT_META[level]
  return (
    <span
      data-testid="stella-grounding-badge"
      data-support-level={level}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        meta.badgeClass,
        className
      )}
    >
      <meta.Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  )
}
