/**
 * @file routes/auth.js
 * @description Authentication & Tenant Registration Router.
 * Handles platform tenant registration (Gym and Gym Owner accounts), user login authentication,
 * and local admin registrations. Utilizes bcrypt for password hashing and JSON Web Tokens (JWT) for authentication.
 * 
 * Default seed user credentials for local validation and verification:
 * - Plaintext: "password"
 * - Bcrypt Salt Rounds: 10
 * - Verified Seed Hash: $2b$10$nOUIs5kJ7naTuTFkBy1veuK0kSxUFXfuaOKdOKf9xYT0KKIGSJwFa
 * 
 * @module routes/auth
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ROLES } = require('../utils/roles');
const adminSetupGuard = require('../middleware/adminSetupGuard');
const auth = require('../middleware/auth');
const adminCheck = require('../middleware/adminCheck');
const {
  loginLimiter,
  registerAdminLimiter,
  registerGymLimiter,
  forgotPasswordLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  publicGymSignupLimiter,
  resetPasswordLimiter,
  changePasswordLimiter,
} = require('../middleware/rateLimiters');
const { validateBody } = require('../middleware/validate');
const {
  loginSchema,
  registerAdminSchema,
  registerGymSchema,
  forgotPasswordSchema,
  requestForgotOtpSchema,
  resetForgotOtpSchema,
  gymSignupRequestOtpSchema,
  gymSignupCompleteSchema,
  resetPasswordSchema,
  changePasswordSchema,
} = require('../validation/schemas');
const { sendEmail } = require('../utils/email');
const { verifyOtp } = require('../utils/afroMessage');
const {
  PURPOSE,
  startPhoneOtpSession,
  getActiveSession,
  consumeSession,
  GENERIC_OTP_SENT,
} = require('../utils/phoneOtp');
const { registerGymWithOwner } = require('../utils/registerGymCore');
const { linkSignupOtpToGym } = require('../utils/notificationSms');
const {
  createPasswordResetToken,
  consumeResetToken,
} = require('../utils/passwordReset');
const { buildTokenPayload } = require('../utils/authTokens');

/**
 * POST /api/auth/register-gym
 * @description Legacy gym registration — restricted to Platform Admins.
 * Prefer POST /api/admin/gyms/enroll for register + payment in one step.
 */
