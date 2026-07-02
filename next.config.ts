import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Must stay >= MAX_EVIDENCE_FILE_SIZE_BYTES (lib/pipeline/evidence.ts) plus
      // multipart/form overhead, or legitimate evidence uploads fail with a 413
      // before ever reaching our own size validation. Next.js defaults to 1 MB.
      bodySizeLimit: "30mb",
    },
  },
};

export default nextConfig;
