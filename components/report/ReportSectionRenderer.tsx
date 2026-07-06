'use client'

// components/report/ReportSectionRenderer.tsx
// Routes report section rendering to specialized components based on section type.
// Currently handles funder_breakdown with interactive table; others render as text.

import React from 'react'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'
import { FunderBreakdownSection } from '@/app/components/report-sections/FunderBreakdown'

interface ReportSection {
  id: string
  sectionType: string
  title: string
  content: string | null
}

interface ReportSectionRendererProps {
  section: ReportSection
  snapshotJson?: Record<string, unknown> | null
  currency?: string
  isLocked?: boolean
  sectionLabel?: string
}

/**
 * Routes section rendering based on type.
 * For funder_breakdown, reads fundersBreakdown + unattributedNsvUsd from snapshotJson.
 * For others, renders content as plain text.
 */
export function ReportSectionRenderer({
  section,
  snapshotJson,
  currency = 'USD',
  isLocked = false,
  sectionLabel,
}: ReportSectionRendererProps) {
  // Special handling for funder_breakdown section
  if (section.sectionType === 'funder_breakdown') {
    const fundersBreakdown = (snapshotJson?.fundersBreakdown as FunderBreakdownRow[] | undefined) ?? []
    const unattributedNsvUsd = (snapshotJson?.unattributedNsvUsd as string | undefined) ?? '0.0000'
    const totalNetSocialValueUsd = (snapshotJson?.netSocialValue as string | undefined) ?? '0.0000'

    if (isLocked) {
      // In locked mode, still show the table but as static read-only
      return (
        <div>
          <FunderBreakdownSection
            fundersBreakdown={fundersBreakdown}
            unattributedNsvUsd={unattributedNsvUsd}
            totalNetSocialValueUsd={totalNetSocialValueUsd}
            currency={currency}
          />
        </div>
      )
    }

    // In draft mode (editable), show both the table and allow editing the section content
    return (
      <div className="space-y-4">
        <FunderBreakdownSection
          fundersBreakdown={fundersBreakdown}
          unattributedNsvUsd={unattributedNsvUsd}
          totalNetSocialValueUsd={totalNetSocialValueUsd}
          currency={currency}
        />
        {section.content && (
          <div className="mt-3 rounded-md bg-muted/20 p-3">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Notas metodológicas</p>
            <p className="text-sm text-foreground whitespace-pre-wrap">{section.content}</p>
          </div>
        )}
      </div>
    )
  }

  // Default: render as plain text
  if (section.content) {
    return (
      <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
        {section.content}
      </p>
    )
  }

  return <p className="text-sm text-muted-foreground italic">No hay contenido registrado para esta sección.</p>
}
