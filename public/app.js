/* ─── State ───────────────────────────────────────────────────────────────────── */
const state = {
  token: localStorage.getItem('ihs_token') || null,
  username: localStorage.getItem('ihs_username') || null,
  events: [],
  currentRange: 'week',
  customFrom: null,
  customTo: null,
  pendingDeleteId: null,
  weatherCache: {},
};

/* ─── Utilities ──────────────────────────────────────────────────────────────── */
function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }
function showOverlay(id) { document.getElementById(id).classList.add('active'); }
function hideOverlay(id) { document.getElementById(id).classList.remove('active'); }

function fmt(el, msg) {
  el.textContent = msg;
  show(el);
}

function clearMsg(el) {
  el.textContent = '';
  hide(el);
}

function formatDate(dateStr) {
  // dateStr is YYYY-MM-DD, avoid timezone shift by appending T00:00:00
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(timeStr) {
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function endOfMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/* ─── Range Calculation ──────────────────────────────────────────────────────── */
function getRangeDates(range) {
  const today = todayStr();
  switch (range) {
    case 'week':    return { from: today, to: addDays(today, 6) };
    case '2weeks':  return { from: today, to: addDays(today, 13) };
    case 'month':   return { from: today, to: endOfMonth(today) };
    case '3months': return { from: today, to: addMonths(today, 3) };
    case 'all':     return { from: today, to: null };
    case 'custom':  return { from: state.customFrom, to: state.customTo };
    default:        return { from: today, to: null };
  }
}

/* ─── API Helpers ────────────────────────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ─── Weather ─────────────────────────────────────────────────────────────────── */
const WEATHER_ICONS = {
  sunny:  '☀️',
  partly: '⛅',
  cloudy: '☁️',
  rain:   '🌧️',
  storm:  '⛈️',
  snow:   '❄️',
  unknown:'🌡️',
};

async function fetchWeather(date) {
  if (state.weatherCache[date]) return state.weatherCache[date];
  try {
    const data = await apiFetch(`/api/weather?date=${date}`);
    state.weatherCache[date] = data;
    return data;
  } catch {
    return { forecast: 'Weather unavailable', icon: 'cloudy' };
  }
}

async function injectWeather(cardEl, date) {
  const container = cardEl.querySelector('.card-weather');
  if (!container) return;

  const today = todayStr();
  const eventDate = new Date(date + 'T00:00:00');
  const todayDate = new Date(today + 'T00:00:00');
  const diffDays = Math.round((eventDate - todayDate) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    container.innerHTML = `<span class="weather-na">Event has passed</span>`;
    return;
  }
  if (diffDays > 7) {
    container.innerHTML = `<span class="weather-na">Forecast available within 7 days</span>`;
    return;
  }

  container.innerHTML = `<span class="weather-loading">Loading forecast...</span>`;
  const w = await fetchWeather(date);
  const icon = WEATHER_ICONS[w.icon] || WEATHER_ICONS.unknown;

  let tempStr = '';
  if (w.temperature !== undefined) {
    tempStr = `${w.temperature}°${w.temperatureUnit || 'F'}`;
  }

  let windStr = '';
  if (w.windSpeed) {
    windStr = `${w.windDirection || ''} ${w.windSpeed}`.trim();
  }

  container.innerHTML = `
    <span class="weather-icon">${icon}</span>
    <div class="weather-text">
      ${tempStr ? `<div class="weather-temp">${tempStr}</div>` : ''}
      <div class="weather-desc">${w.forecast || 'N/A'}</div>
      ${windStr ? `<div class="weather-wind">💨 ${windStr}</div>` : ''}
    </div>
  `;
}

/* ─── Card Rendering ─────────────────────────────────────────────────────────── */
function buildCard(event, index) {
  const card = document.createElement('article');
  card.className = 'event-card';
  card.dataset.id = event.id;

  card.innerHTML = `
    <span class="suit-corner tl">⚾</span>
    <span class="suit-corner tr">⚾</span>

    <div class="card-header">
      <div class="card-event-title">${escHtml(event.title)}</div>
    </div>

    <div class="card-body">
      <div class="card-field">
        <span class="card-field-icon">📍</span>
        <div class="card-field-content">
          <span class="card-field-label">Location</span>
          <span class="card-field-value">${escHtml(event.location)}</span>
        </div>
      </div>

      <div class="card-datetime">
        <div class="card-field">
          <span class="card-field-icon black">📅</span>
          <div class="card-field-content">
            <span class="card-field-label">Date</span>
            <span class="card-field-value">${formatDate(event.event_date)}</span>
          </div>
        </div>
        <div class="card-field">
          <span class="card-field-icon black">🕐</span>
          <div class="card-field-content">
            <span class="card-field-label">Time</span>
            <span class="card-field-value">${formatTime(event.event_time)}${event.end_time ? ' – ' + formatTime(event.end_time) : ''}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card-weather">
      <span class="weather-loading">Loading forecast...</span>
    </div>

    ${event.details ? `
      <div class="card-details">
        <span class="card-details-label">Details</span>
        ${escHtml(event.details)}
      </div>
    ` : ''}

    <div class="card-footer">
      <span class="card-by">Added by ${escHtml(event.created_by)}</span>
      ${state.token ? `
      <div class="card-actions">
        <button class="card-btn card-btn-edit" data-id="${event.id}">Edit</button>
        <button class="card-btn card-btn-delete" data-id="${event.id}">Delete</button>
      </div>` : ''}
    </div>

    <span class="suit-corner bl">⚾</span>
    <span class="suit-corner br">⚾</span>
  `;

  if (state.token) {
    card.querySelector('.card-btn-edit').addEventListener('click', () => openEditModal(event));
    card.querySelector('.card-btn-delete').addEventListener('click', () => openDeleteConfirm(event.id));
  }

  return card;
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── Render Events ──────────────────────────────────────────────────────────── */
function renderEvents(events) {
  const grid = document.getElementById('events-grid');
  const loading = document.getElementById('events-loading');
  const empty = document.getElementById('events-empty');

  hide(loading);
  grid.innerHTML = '';

  if (!events.length) {
    show(empty);
    return;
  }

  hide(empty);

  events.forEach((event, i) => {
    const card = buildCard(event, i);
    grid.appendChild(card);
    // Load weather async (non-blocking)
    injectWeather(card, event.event_date);
  });
}

/* ─── Load Events ────────────────────────────────────────────────────────────── */
async function loadEvents() {
  const loading = document.getElementById('events-loading');
  const grid = document.getElementById('events-grid');
  const empty = document.getElementById('events-empty');

  show(loading);
  hide(empty);
  grid.innerHTML = '';

  const { from, to } = getRangeDates(state.currentRange);
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  try {
    const events = await apiFetch(`/api/events?${params}`);
    state.events = events;
    renderEvents(events);
  } catch (err) {
    hide(loading);
    grid.innerHTML = `<p style="color:#ff8a95;padding:2rem;">Failed to load events: ${err.message}</p>`;
  }
}

/* ─── Auth / View Mode ───────────────────────────────────────────────────────── */
function setSession(token, username) {
  state.token = token;
  state.username = username;
  localStorage.setItem('ihs_token', token);
  localStorage.setItem('ihs_username', username);
}

function clearSession() {
  state.token = null;
  state.username = null;
  localStorage.removeItem('ihs_token');
  localStorage.removeItem('ihs_username');
}

const adminEls = ['header-username', 'btn-manage-users', 'btn-add-event', 'btn-logout'];

function setAdminMode(isAdmin) {
  const signinBtn = document.getElementById('btn-signin');
  adminEls.forEach(id => {
    const el = document.getElementById(id);
    isAdmin ? show(el) : hide(el);
  });
  isAdmin ? hide(signinBtn) : show(signinBtn);

  if (isAdmin) {
    document.getElementById('header-username').textContent = `Signed in as ${state.username}`;
  }

  // Refresh cards to show/hide edit+delete buttons
  const addEmptyBtn = document.getElementById('btn-add-event-empty');
  isAdmin ? show(addEmptyBtn) : hide(addEmptyBtn);

  loadEvents();
}

/* ─── Login Modal ────────────────────────────────────────────────────────────── */
document.getElementById('btn-signin').addEventListener('click', () => {
  document.getElementById('login-form').reset();
  clearMsg(document.getElementById('login-error'));
  showOverlay('login-overlay');
});

document.getElementById('login-modal-close').addEventListener('click', () => {
  hideOverlay('login-overlay');
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  clearMsg(err);

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setSession(data.token, data.username);
    hideOverlay('login-overlay');
    setAdminMode(true);
  } catch (e2) {
    fmt(err, e2.message);
  }
});

/* ─── Logout ─────────────────────────────────────────────────────────────────── */
document.getElementById('btn-logout').addEventListener('click', () => {
  clearSession();
  setAdminMode(false);
});

/* ─── Filter Chips ───────────────────────────────────────────────────────────── */
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.currentRange = chip.dataset.range;

    const customEl = document.getElementById('custom-range');
    if (state.currentRange === 'custom') {
      show(customEl);
    } else {
      hide(customEl);
      loadEvents();
    }
  });
});

