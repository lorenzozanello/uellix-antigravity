'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { ErrorState } from '@/components/states/ErrorState'

export default function GlobalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Unhandled application error:', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-4">
        <ErrorState
          title="Something went wrong"
          message="This page couldn't load due to an unexpected error. Your data has not been affected."
          details={error.digest ? `Error reference: ${error.digest}` : undefined}
          action={{ label: 'Try again', onClick: reset }}
        />
        <div className="text-center">
          <Link
            href="/app/dashboard"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            ← Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}
