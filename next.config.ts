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

import { withSentryConfig } from '@sentry/nextjs';

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
