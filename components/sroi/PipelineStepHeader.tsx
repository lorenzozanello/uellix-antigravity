interface PipelineStepHeaderProps {
  step: number
  title: string
  description: string
  methodologyNote?: string
}

export function PipelineStepHeader({ step, title, description, methodologyNote }: PipelineStepHeaderProps) {
  return (
    <div className="mb-6 border-b border-border pb-5">
      <div className="flex items-center gap-3 mb-1.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#FF6A00] text-xs font-bold text-white"
          aria-hidden="true"
        >
          {step}
        </span>
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      </div>
      <p className="ml-10 text-sm text-muted-foreground">{description}</p>
      {methodologyNote && (
        <p className="mt-2 ml-10 border-l-2 border-border pl-3 text-xs text-muted-foreground/75 italic">
          {methodologyNote}
        </p>
      )}
    </div>
  )
}
