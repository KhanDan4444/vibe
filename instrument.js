/**
 * Sentry must load before Express and other app modules.
 * Required first from server.js. No-op when SENTRY_DSN is unset.
 */
require('dotenv').config();

const Sentry = require('@sentry/node');

const dsn = String(process.env.SENTRY_DSN || '').trim();

if (dsn) {
  const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0);
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    // Performance tracing off by default (errors only). Set 0.1–0.2 later if needed.
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0,
    integrations: [
      // Request instrumentation only — 5xx capture is in middleware/errorHandler
      // so we can attach gym_id / user tags once.
      Sentry.expressIntegration({ shouldHandleError: false }),
    ],
    beforeSend(event) {
      // Never ship secrets if they land in breadcrumbs / extras.
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });
}

module.exports = Sentry;
