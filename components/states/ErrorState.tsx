import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
  title: string
  message?: string
  action?: {
    label: string
    onClick: () => void
  }
  details?: string
  className?: string
}

export function ErrorState({
  title,
  message,
  action,
  details,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-danger/20 bg-danger-light p-6',
        className
      )}
      role="alert"
    >
      <div className="flex gap-4">
        <AlertTriangle className="h-6 w-6 text-danger flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-semibold text-danger">{title}</h3>
          {message && <p className="mt-1 text-sm text-danger/80">{message}</p>}
          {details && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-danger/60 hover:text-danger/80">
                Detalles técnicos
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-danger/5 p-2 text-xs text-danger/80 font-mono">
                {details}
              </pre>
            </details>
          )}
          {action && (
            <button
              onClick={action.onClick}
              className="mt-4 inline-flex items-center justify-center rounded-md bg-danger text-white px-4 py-2 text-sm font-medium hover:bg-danger/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2"
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
