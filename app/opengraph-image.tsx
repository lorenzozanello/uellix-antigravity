import { ImageResponse } from "next/og"

// Dynamically generated social-share card. No external asset required — the
// brand card is composed here so the OpenGraph/Twitter preview is never blank.
// 1200×630 is the canonical large-image size for both OpenGraph and Twitter.
export const alt =
  "Uellix — Convierte el impacto social en evidencia defendible"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0A101E",
          padding: "72px 80px",
          position: "relative",
        }}
      >
        {/* orange radial glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse 60% 60% at 82% 12%, rgba(252,76,13,0.20), transparent 60%)",
            display: "flex",
          }}
        />

        {/* top: wordmark + eyebrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: "#FFFFFF",
                letterSpacing: "-0.02em",
              }}
            >
              uelli
            </span>
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: "#fc4c0d",
                letterSpacing: "-0.02em",
              }}
            >
              x
            </span>
          </div>
          <span
            style={{
              fontSize: 20,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.28em",
              color: "#94A3B8",
            }}
          >
            Ledger cívico de impacto
          </span>
        </div>

        {/* headline — stacked so the accent line reads as the emphasis */}
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 1000 }}>
          <div
            style={{
              display: "flex",
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.025em",
              color: "#FFFFFF",
            }}
          >
            Convierte el impacto social en
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.025em",
              color: "#fc4c0d",
            }}
          >
            evidencia defendible.
          </div>
        </div>

        {/* bottom: mono trace strip */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 22px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.14)",
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                backgroundColor: "#fc4c0d",
                display: "flex",
              }}
            />
            <span
              style={{
                fontSize: 22,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.16em",
                color: "#CBD5E1",
              }}
            >
              audit-ready · trazable · defendible
            </span>
          </div>
        </div>
      </div>
    ),
    { ...size }
  )
}
