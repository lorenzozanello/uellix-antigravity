import * as Sentry from '@sentry/nextjs';

import { sentryBeforeSend } from '@/lib/security/sanitize-sentry-event';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1,
  debug: false,
  // F-GB-02: the final egress scrub. This runtime is the one that matters
  // most — `instrumentation.ts` routes every uncaught Server Action and route
  // handler error here via `captureRequestError`, with the request's headers
  // attached, having passed through no application redaction at all.
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
});
