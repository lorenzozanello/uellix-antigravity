import React from "react"
import Image from "next/image"
import { productShots } from "@/lib/marketing/product-shots"

// Shows real product screenshots inside a sober browser-chrome frame — and
// renders nothing until at least one capture is registered in
// lib/marketing/product-shots.ts. This is where "audit-ready" stops being
// asserted and starts being demonstrated. No placeholder ships while empty.
export function ProductPreviewSection() {
  if (productShots.length === 0) return null

  return (
    <section
      id="producto-vistazo"
      aria-label="Vistazo al producto"
      className="bg-[var(--uellix-paper-deep)] px-4 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-14">
          <span className="inline-flex items-center gap-2 font-ibm-plex-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#5B6472] mb-6">
            <span className="h-px w-8 bg-uellix-orange/30" aria-hidden="true" />
            Vistazo al producto
          </span>
          <h2 className="font-sora text-[clamp(2rem,4vw,3.1rem)] font-bold leading-[1.05] tracking-[-0.015em] text-[#0F172A]">
            La trazabilidad, dentro del producto.
          </h2>
        </div>

        <div className="flex flex-col gap-16">
          {productShots.map(({ src, alt, caption, width, height }) => (
            <figure key={src} className="flex flex-col">
              {/* Browser-chrome frame */}
              <div className="overflow-hidden rounded-2xl border border-[#0F172A]/12 bg-white shadow-[0_32px_80px_-32px_rgba(15,23,42,0.35)]">
                <div className="flex items-center gap-1.5 border-b border-[#0F172A]/8 bg-[var(--uellix-paper)] px-4 py-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#0F172A]/15" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#0F172A]/15" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#0F172A]/15" />
                  <span className="ml-3 font-ibm-plex-mono text-[10px] tracking-wide text-[#5B6472] lowercase">
                    app.uellix.com
                  </span>
                </div>
                <Image
                  src={src}
                  alt={alt}
                  width={width}
                  height={height}
                  className="h-auto w-full"
                  sizes="(min-width: 1024px) 1024px, 100vw"
                />
              </div>
              <figcaption className="mt-4 font-manrope text-sm text-[#5B6472] max-w-xl">
                {caption}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}
