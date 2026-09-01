/**
 * @file server.js
 * @description Gym SaaS Express REST API Entry Point.
 */

require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start.');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error);
  process.exit(1);
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const db = require('./config/db');
const { runDailyExpiryCheck } = require('./jobs/expiryCheck');
const { startScheduler, stopScheduler } = require('./jobs/scheduler');
const {
  resolveAllowedOrigins,
  validateCorsConfig,
  createCorsMiddleware,
} = require('./middleware/cors');
const { apiLimiter } = require('./middleware/rateLimiters');

const app = express();
const PORT = process.env.PORT || 5000;

if (process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const allowedOrigins = resolveAllowedOrigins();
validateCorsConfig(allowedOrigins);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(createCorsMiddleware(allowedOrigins));

async function initializeDatabase() {
  try {
    const isProduction = process.env.NODE_ENV === 'production';
    const runBootstrap =
      process.env.RUN_SCHEMA_BOOTSTRAP === '1' || (!isProduction && process.env.RUN_SCHEMA_BOOTSTRAP !== '0');

    if (!runBootstrap) {
      console.log(
        'Skipping schema.sql bootstrap (production). Apply schema with: npm run db:migrate'
      );
      await db.checkConnection();
      console.log('Database connection OK.');
      return;
    }

    console.log('Checking database connection & creating tables (schema bootstrap)...');
    const schemaPath = path.join(__dirname, 'schema.sql');

    if (!fs.existsSync(schemaPath)) {
      console.error('Error: schema.sql file not found in backend folder!');
      return;
    }

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await db.query(schemaSql);
    console.log('Database tables verified and created successfully.');

    if (!isProduction) {
      const seedPath = path.join(__dirname, 'seed.dev.sql');
      if (fs.existsSync(seedPath)) {
        await db.query(fs.readFileSync(seedPath, 'utf8'));
        console.log('Dev seed data applied.');
      }
    }
  } catch (err) {
    console.error('Critical: Error occurred during automatic table creation:', err.message);
    process.exit(1);
  }
}

const authRoutes = require('./routes/auth');
const planRoutes = require('./routes/plans');
const memberRoutes = require('./routes/members');
const paymentRoutes = require('./routes/payments');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const adminSaasPlanRoutes = require('./routes/adminSaasPlans');
const reportRoutes = require('./routes/reports');
const gymProfileRoutes = require('./routes/gymProfile');
const gymSubscriptionRoutes = require('./routes/gymSubscription');
const gymTeamRoutes = require('./routes/gymTeam');
const auditLogRoutes = require('./routes/auditLogs');
const branchRoutes = require('./routes/branches');
const memberSmsRoutes = require('./routes/memberSms');
const telegramRoutes = require('./routes/telegram');
const { ensureWebhookRegistered, setMyCommands } = require('./utils/telegramBot');

app.use('/api/telegram', telegramRoutes);
app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/gym/profile', gymProfileRoutes);
app.use('/api/gym/subscription', gymSubscriptionRoutes);
app.use('/api/gym/team', gymTeamRoutes);
app.use('/api/gym/trainers', require('./routes/gymTrainers'));
app.use('/api/check-ins', require('./routes/checkIns'));
app.use('/api/gym/activity', auditLogRoutes);
app.use('/api/gym/member-sms', memberSmsRoutes);
app.use('/api/gym/branches', branchRoutes);
app.use('/api/public', require('./routes/publicMemberPass'));
app.use('/api/public', require('./routes/publicStationCheckIn'));
app.use('/api/admin', adminRoutes);
app.use('/api/admin/saas-plans', adminSaasPlanRoutes);

app.get('/', (req, res) => {
  res.send('Gym SaaS API Server Running');
});

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try {
    await db.checkConnection();
    dbOk = true;
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
  }

  const isProduction = process.env.NODE_ENV === 'production';
  res.status(dbOk ? 200 : 503).json(
    isProduction
      ? { ok: dbOk }
      : { ok: dbOk, service: 'gym-saas-api', db: dbOk ? 'connected' : 'unavailable' }
  );
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdown(server, signal) {
  console.log(`[shutdown] ${signal} received, closing server...`);
  stopScheduler();

  server.close(async () => {
    try {
      await db.pool.end();
      console.log('[shutdown] Complete.');
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] Error draining DB pool:', err.message);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('[shutdown] Forced exit after timeout.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

const server = app.listen(PORT, async () => {
  await initializeDatabase();

  console.log(`Server is running on http://localhost:${PORT}`);

  try {
    console.log('[Notification Engine] Initializing daily membership check...');
    await runDailyExpiryCheck();
  } catch (jobError) {
    console.error('Failed to run initial daily expiry check:', jobError.message);
  }

  startScheduler();

  try {
    const webhook = await ensureWebhookRegistered();
    if (webhook.ok) {
      console.log(`[Telegram] Webhook registered: ${webhook.url}`);
    }
  } catch (err) {
    console.warn('[Telegram] Webhook registration skipped:', err.message);
  }

  try {
    const commands = await setMyCommands();
    if (commands.ok) {
      console.log('[Telegram] Bot commands registered.');
    }
  } catch (err) {
    console.warn('[Telegram] Bot commands skipped:', err.message);
  }
});

process.on('SIGTERM', () => shutdown(server, 'SIGTERM'));
process.on('SIGINT', () => shutdown(server, 'SIGINT'));
