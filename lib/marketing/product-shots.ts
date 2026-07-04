// ─────────────────────────────────────────────────────────────────────────────
// Real product screenshots — INTENTIONALLY EMPTY until captures exist.
//
// The audit's #1 credibility lever is showing the actual product (pipeline, an
// exported Impact Deck) instead of only CSS mockups. This is the drop-in point.
// ProductPreviewSection renders nothing while this array is empty, so no
// placeholder or fake screenshot ships — the moment a real capture is added
// (even with demo data), a "Vistazo al producto" section appears automatically.
//
// To populate:
//   1. Drop the PNG/WebP under /public/product/ (e.g. pipeline-evidence.png).
//   2. Add an entry below with its intrinsic width/height (for CLS-free layout).
//   3. Prefer 2x-resolution captures; next/image handles responsive sizing.
// ─────────────────────────────────────────────────────────────────────────────

export type ProductShot = {
  /** Path under /public, e.g. "/product/pipeline-evidence.png". */
  src: string
  /** Descriptive alt — what the screen shows. */
  alt: string
  /** Short caption shown under the frame. */
  caption: string
  /** Intrinsic pixel dimensions of the asset (for aspect-ratio / no CLS). */
  width: number
  height: number
}

export const productShots: ProductShot[] = []

export const hasProductShots = productShots.length > 0
