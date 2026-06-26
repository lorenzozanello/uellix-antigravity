import React from 'react'
import { cn } from '@/lib/utils'

interface LoadingStateProps {
  message?: string
  variant?: 'spinner' | 'skeleton'
  className?: string
}

export function LoadingState({
  message = 'Cargando...',
  variant = 'spinner',
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border bg-muted/30 p-12',
        className
      )}
    >
      {variant === 'spinner' && (
        <div className="mb-4">
          <div className="inline-flex h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary" />
        </div>
      )}
      {variant === 'skeleton' && (
        <div className="mb-4 space-y-3 w-full max-w-sm">
          <div className="h-4 rounded-full bg-neutral-200 dark:bg-neutral-700" />
          <div className="h-4 rounded-full bg-neutral-200 dark:bg-neutral-700 w-5/6" />
          <div className="h-4 rounded-full bg-neutral-200 dark:bg-neutral-700 w-4/6" />
        </div>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}
