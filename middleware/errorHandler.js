/**
 * Centralized Express error handler — register after all routes.
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

  const payload = {
    error: isProduction && statusCode >= 500 ? 'Internal server error' : err.message || 'Internal server error',
  };
  if (err.code) {
    payload.code = err.code;
  }
  res.status(statusCode).json(payload);
};