document.getElementById('btn-apply-range').addEventListener('click', () => {
  state.customFrom = document.getElementById('filter-from').value || null;
  state.customTo = document.getElementById('filter-to').value || null;
  loadEvents();
});

/* ─── Event Modal ────────────────────────────────────────────────────────────── */
function openAddModal() {
  const form = document.getElementById('event-form');
  form.reset();
  document.getElementById('event-id').value = '';
  document.getElementById('event-modal-title').textContent = 'New Event';
  clearMsg(document.getElementById('event-error'));
  showOverlay('event-overlay');
}

function openEditModal(event) {
  document.getElementById('event-id').value = event.id;
  document.getElementById('event-title').value = event.title;
  document.getElementById('event-date').value = event.event_date;
  document.getElementById('event-time').value = event.event_time;
  document.getElementById('event-end-time').value = event.end_time || '';
  document.getElementById('event-location').value = event.location;
  document.getElementById('event-details').value = event.details || '';
  document.getElementById('event-modal-title').textContent = 'Edit Event';
  clearMsg(document.getElementById('event-error'));
  showOverlay('event-overlay');
}

function closeEventModal() {
  hideOverlay('event-overlay');
}

document.getElementById('btn-add-event').addEventListener('click', openAddModal);
document.getElementById('btn-add-event-empty').addEventListener('click', openAddModal);
document.getElementById('event-modal-close').addEventListener('click', closeEventModal);
document.getElementById('event-cancel').addEventListener('click', closeEventModal);

