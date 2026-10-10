/**
 * @file routes/publicSupport.js
 * @description Public platform support contact (no auth).
 */

const express = require('express');
const router = express.Router();
const { getSupportContact } = require('../utils/supportContact');

/**
 * GET /api/public/support
 */
router.get('/support', (req, res) => {
  res.json(getSupportContact());
});

module.exports = router;
