import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Select component - styled native HTML select.
 * For advanced use cases, implement Radix UI when available.
 *
 * Usage:
 * <Select>
 *   <option value="">-- Select --</option>
 *   <option value="1">Option 1</option>
 * </Select>
 */

const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <div className="relative inline-block w-full">
    <select
      ref={ref}
      className={cn(
        'appearance-none h-8 w-full rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
  </div>
))
Select.displayName = 'Select'

export { Select }

