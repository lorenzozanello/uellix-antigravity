import { ImageResponse } from "next/og"

// Favicon (modern browsers pull this at 32px). Solid brand orange + white "U"
// stays legible at small sizes. app/favicon.ico remains as the legacy fallback.
export const size = { width: 32, height: 32 }
export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fc4c0d",
          color: "#FFFFFF",
          fontSize: 22,
          fontWeight: 700,
          borderRadius: 7,
        }}
      >
        U
      </div>
    ),
    { ...size }
  )
}
