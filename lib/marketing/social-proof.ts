// ─────────────────────────────────────────────────────────────────────────────
// Social-proof data source — INTENTIONALLY EMPTY until real material exists.
//
// The brand rule is: never invent clients, logos, testimonials or metrics.
// The SocialProofSection component reads from these arrays and renders NOTHING
// while they are empty, so the landing shows no fabricated proof today but is
// one edit away from displaying it the moment there is a real pilot, partner or
// quote to show.
//
// To populate:
//   • trustedByLogos — add real organisations that have agreed to be named,
//     each with an SVG/PNG placed in /public/brand/partners/.
//   • testimonials   — add real, attributable quotes (person + role + org).
//
// Do not add a logo or quote here unless it is real and cleared for public use.
// ─────────────────────────────────────────────────────────────────────────────

export type TrustedLogo = {
  /** Organisation name — used as the img alt text. */
  name: string
  /** Path under /public, e.g. "/brand/partners/acme.svg". */
  src: string
  /** Intrinsic width/height for layout stability (no CLS). */
  width: number
  height: number
}

export type Testimonial = {
  /** The verbatim, attributable quote. */
  quote: string
  /** Person who said it. */
  author: string
  /** Their role. */
  role: string
  /** Their organisation. */
  organization: string
}

export const trustedByLogos: TrustedLogo[] = []

export const testimonials: Testimonial[] = []

export const hasSocialProof =
  trustedByLogos.length > 0 || testimonials.length > 0
