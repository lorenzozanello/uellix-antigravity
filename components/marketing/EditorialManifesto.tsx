import React from "react"

// Full-bleed editorial statement. No cards, maximal breathing room, memorable
// typographic treatment — a deliberate rhythm break between the hero and the
// problem section.
export function EditorialManifesto() {
  return (
    <section
      aria-label="Manifiesto"
      className="section-seam relative overflow-hidden bg-[var(--uellix-carbon)] px-4 py-28 sm:py-40"
    >
      <div className="texture-grain" aria-hidden="true" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_80%_at_50%_50%,rgba(255,106,0,0.06),transparent_70%)]"
      />
      {/* Oversized editorial index mark */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-sora text-[42vw] font-semibold text-white/[0.02] select-none leading-none"
      >
        01
      </span>

      <div className="relative z-10 mx-auto max-w-4xl text-center">
        <p className="font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.28em] text-uellix-orange mb-8">
          Manifiesto
        </p>
        {/* Rendered as <h2> (not <p>) so this section has a real heading in the
            document outline. Same typographic treatment — zero visual change. */}
        <h2 className="font-sora text-white font-normal leading-[1.12] tracking-[-0.01em] text-[clamp(1.9rem,5vw,3.6rem)]">
          El impacto no falla por falta de intención.
          <br className="hidden sm:block" />{" "}
          <span className="text-white/55">Falla cuando</span>{" "}
          <span className="text-uellix-orange">no puede defenderse.</span>
        </h2>
      </div>
    </section>
  )
}
