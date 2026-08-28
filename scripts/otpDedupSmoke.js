/**
 * Shared OTP dedup checks — exercises startPhoneOtpSession directly with local SMS
 * so smoke tests do not depend on Afro/hahu credentials or verified numbers.
 */

function isolateLocalSmsEnv() {
  process.env.SMS_PROVIDER = '';
  delete process.env.AFRO_MESSAGE_TOKEN;
  delete process.env.HAHU_API_SECRET;
  delete process.env.HAHU_DEVICE_ID;

  for (const key of Object.keys(require.cache)) {
    if (
      key.endsWith('/utils/smsProvider.js') ||
      key.endsWith('/utils/phoneOtp.js') ||
      key.endsWith('/utils/afroMessage.js') ||
      key.endsWith('/utils/hahuMessage.js')
    ) {
      delete require.cache[key];
    }
  }
}

/**
 * @param {{ assert: (label: string, condition: boolean, detail?: string) => void, db: { query: Function } }} ctx
 */
async function runOtpDedupSmoke({ assert, db }) {
  isolateLocalSmsEnv();
  const { startPhoneOtpSession, PURPOSE } = require('../utils/phoneOtp');
  const { normalizeEthiopianPhone } = require('../utils/phone');

  const suffix = String(Date.now()).slice(-7);
  const phone = `091${suffix}`;
  const normalized = normalizeEthiopianPhone(phone);
  assert('Smoke OTP phone normalizes', Boolean(normalized), phone);

  const parallel = 5;
  const results = await Promise.all(
    Array.from({ length: parallel }, () => startPhoneOtpSession(PURPOSE.GYM_SIGNUP, phone))
  );

  const sessionIds = [...new Set(results.map((r) => r.sessionId).filter(Boolean))];
  assert('Parallel OTP sessions share one id', sessionIds.length === 1, sessionIds.join(', '));

  const freshSends = results.filter((r) => !r.reused);
  assert('Parallel OTP sends at most one fresh SMS', freshSends.length <= 1, `fresh=${freshSends.length}`);

  const sessions = await db.query(
    `
    SELECT COUNT(*)::int AS n
    FROM PhoneOtpSessions
    WHERE purpose = 'gym_signup'
      AND phone = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
    `,
    [normalized]
  );
  assert('Single active OTP session in DB', sessions.rows[0].n === 1, `count=${sessions.rows[0].n}`);

  const smsRows = await db.query(
    `
    SELECT COUNT(*)::int AS n
    FROM SmsLog
    WHERE message_type = 'otp_gym_signup'
      AND recipient_phone = $1
      AND sent_at > NOW() - INTERVAL '2 minutes'
    `,
    [normalized]
  );
  assert(
    'At most one OTP SMS log row for parallel burst',
    smsRows.rows[0].n <= 1,
    `smsLog=${smsRows.rows[0].n}`
  );

  const resend = await startPhoneOtpSession(PURPOSE.GYM_SIGNUP, phone);
  assert('OTP resend within cooldown succeeds', Boolean(resend.sessionId));
  assert('OTP resend returns reused flag', resend.reused === true);
  assert('OTP resend keeps same session', resend.sessionId === sessionIds[0]);

  await db.query('DELETE FROM PhoneOtpSessions WHERE phone = $1 AND purpose = $2', [
    normalized,
    'gym_signup',
  ]);
}

module.exports = { runOtpDedupSmoke };
