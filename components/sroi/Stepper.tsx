'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const STEPS = [
  { name: 'Narrative', segment: 'narrative', href: './narrative' },
  { name: 'Stakeholders', segment: 'stakeholders', href: './stakeholders' },
  { name: 'Outcomes', segment: 'outcomes', href: './outcomes' },
  { name: 'Indicators', segment: 'indicators', href: './indicators' },
  { name: 'Evidence', segment: 'evidence', href: './evidence' },
  { name: 'Proxies', segment: 'proxies', href: './proxies' },
  { name: 'Trust Center', segment: 'trust-center', href: '/app/trust-center' },
  { name: 'Calculation', segment: 'calculation', href: './calculation' },
]

// Extract the first path segment after /pipeline/
function getPipelineSegment(pathname: string): string {
  const match = pathname.match(/\/pipeline\/([^/]+)/)
  return match?.[1] ?? ''
}

export default function Stepper() {
  const pathname = usePathname() ?? ''
  const activeSegment = getPipelineSegment(pathname)

  return (
    <nav aria-label="Pipeline steps" className="mb-6">
      <ol className="relative flex overflow-x-auto pb-3 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        {STEPS.map((step, idx) => {
          const isActive = activeSegment === step.segment
          const isLast = idx === STEPS.length - 1

          return (
            <li
              key={step.segment}
              className="relative flex shrink-0 flex-col items-center"
              style={{ width: 90 }}
            >
              {/* Connector: left half (behind this circle) */}
              {idx > 0 && (
                <div
                  className="absolute top-4 left-0 h-px bg-border"
                  style={{ width: 'calc(50% - 1rem)' }}
                  aria-hidden="true"
                />
              )}
              {/* Connector: right half (to next circle) */}
              {!isLast && (
                <div
                  className="absolute top-4 right-0 h-px bg-border"
                  style={{ width: 'calc(50% - 1rem)' }}
                  aria-hidden="true"
                />
              )}

              <Link
                href={step.href}
                aria-current={isActive ? 'step' : undefined}
                aria-label={`Step ${idx + 1}: ${step.name}${isActive ? ' — current step' : ''}`}
                className="group flex flex-col items-center gap-1.5 rounded-sm px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {/* Numbered circle — z-10 so it visually overlaps the connector lines */}
                <span
                  className={cn(
                    'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 bg-background text-xs font-bold transition-colors',
                    isActive
                      ? 'border-[#FF6A00] bg-[#FF6A00] text-white shadow-sm'
                      : 'border-border text-muted-foreground group-hover:border-[#FF6A00]/60 group-hover:text-foreground'
                  )}
                >
                  {idx + 1}
                </span>

                <span
                  className={cn(
                    'max-w-[80px] px-0.5 text-center text-[10px] font-medium leading-snug',
                    isActive
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground group-hover:text-foreground'
                  )}
                >
                  {step.name}
                </span>
              </Link>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
