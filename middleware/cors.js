/**
 * CORS allowlist — replaces Access-Control-Allow-Origin: *
 *
 * Dev (NODE_ENV !== production): defaults to common Vite/local origins if
 * ALLOWED_ORIGINS is unset.
 * Production: ALLOWED_ORIGINS is required (comma-separated).
 */

const DEV_DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function resolveAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production') {
    return fromEnv;
  }

  return fromEnv.length > 0 ? fromEnv : DEV_DEFAULT_ORIGINS;
}

function validateCorsConfig(allowedOrigins) {
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    console.error(
      'FATAL: ALLOWED_ORIGINS must be set in production (comma-separated frontend URLs).'
    );
    process.exit(1);
  }

  if (allowedOrigins.length > 0) {
    console.log(`CORS allowlist: ${allowedOrigins.join(', ')}`);
  }
}

function createCorsMiddleware(allowedOrigins) {
  const allowHeaders =
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Setup-Secret';
  const allowMethods = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Headers', allowHeaders);
    res.setHeader('Access-Control-Allow-Methods', allowMethods);

    if (req.method === 'OPTIONS') {
      if (origin && !allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
      }
      return res.sendStatus(204);
    }

    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
    }

    next();
  };
}

module.exports = {
  resolveAllowedOrigins,
  validateCorsConfig,
  createCorsMiddleware,
};