router.post('/register-gym', registerGymLimiter, validateBody(registerGymSchema), auth, adminCheck, async (req, res, next) => {
  const { gym_name, owner_name, email, username, password, phone, saas_plan_id } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { owner, subscription } = await registerGymWithOwner(client, {
      gym_name,
      owner_name,
      email,
      username,
      password,
      phone,
      saas_plan_id,
    });
    await client.query('COMMIT');
    res.status(201).json({
      message: 'Gym and Owner successfully registered.',
      owner,
      subscription: {
        plan_name: subscription.plan.name,
        start_date: subscription.start_date,
        end_date: subscription.end_date,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email or username is already in use.' });
    }
    next(error);
  } finally {
    client.release();
  }
});

function isPublicGymSignupEnabled() {
  return process.env.PUBLIC_GYM_SIGNUP_ENABLED !== '0';
}

/**
 * GET /api/auth/saas-plans
 * Active SaaS plans for public gym registration.
 */
router.get('/saas-plans', async (req, res, next) => {
  if (!isPublicGymSignupEnabled()) {
    return res.status(403).json({ error: 'Gym self-registration is not available.' });
  }
  try {
    const result = await db.query(
      `SELECT id, name, duration, price, description
       FROM SaaSPlans
       WHERE is_active IS DISTINCT FROM false
       ORDER BY price ASC`
    );
    res.json({ plans: result.rows });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/gym-signup/request-otp
 * Send OTP to verify gym owner phone before registration.
 */
router.post(
  '/gym-signup/request-otp',
  publicGymSignupLimiter,
  otpRequestLimiter,
  validateBody(gymSignupRequestOtpSchema),
  async (req, res, next) => {
    if (!isPublicGymSignupEnabled()) {
      return res.status(403).json({ error: 'Gym self-registration is not available.' });
    }
    const { phone } = req.body;
    try {
      const { sessionId, expiresAt } = await startPhoneOtpSession(PURPOSE.GYM_SIGNUP, phone);
      res.json({
        message: 'Verification code sent to your phone.',
        sessionId,
        expiresAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/auth/gym-signup/complete
 * Verify OTP and create gym + owner (unpaid license term).
 */
router.post(
  '/gym-signup/complete',
  publicGymSignupLimiter,
  otpVerifyLimiter,
  validateBody(gymSignupCompleteSchema),
  async (req, res, next) => {
    if (!isPublicGymSignupEnabled()) {
      return res.status(403).json({ error: 'Gym self-registration is not available.' });
    }

    const {
      sessionId,
      code,
      gym_name,
      owner_name,
      email,
      username,
      password,
      phone,
      saas_plan_id,
    } = req.body;

    const client = await db.pool.connect();
    try {
      const session = await getActiveSession(sessionId, PURPOSE.GYM_SIGNUP);
      if (!session) {
        return res.status(400).json({ error: 'Verification session expired. Request a new code.' });
      }
      if (session.phone !== phone) {
        return res.status(400).json({ error: 'Phone number does not match the verified session.' });
      }

      await verifyOtp({
        verificationId: session.verification_id,
        phone: session.phone,
        code,
      });

      await client.query('BEGIN');
      const { gym, owner, subscription } = await registerGymWithOwner(client, {
        gym_name,
        owner_name,
        email,
        username,
        password,
        phone,
        saas_plan_id,
      });
      await linkSignupOtpToGym(gym.id, phone);
      await consumeSession(sessionId);
      await client.query('COMMIT');

      res.status(201).json({
        message: 'Gym registered. Sign in with your username and password.',
        gym: { id: gym.id, name: gym.name },
        owner: { id: owner.id, username: owner.username },
        subscription: {
          plan_name: subscription.plan.name,
          start_date: subscription.start_date,
          end_date: subscription.end_date,
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.statusCode === 404) {
        return res.status(404).json({ error: error.message });
      }
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Email or username is already in use.' });
      }
      if (error.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/auth/login
 * Login is POST-only; this handler explains that if the URL is opened in a browser.
 */
router.get('/login', (req, res) => {
  res.status(405).json({
    error: 'Method not allowed. Use POST /api/auth/login with JSON body: { "email", "password" }.',
    hint: 'Sign in via the React app (npm run dev in vibe-frontend), not this URL in the browser.',
  });
});

/**
 * POST /api/auth/login
 * @description Authenticates system users (Platform Admins and Gym Owners).
 * Compares incoming plaintext password against the stored bcrypt hash.
 * 
 * Default seed accounts utilize plaintext 'password' which maps to:
 * `$2b$10$nOUIs5kJ7naTuTFkBy1veuK0kSxUFXfuaOKdOKf9xYT0KKIGSJwFa`.
 * 
 * @name login
 * @route {POST} /api/auth/login
 * @bodyparam {String} email - User email.
 * @bodyparam {String} password - Plaintext password.
 */
router.post('/login', loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  const { email, password, rememberMe } = req.body;

  try {
    const result = await db.query(
      `
      SELECT * FROM Users
      WHERE LOWER(email) = LOWER($1)
         OR (username IS NOT NULL AND LOWER(username) = LOWER($1))
      LIMIT 1
      `,
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'This account has been disabled. Contact your gym owner.' });
    }

    const { isGymStaff } = require('../utils/roles');
    if (isGymStaff(user.role) && !user.branch_id) {
      return res.status(403).json({
        error: 'Your account is not assigned to a branch. Contact your gym owner.',
        code: 'STAFF_NO_BRANCH',
      });
    }

    if (isGymStaff(user.role) && user.branch_id && user.gym_id) {
      const branchCheck = await db.query(
        `SELECT is_active FROM Branches WHERE id = $1 AND gym_id = $2`,
        [user.branch_id, user.gym_id]
      );
      if (branchCheck.rows.length === 0 || branchCheck.rows[0].is_active === false) {
        return res.status(403).json({
          error: 'Your assigned branch is inactive. Contact your gym owner.',
          code: 'STAFF_BRANCH_INACTIVE',
        });
      }
    }

    const payload = buildTokenPayload(user);

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: rememberMe ? '30d' : '1d',
    });

    let subscription = null;
    let branch = null;
    if (user.gym_id) {
      const gymResult = await db.query(
        'SELECT name, subscription_status FROM Gyms WHERE id = $1',
        [user.gym_id]
      );
      if (gymResult.rows.length > 0) {
        const { describeGymSubscriptionAccess } = require('../utils/gymSubscriptionStatus');
        subscription = {
          gymName: gymResult.rows[0].name,
          ...describeGymSubscriptionAccess(gymResult.rows[0].subscription_status),
        };
      }
      if (user.branch_id) {
        const branchResult = await db.query(
          'SELECT id, name FROM Branches WHERE id = $1 AND gym_id = $2',
          [user.branch_id, user.gym_id]
        );
        if (branchResult.rows.length > 0) {
          branch = branchResult.rows[0];
        }
      }
    }

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username ?? null,
        role: user.role,
        gym_id: user.gym_id,
        branch_id: user.branch_id ?? null,
        branch_name: branch?.name ?? null,
      },
      subscription,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/register-admin
 * @description Registers a new platform-wide Administrator user account (No gym/tenant scope).
 * Useful for local setup and system administration.
 * 
 * @name register-admin
 * @route {POST} /api/auth/register-admin
 * @bodyparam {String} name - Admin's full name.
 * @bodyparam {String} email - Unique admin email address.
 * @bodyparam {String} password - Plaintext password (will be hashed with 10 salt rounds).
 * @header {String} X-Admin-Setup-Secret - Required in development; must match ADMIN_SETUP_SECRET.
 */
router.post('/register-admin', registerAdminLimiter, adminSetupGuard, validateBody(registerAdminSchema), async (req, res, next) => {
  const { name, email, password } = req.body;

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const insertQuery = `
      INSERT INTO Users (name, email, password, role, gym_id)
      VALUES ($1, $2, $3, $4, NULL)
      RETURNING id, name, email, role;
    `;
    const result = await db.query(insertQuery, [name, email, hashedPassword, ROLES.PLATFORM_ADMIN]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Unable to create account. Please try a different email.' });
    }
    next(error);
  }
});

const FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

/**
 * POST /api/auth/forgot-password/request-otp
 * Gym owner password reset — OTP to registered gym phone.
 */
router.post(
  '/forgot-password/request-otp',
  forgotPasswordLimiter,
  otpRequestLimiter,
  validateBody(requestForgotOtpSchema),
  async (req, res, next) => {
    const { username } = req.body;

    try {
      const result = await db.query(
        `
        SELECT u.id, u.role, g.phone
        FROM Users u
        JOIN Gyms g ON g.id = u.gym_id
        WHERE u.role = $1
          AND LOWER(u.username) = LOWER($2)
        LIMIT 1
        `,
        [ROLES.GYM_OWNER, username]
      );

      if (result.rows.length > 0 && result.rows[0].phone) {
        try {
          const { sessionId, expiresAt } = await startPhoneOtpSession(
            PURPOSE.FORGOT_PASSWORD,
            result.rows[0].phone,
            { userId: result.rows[0].id }
          );
          return res.json({ message: GENERIC_OTP_SENT, sessionId, expiresAt });
        } catch (otpErr) {
          console.error('[forgot-password] OTP send failed:', otpErr.message);
        }
      }

      res.json({ message: GENERIC_OTP_SENT });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/auth/forgot-password/reset-otp
 * Verify OTP and set a new password for gym owner.
 */
router.post(
  '/forgot-password/reset-otp',
  resetPasswordLimiter,
  otpVerifyLimiter,
  validateBody(resetForgotOtpSchema),
  async (req, res, next) => {
    const { sessionId, code, password: newPassword } = req.body;

    try {
      const session = await getActiveSession(sessionId, PURPOSE.FORGOT_PASSWORD);
      if (!session?.user_id) {
        return res.status(400).json({ error: 'Invalid or expired verification session.' });
      }

      await verifyOtp({
        verificationId: session.verification_id,
        phone: session.phone,
        code,
      });

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await db.query(
        `UPDATE Users SET password = $1, password_changed_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [hashedPassword, session.user_id]
      );
      await db.query('DELETE FROM PasswordResetTokens WHERE user_id = $1', [session.user_id]);
      await consumeSession(sessionId);

      res.json({ message: 'Password updated. You can sign in with your new password.' });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }
);

/**
 * POST /api/auth/forgot-password
 * Sends a reset link (or logs it when SMTP is not configured).
 */
router.post('/forgot-password', forgotPasswordLimiter, validateBody(forgotPasswordSchema), async (req, res, next) => {
  const { email } = req.body;

  try {
    const result = await db.query('SELECT id, name, email FROM Users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const { token } = await createPasswordResetToken(user.id);
      const resetUrl = `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

      await sendEmail({
        to: user.email,
        subject: 'Reset your VibeSaaS password',
        text: [
          `Hello ${user.name},`,
          '',
          'We received a request to reset your password.',
          `Use this link within 1 hour: ${resetUrl}`,
          '',
          'If you did not request this, you can ignore this email.',
        ].join('\n'),
      });
    }

    res.json({ message: FORGOT_PASSWORD_MESSAGE });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/reset-password
 * Sets a new password using a valid reset token.
 */
router.post('/reset-password', resetPasswordLimiter, validateBody(resetPasswordSchema), async (req, res, next) => {
  const { token, password: newPassword } = req.body;

  try {
    const userId = await consumeResetToken(token);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query(
      `UPDATE Users SET password = $1, password_changed_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [hashedPassword, userId]
    );
    await db.query('DELETE FROM PasswordResetTokens WHERE user_id = $1', [userId]);

    res.json({ message: 'Password updated. You can sign in with your new password.' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/change-password
 * Authenticated user changes password (requires current password).
 */
router.post('/change-password', changePasswordLimiter, auth, validateBody(changePasswordSchema), async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  try {
    const result = await db.query('SELECT id, password FROM Users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query(
      `UPDATE Users SET password = $1, password_changed_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [hashedPassword, user.id]
    );
    await db.query('DELETE FROM PasswordResetTokens WHERE user_id = $1', [user.id]);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;