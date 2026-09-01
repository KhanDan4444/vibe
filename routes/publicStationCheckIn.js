/**
 * @file routes/publicStationCheckIn.js
 * @description Public member self check-in at branch station QR (Telegram OTP).
 */

const express = require('express');
const { z } = require('zod');
const router = express.Router();
const { validateBody, validateQuery } = require('../middleware/validate');
const {
  publicMemberPassLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
} = require('../middleware/rateLimiters');
const {
  getStationSession,
  requestStationOtp,
  verifyStationOtp,
  trustedStationCheckIn,
} = require('../utils/stationSelfCheckIn');

const stationQuerySchema = z.object({
  station: z.string().trim().min(20).max(4000),
});

const requestOtpSchema = z.object({
  station: z.string().trim().min(20).max(4000),
  phone: z.string().trim().min(7).max(30),
});

const verifyOtpSchema = z.object({
  station: z.string().trim().min(20).max(4000),
  phone: z.string().trim().min(7).max(30),
  session_id: z.string().uuid(),
  otp: z.string().trim().min(4).max(10),
});

const checkInSchema = z.object({
  station: z.string().trim().min(20).max(4000),
});

/** GET /api/public/station-check-in/session?station=JWT */
router.get('/station-check-in/session', publicMemberPassLimiter, validateQuery(stationQuerySchema), async (req, res, next) => {
  try {
    const result = await getStationSession(req.query.station, req);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.error,
        code: result.code,
      });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/** POST /api/public/station-check-in/request-otp */
router.post(
  '/station-check-in/request-otp',
  publicMemberPassLimiter,
  otpRequestLimiter,
  validateBody(requestOtpSchema),
  async (req, res, next) => {
    try {
      const result = await requestStationOtp(req.body.station, req.body.phone);
      if (!result.ok) {
        return res.status(result.status || 400).json({
          error: result.error,
          code: result.code,
        });
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

/** POST /api/public/station-check-in/verify-otp */
router.post(
  '/station-check-in/verify-otp',
  publicMemberPassLimiter,
  otpVerifyLimiter,
  validateBody(verifyOtpSchema),
  async (req, res, next) => {
    try {
      const result = await verifyStationOtp(
        req.body.station,
        {
          sessionId: req.body.session_id,
          otp: req.body.otp,
          phone: req.body.phone,
        },
        res
      );
      if (!result.ok) {
        return res.status(result.status || 400).json({
          error: result.error,
          code: result.code,
          visits_this_week: result.visits_this_week,
          visits_limit: result.visits_limit,
        });
      }
      res.status(result.status || 201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

/** POST /api/public/station-check-in/check-in — trusted device */
router.post(
  '/station-check-in/check-in',
  publicMemberPassLimiter,
  validateBody(checkInSchema),
  async (req, res, next) => {
    try {
      const result = await trustedStationCheckIn(req.body.station, req, res);
      if (!result.ok) {
        return res.status(result.status || 400).json({
          error: result.error,
          code: result.code,
          visits_this_week: result.visits_this_week,
          visits_limit: result.visits_limit,
        });
      }
      res.status(result.status || 201).json(result);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
