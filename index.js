/**
 * @file index.js
 * @description LEGACY monolithic entry — not for production. Use `npm start` (server.js).
 */

if (process.env.NODE_ENV === 'production') {
  console.error('FATAL: index.js must not run in production. Use server.js (npm start).');
  process.exit(1);
}

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const db = require('./config/db');
const { isPlatformAdmin } = require('./utils/roles');
require('dotenv').config();

const app = express();
app.use(express.json());

// CORS Middleware to allow React Frontend connectivity
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

/**
 * Legacy Database Table Initialization & Seeding (SaaS Core Automation).
 * Assumes the schema script is inside the same root directory.
 * 
 * @async
 * @function initializeDatabase
 * @returns {Promise<void>}
 */
async function initializeDatabase() {
  try {
    console.log('Checking database connection & creating tables...');
    const schemaPath = path.join(__dirname, 'schema.sql');
    
    if (!fs.existsSync(schemaPath)) {
      console.error('Error: schema.sql file not found in backend folder!');
      return;
    }

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the DDL schema inside your PostgreSQL gym_saas database
    await db.query(schemaSql);
    console.log('Database tables verified, created, and seeded successfully.');
  } catch (err) {
    console.error('Critical: Error occurred during automatic table creation:', err.message);
  }
}

/**
 * Legacy JWT Token Verification Middleware.
 * Extracts JWT from authorization header and decodes user session context.
 * 
 * @function authenticateToken
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next handler
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ message: 'Token required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
}

/**
 * Legacy Multi-Tenant & SaaS Subscription Guard Middleware.
 * Verifies that the tenant gym has an active subscription status.
 * Bypasses for administrators.
 * 
 * @async
 * @function checkTenantAccess
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next handler
 */
async function checkTenantAccess(req, res, next) {
  if (isPlatformAdmin(req.user.role)) return next();

  const gymId = req.user.gym_id;
  if (!gymId) return res.status(403).json({ message: 'No tenant assigned' });

  try {
    const gymQuery = await db.query(
      'SELECT subscription_status FROM Gyms WHERE id = $1',
      [gymId]
    );

    if (gymQuery.rows.length === 0) {
      return res.status(404).json({ message: 'Gym not found' });
    }

    const status = (gymQuery.rows[0].subscription_status || '').trim().toLowerCase();
    if (status !== 'active') {
      return res.status(403).json({ 
        message: 'Your gym subscription is inactive or suspended. Please contact admin.',
        status: status 
      });
    }

    req.gymId = gymId;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// --- AUTH ENDPOINTS ---

// Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userQuery = await db.query('SELECT * FROM Users WHERE email = $1', [email]);
    if (userQuery.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = userQuery.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    let gymName = 'Platform Admin';
    if (user.gym_id) {
      const gymQuery = await db.query('SELECT name FROM Gyms WHERE id = $1', [user.gym_id]);
      if (gymQuery.rows.length > 0) gymName = gymQuery.rows[0].name;
    }

    const token = jwt.sign(
      { id: user.id, name: gymName, email: user.email, role: user.role, gym_id: user.gym_id },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- PLANS ENDPOINTS (FR-6) ---

app.get('/api/plans', authenticateToken, checkTenantAccess, async (req, res) => {
  try {
    const query = isPlatformAdmin(req.user.role)
      ? 'SELECT * FROM Plans' 
      : 'SELECT * FROM Plans WHERE gym_id = $1';
    const params = isPlatformAdmin(req.user.role) ? [] : [req.gymId];

    const plans = await db.query(query, params);
    res.json(plans.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/plans', authenticateToken, checkTenantAccess, async (req, res) => {
  const { name, duration, price } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO Plans (gym_id, name, duration, price) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.gymId, name, duration, price]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/plans/:id', authenticateToken, checkTenantAccess, async (req, res) => {
  const { id } = req.params;
  const { name, duration, price } = req.body;
  try {
    const result = await db.query(
      'UPDATE Plans SET name = $1, duration = $2, price = $3 WHERE id = $4 AND gym_id = $5 RETURNING *',
      [name, duration, price, id, req.gymId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Plan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/plans/:id', authenticateToken, checkTenantAccess, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      'DELETE FROM Plans WHERE id = $1 AND gym_id = $2 RETURNING *',
      [id, req.gymId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Plan not found' });
    res.json({ message: 'Plan deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- MEMBERS ENDPOINTS (FR-5) ---

app.get('/api/members', authenticateToken, checkTenantAccess, async (req, res) => {
  try {
    const query = isPlatformAdmin(req.user.role)
      ? 'SELECT * FROM Members'
      : 'SELECT * FROM Members WHERE gym_id = $1';
    const params = isPlatformAdmin(req.user.role) ? [] : [req.gymId];

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/members', authenticateToken, checkTenantAccess, async (req, res) => {
  const { name, phone, plan_id, start_date, end_date } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO Members (gym_id, name, phone, plan_id, start_date, end_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.gymId, name, phone, plan_id, start_date, end_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/members/:id', authenticateToken, checkTenantAccess, async (req, res) => {
  const { id } = req.params;
  const { name, phone, plan_id, start_date, end_date, status } = req.body;
  try {
    const result = await db.query(
      'UPDATE Members SET name = $1, phone = $2, plan_id = $3, start_date = $4, end_date = $5, status = $6 WHERE id = $7 AND gym_id = $8 RETURNING *',
      [name, phone, plan_id, start_date, end_date, status, id, req.gymId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/members/:id', authenticateToken, checkTenantAccess, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      'DELETE FROM Members WHERE id = $1 AND gym_id = $2 RETURNING *',
      [id, req.gymId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Member not found' });
    res.json({ message: 'Member deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- PAYMENTS ENDPOINTS (FR-7) ---

app.get('/api/payments', authenticateToken, checkTenantAccess, async (req, res) => {
  try {
    const query = isPlatformAdmin(req.user.role)
      ? 'SELECT * FROM Payments'
      : 'SELECT * FROM Payments WHERE gym_id = $1';
    const params = isPlatformAdmin(req.user.role) ? [] : [req.gymId];

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/payments', authenticateToken, checkTenantAccess, async (req, res) => {
  const { member_id, amount, date, method } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO Payments (member_id, gym_id, amount, date, method, source) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [member_id, req.gymId, amount, date, method, 'collect']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  // Automatically create & seed database on startup
  await initializeDatabase();
  console.log(`Backend server is running on http://localhost:${PORT}`);
});