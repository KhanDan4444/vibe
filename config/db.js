const { Pool, types } = require('pg');
require('dotenv').config();

// Keep DATE columns as YYYY-MM-DD strings — avoids UTC shift when serializing to JSON.
types.setTypeParser(1082, (value) => value);

function buildPoolConfig() {
  const shared = {
    max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) || 30_000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10) || 5_000,
  };

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === '0' ? false : { rejectUnauthorized: false },
      ...shared,
    };
  }

  const config = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    ...shared,
  };

  if (process.env.DB_SSL === '1') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

async function checkConnection() {
  await pool.query('SELECT 1');
  return true;
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  checkConnection,
};
