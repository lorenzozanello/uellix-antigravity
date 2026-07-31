'use client'
// components/stella/StellaErrorNotice.tsx
// WS2 (Moonshot) — shared error rendering for every Stella panel (U5/U6).
// Renders inside the panel's persistent assertive live region; the caller
// moves focus to the container it mounts this into.

import { AlertTriangle, Clock, FileWarning, Gauge, Info, PowerOff, RefreshCw, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { stellaErrorPresentation, type StellaErrorPresentation } from './error-messages'

function ErrorIcon({ presentation }: { presentation: StellaErrorPresentation }) {
  const cls = cn(
    'mt-0.5 h-4 w-4 shrink-0',
    presentation.tone === 'error' && 'text-danger',
    presentation.tone === 'warning' && 'text-uellix-orange-strong',
    presentation.tone === 'info' && 'text-muted-foreground'
  )
  switch (presentation.code) {
    case 'DISABLED':
      return <PowerOff className={cls} aria-hidden="true" />
    case 'UNAUTHORIZED':
      return <ShieldAlert className={cls} aria-hidden="true" />
    case 'RATE_LIMITED':
    case 'RATE_LIMIT_UNAVAILABLE':
    case 'TIMEOUT':
      return <Clock className={cls} aria-hidden="true" />
    case 'QUOTA_EXCEEDED':
      return <Gauge className={cls} aria-hidden="true" />
    case 'PAYLOAD_TOO_LARGE':
      return <FileWarning className={cls} aria-hidden="true" />
    case 'UNSUPPORTED_STEP':
      return <Info className={cls} aria-hidden="true" />
    default:
      return <AlertTriangle className={cls} aria-hidden="true" />
  }
}

interface StellaErrorNoticeProps {
  code: string
  message: string
  /** Called when the user clicks "Reintentar" (shown only for retryable codes). */
  onRetry?: () => void
  className?: string
}

export function StellaErrorNotice({ code, message, onRetry, className }: StellaErrorNoticeProps) {
  const presentation = stellaErrorPresentation(code, message)
  return (
    <div
      role="alert"
      data-testid="stella-error-notice"
      data-error-code={presentation.code}
      className={cn(
        'flex gap-3 rounded-md border p-3',
        presentation.tone === 'error' && 'border-danger/20 bg-danger-light/40',
        presentation.tone === 'warning' && 'border-uellix-orange/30 bg-uellix-orange/5',
        presentation.tone === 'info' && 'border-border bg-muted/30',
        className
      )}
    >
      <ErrorIcon presentation={presentation} />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{presentation.title}</p>
        <p className="text-sm text-muted-foreground">{presentation.description}</p>
        {presentation.retryable && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Reintentar
          </button>
        )}
      </div>
    </div>
  )
}
