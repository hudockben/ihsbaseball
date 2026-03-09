const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ihs-calendar-secret-2024-change-in-production';

// Indiana County, PA coordinates (center of county, zip 15701 area)
const NOAA_LAT = 40.6217;
const NOAA_LON = -79.1552;

// Database setup
const db = new Database(path.join(__dirname, 'calendar.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_time TEXT NOT NULL,
    details TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default admin if no users exist
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
  console.log('Default admin created: username=admin, password=admin123');
  console.log('IMPORTANT: Change this password after first login!');
}

// Cache for NOAA grid info
let noaaGridCache = null;

async function getNoaaGrid() {
  if (noaaGridCache) return noaaGridCache;
  try {
    const res = await fetch(
      `https://api.weather.gov/points/${NOAA_LAT},${NOAA_LON}`,
      { headers: { 'User-Agent': 'IHS-Calendar/1.0 (contact@example.com)' } }
    );
    if (!res.ok) throw new Error(`NOAA points failed: ${res.status}`);
    const data = await res.json();
    noaaGridCache = {
      forecastUrl: data.properties.forecast,
      forecastHourlyUrl: data.properties.forecastHourly,
    };
    return noaaGridCache;
  } catch (err) {
    console.error('NOAA grid fetch error:', err.message);
    return null;
  }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Auth Routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, username: user.username });
});

// Create a new user (admin only)
app.post('/api/auth/create-user', requireAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    res.json({ message: `User "${username}" created successfully` });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Change password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ message: 'Password changed successfully' });
});

// List users (admin only)
app.get('/api/auth/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all();
  res.json(users);
});

// Delete user (admin only, cannot delete yourself)
app.delete('/api/auth/users/:id', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ message: 'User deleted' });
});

// ─── Events Routes ─────────────────────────────────────────────────────────────

// Get events with optional date range filter
app.get('/api/events', (req, res) => {
  const { from, to } = req.query;

  let query = 'SELECT * FROM events WHERE 1=1';
  const params = [];

  if (from) {
    query += ' AND event_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND event_date <= ?';
    params.push(to);
  }

  query += ' ORDER BY event_date ASC, event_time ASC';

  const events = db.prepare(query).all(...params);
  res.json(events);
});

// Create event
app.post('/api/events', requireAuth, (req, res) => {
  const { title, location, event_date, event_time, details } = req.body;
  if (!title || !location || !event_date || !event_time) {
    return res.status(400).json({ error: 'Title, location, date, and time are required' });
  }

  const result = db.prepare(
    'INSERT INTO events (title, location, event_date, event_time, details, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, location, event_date, event_time, details || '', req.user.username);

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(event);
});

// Update event
app.put('/api/events/:id', requireAuth, (req, res) => {
  const { title, location, event_date, event_time, details } = req.body;
  if (!title || !location || !event_date || !event_time) {
    return res.status(400).json({ error: 'Title, location, date, and time are required' });
  }

  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });

  db.prepare(
    `UPDATE events SET title=?, location=?, event_date=?, event_time=?, details=?, updated_at=datetime('now') WHERE id=?`
  ).run(title, location, event_date, event_time, details || '', req.params.id);

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  res.json(event);
});

// Delete event
app.delete('/api/events/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });

  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ message: 'Event deleted' });
});

// ─── Weather Route ──────────────────────────────────────────────────────────────

app.get('/api/weather', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date parameter required (YYYY-MM-DD)' });

  try {
    const grid = await getNoaaGrid();
    if (!grid) return res.json({ forecast: 'Weather unavailable', icon: 'cloudy' });

    const forecastRes = await fetch(grid.forecastUrl, {
      headers: { 'User-Agent': 'IHS-Calendar/1.0 (contact@example.com)' }
    });
    if (!forecastRes.ok) return res.json({ forecast: 'Weather unavailable', icon: 'cloudy' });

    const forecastData = await forecastRes.json();
    const periods = forecastData.properties.periods;

    // Find the period that matches the requested date
    const targetDate = new Date(date + 'T12:00:00');
    let matched = null;

    for (const period of periods) {
      const start = new Date(period.startTime);
      const end = new Date(period.endTime);
      if (targetDate >= start && targetDate < end) {
        matched = period;
        break;
      }
    }

    // If no exact match, find the daytime period closest to the date
    if (!matched) {
      const dateStr = date; // YYYY-MM-DD
      matched = periods.find(p => p.startTime.startsWith(dateStr) && p.isDaytime);
      if (!matched) matched = periods.find(p => p.startTime.startsWith(dateStr));
    }

    if (!matched) {
      return res.json({ forecast: 'Forecast not yet available', icon: 'unknown' });
    }

    // Determine icon type from shortForecast
    const short = (matched.shortForecast || '').toLowerCase();
    let icon = 'sunny';
    if (short.includes('thunder') || short.includes('storm')) icon = 'storm';
    else if (short.includes('snow') || short.includes('blizzard')) icon = 'snow';
    else if (short.includes('rain') || short.includes('shower') || short.includes('drizzle')) icon = 'rain';
    else if (short.includes('cloud') || short.includes('overcast')) icon = 'cloudy';
    else if (short.includes('partly') || short.includes('mostly sunny') || short.includes('mostly clear')) icon = 'partly';
    else if (short.includes('clear') || short.includes('sunny')) icon = 'sunny';
    else icon = 'partly';

    res.json({
      forecast: matched.shortForecast,
      temperature: matched.temperature,
      temperatureUnit: matched.temperatureUnit,
      windSpeed: matched.windSpeed,
      windDirection: matched.windDirection,
      icon,
      isDaytime: matched.isDaytime,
    });
  } catch (err) {
    console.error('Weather fetch error:', err.message);
    res.json({ forecast: 'Weather unavailable', icon: 'cloudy' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`IHS Calendar running at http://localhost:${PORT}`);
});
