import React from "react"
import { Quote } from "lucide-react"
import { trustedByLogos, testimonials } from "@/lib/marketing/social-proof"

// Renders real social proof (partner logos + attributable testimonials) when it
// exists, and nothing at all until then. See lib/marketing/social-proof.ts —
// the arrays are deliberately empty so no fabricated proof ships. The moment a
// real logo or quote is added there, this section appears with no further work.
export function SocialProofSection() {
  const hasLogos = trustedByLogos.length > 0
  const hasQuotes = testimonials.length > 0
  if (!hasLogos && !hasQuotes) return null

  return (
    <section
      id="confian-social"
      aria-label="Confianza de organizaciones"
      className="bg-[var(--uellix-paper)] px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        {hasLogos && (
          <div className="text-center">
            <p className="font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-8">
              Organizaciones que ya construyen evidencia con Uellix
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-x-12 gap-y-8">
              {trustedByLogos.map(({ name, src, width, height }) => (
                <li key={name} className="opacity-70 transition-premium hover:opacity-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={name}
                    width={width}
                    height={height}
                    className="h-7 w-auto object-contain grayscale"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {hasQuotes && (
          <div className={`grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 ${hasLogos ? "mt-16" : ""}`}>
            {testimonials.map(({ quote, author, role, organization }) => (
              <figure
                key={`${author}-${organization}`}
                className="flex flex-col rounded-2xl border border-[#0F172A]/10 bg-white/80 backdrop-blur-sm p-6 card-lift"
              >
                <Quote className="h-5 w-5 text-uellix-orange/60 mb-4" aria-hidden="true" />
                <blockquote className="flex-1 text-[15px] leading-relaxed text-[#0F172A] font-manrope">
                  “{quote}”
                </blockquote>
                <figcaption className="mt-5 border-t border-[#0F172A]/8 pt-4">
                  <p className="text-sm font-semibold text-[#0F172A] font-sora">{author}</p>
                  <p className="font-ibm-plex-mono text-[10px] uppercase tracking-[0.12em] text-[#5B6472] mt-0.5">
                    {role} · {organization}
                  </p>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
