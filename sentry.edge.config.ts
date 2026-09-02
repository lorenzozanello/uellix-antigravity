import * as Sentry from '@sentry/nextjs';

import { sentryBeforeSend } from '@/lib/security/sanitize-sentry-event';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1,
  debug: false,
  // F-GB-02: same scrub, same function. The edge runtime runs `proxy.ts`,
  // where an error carries request headers — including the session cookie.
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
});
