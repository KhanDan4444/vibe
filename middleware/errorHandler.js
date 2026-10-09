/**
 * Centralized Express error handler — register after all routes.
 * 5xx (and status-less) errors are also sent to Sentry when SENTRY_DSN is set.
 */
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  console.error(`[${req.method} ${req.originalUrl}]`, err);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body is too large. Try a smaller member photo.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  if (process.env.SENTRY_DSN && statusCode >= 500) {
    try {
      const Sentry = require('../instrument');
      Sentry.withScope((scope) => {
        scope.setTag('http.method', req.method);
        scope.setTag('http.route', req.route?.path || req.path);
        if (req.user?.id) scope.setUser({ id: String(req.user.id) });
        if (req.user?.gym_id) scope.setTag('gym_id', String(req.user.gym_id));
        Sentry.captureException(err);
      });
    } catch {
      /* Sentry optional */
    }
  }

  const payload = {
    error: isProduction && statusCode >= 500 ? 'Internal server error' : err.message || 'Internal server error',
  };
  if (err.code) {
    payload.code = err.code;
  }
  res.status(statusCode).json(payload);
};
