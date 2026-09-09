#!/usr/bin/env node
/**
 * Start the API with local/dev OTP (no Afro/hahu) for smoke tests.
 * Usage: node scripts/start-smoke-api.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Keep keys set (empty) so later dotenv.config() calls do not reload SMS credentials.
process.env.AFRO_MESSAGE_TOKEN = '';
process.env.AFRO_MESSAGE_IDENTIFIER = '';
process.env.AFRO_MESSAGE_SENDER = '';
process.env.AFRO_MESSAGE_FROM = '';
process.env.HAHU_API_SECRET = '';
process.env.HAHU_DEVICE_ID = '';
process.env.SMS_PROVIDER = '';
process.env.GYM_SIGNUP_TRIAL_DAYS = process.env.GYM_SIGNUP_TRIAL_DAYS || '0';
process.env.PUBLIC_GYM_SIGNUP_ENABLED = process.env.PUBLIC_GYM_SIGNUP_ENABLED || '1';

require('../server.js');
