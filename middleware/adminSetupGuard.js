/**
 * Guards POST /api/auth/register-admin.
 * - Production: endpoint hidden (404).
 * - Development: requires X-Admin-Setup-Secret matching ADMIN_SETUP_SECRET in .env.
 */
module.exports = function adminSetupGuard(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found.' });
  }

  const secret = process.env.ADMIN_SETUP_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: 'Admin registration is disabled. Set ADMIN_SETUP_SECRET in .env for local setup.',
    });
  }

  const provided = req.header('X-Admin-Setup-Secret');
  if (provided !== secret) {
    return res.status(403).json({ error: 'Invalid or missing admin setup secret.' });
  }

  next();
};
