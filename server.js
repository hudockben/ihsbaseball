const express = require('express');
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ihs-calendar-secret-change-in-production';

// @neondatabase/serverless uses the DATABASE_URL env var
// sql`` tagged template returns rows as a plain array
const sql = neon(process.env.DATABASE_URL || '');

// Indiana County, PA coordinates (zip 15710 area)
const NOAA_LAT = 40.6217;
const NOAA_LON = -79.1552;

let noaaGridCache = null;
let dbInitialized = false;

/* ─── Database Init ──────────────────────────────────────────────────────────── */
async function initDB() {
  if (dbInitialized) return;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      location    TEXT NOT NULL,
      event_date  DATE NOT NULL,
      event_time  TIME NOT NULL,
      details     TEXT DEFAULT '',
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Seed default admin only when the table is empty
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (rows[0].count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await sql`INSERT INTO users (username, password_hash) VALUES ('admin', ${hash})`;
    console.log('Default admin seeded: username=admin password=admin123');
  }

  dbInitialized = true;
}

// Normalise Postgres DATE/TIME columns to plain strings the frontend expects
function normalizeEvent(row) {
  const event_date =
    row.event_date instanceof Date
      ? row.event_date.toISOString().slice(0, 10)
      : String(row.event_date).slice(0, 10);

  const event_time = String(row.event_time).slice(0, 5); // HH:MM

  return { ...row, event_date, event_time };
}

/* ─── Middleware ─────────────────────────────────────────────────────────────── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Run DB init before every API request (idempotent, fast after first call)
app.use('/api', async (req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init error:', err);
    res.status(500).json({ error: 'Database initialisation failed: ' + err.message });
  }
});

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* ─── Auth Routes ────────────────────────────────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const rows = await sql`SELECT * FROM users WHERE username = ${username}`;
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ token, username: user.username });
});

app.post('/api/auth/create-user', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    await sql`INSERT INTO users (username, password_hash) VALUES (${username}, ${hash})`;
    res.json({ message: `User "${username}" created successfully` });
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const rows = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
  if (!bcrypt.compareSync(current_password, rows[0].password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${req.user.id}`;
  res.json({ message: 'Password changed successfully' });
});

app.get('/api/auth/users', requireAuth, async (req, res) => {
  const rows = await sql`SELECT id, username, created_at FROM users ORDER BY username`;
  res.json(rows);
});

app.delete('/api/auth/users/:id', requireAuth, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await sql`DELETE FROM users WHERE id = ${targetId}`;
  res.json({ message: 'User deleted' });
});

/* ─── Events Routes ──────────────────────────────────────────────────────────── */
app.get('/api/events', async (req, res) => {
  const { from, to } = req.query;

  let rows;
  if (from && to) {
    rows = await sql`
      SELECT * FROM events
      WHERE event_date >= ${from} AND event_date <= ${to}
      ORDER BY event_date ASC, event_time ASC
    `;
  } else if (from) {
    rows = await sql`
      SELECT * FROM events
      WHERE event_date >= ${from}
      ORDER BY event_date ASC, event_time ASC
    `;
  } else if (to) {
    rows = await sql`
      SELECT * FROM events
      WHERE event_date <= ${to}
      ORDER BY event_date ASC, event_time ASC
    `;
  } else {
    rows = await sql`SELECT * FROM events ORDER BY event_date ASC, event_time ASC`;
  }

  res.json(rows.map(normalizeEvent));
});

app.post('/api/events', requireAuth, async (req, res) => {
  const { title, location, event_date, event_time, details } = req.body;
  if (!title || !location || !event_date || !event_time) {
    return res.status(400).json({ error: 'Title, location, date, and time are required' });
  }

  const rows = await sql`
    INSERT INTO events (title, location, event_date, event_time, details, created_by)
    VALUES (${title}, ${location}, ${event_date}, ${event_time}, ${details || ''}, ${req.user.username})
    RETURNING *
  `;
  res.status(201).json(normalizeEvent(rows[0]));
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  const { title, location, event_date, event_time, details } = req.body;
  if (!title || !location || !event_date || !event_time) {
    return res.status(400).json({ error: 'Title, location, date, and time are required' });
  }

  const rows = await sql`
    UPDATE events
    SET title      = ${title},
        location   = ${location},
        event_date = ${event_date},
        event_time = ${event_time},
        details    = ${details || ''},
        updated_at = NOW()
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  if (!rows.length) return res.status(404).json({ error: 'Event not found' });
  res.json(normalizeEvent(rows[0]));
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const rows = await sql`DELETE FROM events WHERE id = ${req.params.id} RETURNING id`;
  if (!rows.length) return res.status(404).json({ error: 'Event not found' });
  res.json({ message: 'Event deleted' });
});

/* ─── Weather Route (NOAA proxy) ─────────────────────────────────────────────── */
async function getNoaaGrid() {
  if (noaaGridCache) return noaaGridCache;
  const res = await fetch(
    `https://api.weather.gov/points/${NOAA_LAT},${NOAA_LON}`,
    {
      headers: { 'User-Agent': 'IHS-Calendar/1.0 (contact@example.com)' },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`NOAA points API returned ${res.status}`);
  const data = await res.json();
  noaaGridCache = { forecastUrl: data.properties.forecast };
  return noaaGridCache;
}

app.get('/api/weather', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date parameter required (YYYY-MM-DD)' });

  try {
    const grid = await getNoaaGrid();
    const forecastRes = await fetch(grid.forecastUrl, {
      headers: { 'User-Agent': 'IHS-Calendar/1.0 (contact@example.com)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!forecastRes.ok) return res.json({ forecast: 'Weather unavailable', icon: 'cloudy' });

    const forecastData = await forecastRes.json();
    const periods = forecastData.properties.periods;

    const target = new Date(date + 'T12:00:00');
    const matched =
      periods.find(p => target >= new Date(p.startTime) && target < new Date(p.endTime)) ||
      periods.find(p => p.startTime.startsWith(date) && p.isDaytime) ||
      periods.find(p => p.startTime.startsWith(date));

    if (!matched) return res.json({ forecast: 'Forecast not yet available', icon: 'unknown' });

    const short = (matched.shortForecast || '').toLowerCase();
    let icon = 'partly';
    if (short.includes('thunder') || short.includes('storm'))                             icon = 'storm';
    else if (short.includes('snow') || short.includes('blizzard'))                        icon = 'snow';
    else if (short.includes('rain') || short.includes('shower') || short.includes('drizzle')) icon = 'rain';
    else if (short.includes('cloud') || short.includes('overcast'))                       icon = 'cloudy';
    else if (short.includes('clear') || (short.includes('sunny') && !short.includes('partly'))) icon = 'sunny';

    res.json({
      forecast: matched.shortForecast,
      temperature: matched.temperature,
      temperatureUnit: matched.temperatureUnit,
      windSpeed: matched.windSpeed,
      windDirection: matched.windDirection,
      icon,
    });
  } catch (err) {
    console.error('Weather error:', err.message);
    res.json({ forecast: 'Weather unavailable', icon: 'cloudy' });
  }
});

/* ─── SPA Fallback ───────────────────────────────────────────────────────────── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── Start (local dev only) ─────────────────────────────────────────────────── */
if (require.main === module) {
  app.listen(PORT, () => console.log(`IHS Calendar → http://localhost:${PORT}`));
}

module.exports = app;
