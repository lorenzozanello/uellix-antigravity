import * as Sentry from '@sentry/nextjs'

import { sentryBeforeSend } from '@/lib/security/sanitize-sentry-event'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1,
  debug: false,
  // F-GB-02: the browser runtime scrubs with the same core as server and
  // edge. Replay already masks text; this covers the event envelope, where a
  // token can arrive via a fetch breadcrumb URL rather than the DOM.
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
  replaysOnErrorSampleRate: 1,
  replaysSessionSampleRate: 0.1,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
})

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
