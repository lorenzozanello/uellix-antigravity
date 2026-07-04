import { ImageResponse } from "next/og"

// Apple touch icon (180×180, retina home-screen bookmark). Carbon field with
// the brand orange mark, echoing the OpenGraph card. iOS applies its own corner
// mask, so the background fills the full square.
export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0A101E",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 112,
            height: 112,
            borderRadius: 28,
            backgroundColor: "#FF6A00",
            color: "#FFFFFF",
            fontSize: 72,
            fontWeight: 700,
          }}
        >
          U
        </div>
      </div>
    ),
    { ...size }
  )
}