document.getElementById('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('event-error');
  clearMsg(err);

  const id = document.getElementById('event-id').value;
  const payload = {
    title: document.getElementById('event-title').value.trim(),
    event_date: document.getElementById('event-date').value,
    event_time: document.getElementById('event-time').value,
    end_time: document.getElementById('event-end-time').value || null,
    location: document.getElementById('event-location').value.trim(),
    details: document.getElementById('event-details').value.trim(),
  };

  try {
    if (id) {
      await apiFetch(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/api/events', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeEventModal();
    loadEvents();
  } catch (e2) {
    fmt(err, e2.message);
  }
});

/* ─── Delete Confirm ─────────────────────────────────────────────────────────── */
function openDeleteConfirm(id) {
  state.pendingDeleteId = id;
  showOverlay('confirm-overlay');
}

document.getElementById('confirm-cancel').addEventListener('click', () => {
  state.pendingDeleteId = null;
  hideOverlay('confirm-overlay');
});

document.getElementById('confirm-delete').addEventListener('click', async () => {
  if (!state.pendingDeleteId) return;
  try {
    await apiFetch(`/api/events/${state.pendingDeleteId}`, { method: 'DELETE' });
    state.pendingDeleteId = null;
    hideOverlay('confirm-overlay');
    loadEvents();
  } catch (err) {
    alert('Failed to delete event: ' + err.message);
  }
});

/* ─── Manage Users Modal ─────────────────────────────────────────────────────── */
document.getElementById('btn-manage-users').addEventListener('click', async () => {
  clearMsg(document.getElementById('create-user-error'));
  clearMsg(document.getElementById('change-pw-error'));
  clearMsg(document.getElementById('change-pw-success'));
  document.getElementById('create-user-form').reset();
  document.getElementById('change-password-form').reset();
  await loadUsersList();
  showOverlay('users-overlay');
});

document.getElementById('users-modal-close').addEventListener('click', () => {
  hideOverlay('users-overlay');
});

async function loadUsersList() {
  const list = document.getElementById('users-list');
  list.innerHTML = '<span style="color:#888;font-size:0.82rem;">Loading...</span>';
  try {
    const users = await apiFetch('/api/auth/users');
    if (!users.length) {
      list.innerHTML = '<span style="color:#888;font-size:0.82rem;">No users found.</span>';
      return;
    }
    list.innerHTML = users.map(u => `
      <div class="user-row">
        <div>
          <span class="user-row-name">${escHtml(u.username)}</span>
          ${u.username === state.username ? ' <span style="color:var(--red-light);font-size:0.7rem;">(you)</span>' : ''}
        </div>
        <div style="display:flex;align-items:center;gap:0.6rem;">
          <span class="user-row-date">${u.created_at ? u.created_at.slice(0,10) : ''}</span>
          ${u.username !== state.username ? `<button class="user-row-delete" data-id="${u.id}" title="Delete user">✕</button>` : ''}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.user-row-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete user "${btn.closest('.user-row').querySelector('.user-row-name').textContent}"?`)) return;
        try {
          await apiFetch(`/api/auth/users/${btn.dataset.id}`, { method: 'DELETE' });
          await loadUsersList();
        } catch (err2) {
          alert('Failed to delete user: ' + err2.message);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<span style="color:#ff8a95;font-size:0.82rem;">Failed to load users: ${err.message}</span>`;
  }
}

document.getElementById('create-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('create-user-error');
  clearMsg(err);
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value;
  try {
    const res = await apiFetch('/api/auth/create-user', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    document.getElementById('create-user-form').reset();
    await loadUsersList();
    fmt(document.getElementById('create-user-error'), '');
    // Show quick success in the error box but styled green
    const msgEl = document.getElementById('create-user-error');
    msgEl.textContent = res.message;
    msgEl.style.background = 'rgba(34,139,34,0.15)';
    msgEl.style.borderColor = '#228b22';
    msgEl.style.color = '#7adb7a';
    show(msgEl);
    setTimeout(() => {
      hide(msgEl);
      msgEl.style = '';
    }, 3000);
  } catch (e2) {
    fmt(err, e2.message);
  }
});

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('change-pw-error');
  const success = document.getElementById('change-pw-success');
  clearMsg(err);
  clearMsg(success);

  const current_password = document.getElementById('current-password').value;
  const new_password = document.getElementById('new-pw').value;

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    });
    document.getElementById('change-password-form').reset();
    fmt(success, res.message);
  } catch (e2) {
    fmt(err, e2.message);
  }
});

/* ─── Close overlays on backdrop click ──────────────────────────────────────── */
['login-overlay', 'event-overlay', 'users-overlay', 'confirm-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.remove('active');
      if (id === 'confirm-overlay') state.pendingDeleteId = null;
    }
  });
});

/* ─── Init ───────────────────────────────────────────────────────────────────── */
(async function init() {
  if (state.token) {
    // Verify saved token is still valid; fall back to viewer mode if not
    try {
      await apiFetch('/api/auth/users'); // lightweight auth check
      setAdminMode(true);
      return;
    } catch {
      clearSession();
    }
  }
  // Viewer mode: show calendar without admin controls
  setAdminMode(false);
})();
