/**
 * Rate limiters for auth and other sensitive endpoints (in-memory store).
 * Use Redis-backed store when running multiple API instances.
 */
const rateLimit = require('express-rate-limit');

function createLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

/** Brute-force protection for login — 10 attempts per IP per 15 minutes (prod). */
const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 200,
  message: 'Too many login attempts. Please try again in 15 minutes.',
});

/** Admin bootstrap in dev — 5 attempts per IP per hour. */
const registerAdminLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many admin registration attempts. Please try again later.',
});

/** Legacy register-gym (admin-authed) — cap burst abuse. */
const registerGymLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Too many registration requests. Please try again later.',
});

/** OTP request — 5 per IP per hour. */
const otpRequestLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many verification code requests. Please try again later.',
});

/** OTP verify / reset — 10 per IP per hour. */
const otpVerifyLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many verification attempts. Please try again later.',
});

/** Public gym signup — 3 per IP per hour. */
const publicGymSignupLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: 'Too many signup attempts. Please try again later.',
});

/** Forgot-password — 5 requests per IP per hour. */
const forgotPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many password reset requests. Please try again later.',
});

/** Reset-password token submission — 10 attempts per IP per hour. */
const resetPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many reset attempts. Please try again later.',
});

/** Change-password — 10 attempts per IP per hour. */
const changePasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many password change attempts. Please try again later.',
});

/** General API abuse protection — 300 requests per IP per 15 minutes. */
const apiLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests. Please slow down.',
});

module.exports = {
  loginLimiter,
  registerAdminLimiter,
  registerGymLimiter,
  forgotPasswordLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  publicGymSignupLimiter,
  resetPasswordLimiter,
  changePasswordLimiter,
  apiLimiter,
};
