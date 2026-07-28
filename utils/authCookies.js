/**
 * HttpOnly session cookie for web clients. Mobile continues to use Authorization: Bearer.
 */

const AUTH_COOKIE = 'vibe_token';

function authCookieOptions(rememberMe = true) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAgeMs = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: maxAgeMs,
    path: '/',
  };
}

function setAuthCookie(res, token, rememberMe = true) {
  res.cookie(AUTH_COOKIE, token, authCookieOptions(rememberMe));
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, authCookieOptions(true));
}

module.exports = {
  AUTH_COOKIE,
  setAuthCookie,
  clearAuthCookie,
};
