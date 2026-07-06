/**
 * Daily expiry check scheduler — midnight UTC via node-cron.
 */
const cron = require('node-cron');
const { runDailyExpiryCheck } = require('./expiryCheck');

let task = null;

function startScheduler() {
  if (task) {
    return task;
  }

  console.log('[Scheduler] Daily expiry check scheduled at 00:00 UTC');

  task = cron.schedule(
    '0 0 * * *',
    () => {
      runDailyExpiryCheck().catch((err) => {
        console.error('[Scheduler] Daily expiry check failed:', err.message);
      });
    },
    { scheduled: true }
  );

  return task;
}

function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
};
