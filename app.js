/* Spotify full-screen art: plain JS, no build step.
 * Sign-in: Spotify Authorization Code with PKCE (no client secret).
 * Data:    polls GET /me/player every few seconds.
 * Look:    two picture layers that slowly zoom and pan, cross-fading into a fresh move
 *          before each one ends, so the loop never visibly jumps.
 */
'use strict';

/* ------------------------------------------------------------------ settings */
const API = 'https://api.spotify.com/v1';
const AUTH = 'https://accounts.spotify.com';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-private', // tells us whether the account is Premium
].join(' ');
const POLL_PLAYING = 3000;   // ms between polls while music is playing
const POLL_PAUSED = 8000;    // ...while paused or nothing is playing
const POLL_HIDDEN = 30000;   // ...while the tab is in the background
const UI_IDLE = 3000;        // controls fade after this long without input
const FADE = 4000;           // cross-fade length between Ken Burns moves
const SPEEDS = { slow: 40000, normal: 26000, fast: 16000 }; // length of one move

const store = {
  get(k, d) { try { const v = localStorage.getItem('sfa.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sfa.' + k, JSON.stringify(v)); } catch { /* private mode: keep going */ } },
  del(k) { try { localStorage.removeItem('sfa.' + k); } catch { /* ignore */ } },
};

const $ = (id) => document.getElementById(id);
const body = document.body;
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
// The page itself, without query or "index.html", so it matches what's registered with Spotify
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

const prefs = {
  view: store.get('view', 'album'),      // album | artist | alternate
  fit: store.get('fit', false),          // false = fill screen (crop), true = whole picture
  info: store.get('info', true),         // show small song text
  speed: store.get('speed', 'normal'),
};

/* ------------------------------------------------------------------ state */
const state = {
  item: null,            // { id, title, artist, artistId, albumArt, duration }
  playing: false,
  progress: 0,           // ms at progressAt
  progressAt: 0,         // performance.now() of last progress update
  volume: null,          // 0..100 or null if device can't change volume
  premium: null,         // true / false / null (unknown)
  deviceName: '',
  canControl: true,
  pollTimer: 0,
  retryUntil: 0,
};

/* ================================================================== Ken Burns */
const kb = {
  layers: [$('layerA'), $('layerB')],
  top: 0,          // index of the layer currently on top
  url: '',         // picture currently showing
  timer: 0,
  anims: [[], []], // running animations per layer
  z: 1,
  reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  alt: 0,          // for "alternate" view: which picture to use next
};

function rand(a, b) { return a + Math.random() * (b - a); }

/* Pick a start and end framing. Both are zoomed in enough that panning never
 * shows an edge: with scale s the picture overhangs by (s-1)/2 of its size on
 * each side, so the offset stays inside that margin. */
function pickMove() {
  const lo = rand(1.08, 1.14), hi = rand(1.24, 1.32);
  const zoomIn = Math.random() < 0.5;
  const s0 = zoomIn ? lo : hi, s1 = zoomIn ? hi : lo;
  const pt = (s) => {
    const m = ((s - 1) / 2) * 100 * 0.85 / s; // % of element, after scale
    return [rand(-m, m), rand(-m, m)];
  };
  const [x0, y0] = pt(s0), [x1, y1] = pt(s1);
  return [
    `scale(${s0.toFixed(3)}) translate(${x0.toFixed(2)}%, ${y0.toFixed(2)}%)`,
    `scale(${s1.toFixed(3)}) translate(${x1.toFixed(2)}%, ${y1.toFixed(2)}%)`,
  ];
}

/* Start a new move on the hidden layer and fade it in over the current one.
 * The old layer keeps drifting during the fade, then stops once covered. */
function kbCycle(url) {
  clearTimeout(kb.timer);
  const next = 1 - kb.top;
  const el = kb.layers[next];
  const old = kb.layers[kb.top];
  const move = SPEEDS[prefs.speed] || SPEEDS.normal;

  kb.anims[next].forEach((a) => a.cancel());
  el.style.backgroundImage = `url("${url}")`;
  el.style.zIndex = String(++kb.z);

  const [from, to] = kb.reduced ? ['scale(1.02)', 'scale(1.02)'] : pickMove();
  kb.anims[next] = [
    el.animate([{ transform: from }, { transform: to }], { duration: move + FADE, easing: 'linear', fill: 'forwards' }),
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE, easing: 'ease-in-out', fill: 'forwards' }),
  ];
  const oldIdx = kb.top;
  setTimeout(() => {           // once fully covered, hide and stop the old layer
    if (kb.top !== oldIdx) { kb.anims[oldIdx].forEach((a) => a.cancel()); old.style.opacity = '0'; }
  }, FADE + 50);

  kb.top = next;
  kb.url = url;
  $('backdrop').style.backgroundImage = `url("${url}")`;
  kb.timer = setTimeout(() => kbCycle(pictureForNextMove()), move);
}

/* Load the picture first so the cross-fade never shows a blank layer. */
const loaded = new Map();
function preload(url) {
  if (!url) return Promise.reject(new Error('no url'));
  if (loaded.has(url)) return loaded.get(url);
  const p = new Promise((res, rej) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => res(url);
    img.onerror = () => { loaded.delete(url); rej(new Error('image failed')); };
    img.src = url;
  });
  loaded.set(url, p);
  if (loaded.size > 40) loaded.delete(loaded.keys().next().value);
  return p;
}

let wantUrl = '';
function showPicture(url) {
  if (!url || url === kb.url || url === wantUrl) return;
  wantUrl = url;
  preload(url).then(() => { if (wantUrl === url) { wantUrl = ''; kbCycle(url); } })
    .catch(() => { if (wantUrl === url) wantUrl = ''; });
}

/* Which picture the current view mode wants. */
function pictureNow() {
  const it = state.item;
  if (!it) return '';
  const artist = artistImage(it.artistId);
  if (prefs.view === 'artist') return artist || it.albumArt;
  if (prefs.view === 'alternate') return (kb.alt % 2 && artist) ? artist : it.albumArt;
  return it.albumArt;
}
function pictureForNextMove() {
  if (prefs.view === 'alternate') kb.alt++;
  return pictureNow() || kb.url;
}
function refreshPicture() { const u = pictureNow(); if (u) showPicture(u); }

/* ================================================================== Spotify sign-in (PKCE) */
function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const v = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(v, (x) => chars[x % chars.length]).join('');
}

async function signIn() {
  const clientId = store.get('clientId', '');
  if (!clientId) return showSetup();
  const verifier = randomString(64);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const st = randomString(24);
  // Keep the check values in localStorage (shared by all tabs), keyed by state, so the
  // sign-in still completes if Spotify returns to a different tab or window than started it.
  const pending = prunePending(store.get('pkce', {}));
  pending[st] = { v: verifier, t: Date.now() };
  store.set('pkce', pending);
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state: st,
  });
  location.assign(`${AUTH}/authorize?${q}`);
}

async function tokenRequest(form) {
  const r = await fetch(`${AUTH}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `token error ${r.status}`);
  store.set('token', {
    access: j.access_token,
    refresh: j.refresh_token || (store.get('token', {}) || {}).refresh,
    expires: Date.now() + (j.expires_in - 60) * 1000,
  });
}

/* Back from Spotify with ?code=... */
async function finishSignIn() {
  const code = params.get('code');
  const err = params.get('error');
  history.replaceState(null, '', REDIRECT_URI);
  if (err) throw new Error(err === 'access_denied' ? 'Sign-in was cancelled.' : `Spotify said: ${err}`);
  const pending = prunePending(store.get('pkce', {}));
  const entry = pending[params.get('state') || ''];
  if (!entry) {
    store.set('pkce', pending);
    // A stale or repeated return from Spotify: harmless if this browser is already signed in.
    if (store.get('token', null)) return;
    throw new Error('Sign-in check failed (state mismatch). Please try again.');
  }
  delete pending[params.get('state')];
  store.set('pkce', pending);
  await tokenRequest({
    client_id: store.get('clientId', ''),
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: entry.v,
  });
}
function prunePending(p) { // drop sign-in attempts older than 15 minutes
  const out = {};
  for (const [k, e] of Object.entries(p || {})) if (e && Date.now() - e.t < 15 * 60 * 1000) out[k] = e;
  return out;
}

/* Every open tab shares one sign-in. Spotify issues a new refresh token on each refresh and
 * the old one stops working, so only one tab may refresh at a time, and the others re-read
 * the result instead of refreshing again. */
let refreshing = null;
async function accessToken() {
  const t = store.get('token', null);
  if (!t || !t.access) return null;
  if (Date.now() < t.expires) return t.access;
  if (!t.refresh) return null;
  refreshing = refreshing || (navigator.locks
    ? navigator.locks.request('sfa-token-refresh', refreshNow)
    : refreshNow()).finally(() => { refreshing = null; });
  return refreshing;
}
async function refreshNow() {
  const t = store.get('token', null);           // re-read: another tab may have just refreshed
  if (!t || !t.refresh) return null;
  if (Date.now() < t.expires) return t.access;
  try {
    await tokenRequest({ client_id: store.get('clientId', ''), grant_type: 'refresh_token', refresh_token: t.refresh });
  } catch (e) {
    const now = store.get('token', null);       // lost a race with a tab without lock support?
    if (now && now.refresh !== t.refresh && Date.now() < now.expires) return now.access;
    return null;                                // refresh token no longer valid: sign in again
  }
  return store.get('token', {}).access;
}

function signOut() {
  store.del('token');
  location.replace(REDIRECT_URI);
}

/* ================================================================== Spotify API */
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, { method = 'GET', body: b, query } = {}) {
  if (Date.now() < state.retryUntil) throw new ApiError(429, 'rate limited');
  const tok = await accessToken().catch(() => null);
  if (!tok) throw new ApiError(401, 'not signed in');
  const url = `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(b ? { 'Content-Type': 'application/json' } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  if (r.status === 429) {
    const wait = Number(r.headers.get('Retry-After')) || 10;
    state.retryUntil = Date.now() + wait * 1000;
    throw new ApiError(429, `Spotify asked us to wait ${wait}s`);
  }
  if (r.status === 401) {
    // token rejected: force a refresh next time
    const t = store.get('token', null);
    if (t) { t.expires = 0; store.set('token', t); }
  }
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* some player endpoints reply with plain text */ }
  if (!r.ok) {
    const reason = j && j.error && (j.error.reason || j.error.message);
    throw new ApiError(r.status, reason || `HTTP ${r.status}`);
  }
  return j;
}

/* Artist pictures are fetched once per artist and remembered. */
const artistCache = new Map(); // id -> url | '' (none) | Promise
function artistImage(id) {
  if (!id) return '';
  const v = artistCache.get(id);
  if (typeof v === 'string') return v;
  if (!v) {
    const p = (DEMO ? demoArtist(id) : api(`/artists/${id}`).then((a) => bestImage(a && a.images)))
      .then((u) => { artistCache.set(id, u || ''); if (u) preload(u).catch(() => {}); if (state.item && state.item.artistId === id) refreshPicture(); })
      .catch(() => artistCache.set(id, ''));
    artistCache.set(id, p);
  }
  return '';
}
function bestImage(imgs) {
  if (!imgs || !imgs.length) return '';
  return [...imgs].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}

function readItem(p) {
  const it = p && p.item;
  if (!it) return null;
  if (it.type === 'episode') {
    return {
      id: it.id, title: it.name, artist: it.show ? it.show.name : '',
      artistId: '', albumArt: bestImage(it.images) || bestImage(it.show && it.show.images),
      duration: it.duration_ms,
    };
  }
  const artists = it.artists || [];
  return {
    id: it.id || it.uri, title: it.name,
    artist: artists.map((a) => a.name).join(', '),
    artistId: artists[0] && artists[0].id,
    albumArt: bestImage(it.album && it.album.images),
    duration: it.duration_ms,
  };
}

/* ================================================================== polling */
async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.active) return; // still on the setup screen or signing in: don't poll (or redirect)
  let p = null;
  try {
    p = DEMO ? demo.player() : await api('/me/player', { query: { additional_types: 'episode' } });
    note('');
  } catch (e) {
    if (e.status === 401 && !(await accessToken().catch(() => null))) return signIn();
    note(e.status === 429 ? 'Spotify is busy — slowing down for a moment.' : `Couldn't reach Spotify (${e.message}). Retrying…`);
    return schedulePoll(POLL_PAUSED);
  }
  applyPlayer(p);
  schedulePoll(document.hidden ? POLL_HIDDEN : state.playing ? POLL_PLAYING : POLL_PAUSED);
}
function schedulePoll(ms) {
  clearTimeout(state.pollTimer);
  const wait = Math.max(ms, state.retryUntil - Date.now());
  state.pollTimer = setTimeout(poll, wait);
}
function pollSoon() { schedulePoll(350); }

function applyPlayer(p) {
  const item = readItem(p);
  $('idle').hidden = !!item;
  if (!item) { state.playing = false; renderTransport(); return; }

  const changed = !state.item || state.item.id !== item.id;
  state.item = item;
  state.playing = !!p.is_playing;
  state.progress = p.progress_ms || 0;
  state.progressAt = performance.now();
  state.deviceName = p.device ? p.device.name : '';
  const vol = p.device && p.device.supports_volume !== false ? p.device.volume_percent : null;
  if (!volDragging) state.volume = vol;
  // Spotify lists actions that are not allowed right now (e.g. skipping on some free tiers)
  state.disallow = (p.actions && p.actions.disallows) || {};

  if (changed) {
    $('title').textContent = item.title || '';
    $('artist').textContent = item.artist || '';
    document.title = item.title ? `${item.title} · ${item.artist}` : 'Now Playing';
    kb.alt = 0;
    artistImage(item.artistId); // start fetching early
  }
  if (changed || !kb.url) refreshPicture();
  renderTransport();
}

/* ================================================================== controls */
function fmt(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function currentProgress() {
  const it = state.item;
  if (!it) return 0;
  const p = state.progress + (state.playing ? performance.now() - state.progressAt : 0);
  return Math.min(p, it.duration || p);
}

function renderTransport() {
  // SVG elements have no .hidden property, so set the attribute directly
  $('icoPlay').toggleAttribute('hidden', state.playing);
  $('icoPause').toggleAttribute('hidden', !state.playing);
  $('bPlay').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  const ctl = state.canControl && state.premium !== false;
  body.classList.toggle('no-control', !ctl);
  const d = state.disallow || {};
  $('bPlay').classList.toggle('off', !ctl);
  $('bPrev').classList.toggle('off', !ctl || !!d.skipping_prev);
  $('bNext').classList.toggle('off', !ctl || !!d.skipping_next);
  $('vol').hidden = state.volume === null || state.volume === undefined || !ctl;
  if (!volDragging && state.volume != null) $('volume').value = state.volume;
  $('menuWho').textContent = [state.user, state.deviceName && `on ${state.deviceName}`].filter(Boolean).join(' · ') || (DEMO ? 'Demo mode' : '');
}

function tick() {
  const it = state.item;
  const dur = it ? it.duration : 0;
  const pos = seekPreview != null ? seekPreview : currentProgress();
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  $('fill').style.width = pct + '%';
  $('knob').style.left = pct + '%';
  $('tNow').textContent = fmt(pos);
  $('tEnd').textContent = fmt(dur);
  if (it && state.playing && dur && pos >= dur - 200 && endPolled !== it.id) { endPolled = it.id; pollSoon(); } // song ending: look for the next one
  requestAnimationFrame(tickThrottle);
}
let lastTick = 0, endPolled = '';
function tickThrottle(t) { if (t - lastTick > 250) { lastTick = t; tick(); } else requestAnimationFrame(tickThrottle); }

/* Send a player command; if it fails because of Premium, say so once and grey the buttons. */
async function command(path, method, query, optimistic) {
  if (!state.canControl || state.premium === false) {
    note(state.premium === false ? 'Play/pause, skip and volume need Spotify Premium. The art still works.' : 'Controls are not available right now.');
    return;
  }
  if (optimistic) { optimistic(); renderTransport(); }
  if (DEMO) { demo.command(path, query); return pollSoon(); }
  try {
    await api(path, { method, query });
  } catch (e) {
    if (e.status === 403 && /PREMIUM/i.test(e.message)) {
      state.premium = false;
      note('Play/pause, skip and volume need Spotify Premium. The art still works.');
    } else if (e.status === 404) {
      note('No active Spotify device. Start playback in a Spotify app first.');
    } else if (e.status === 403) {
      note('Spotify did not allow that right now.');
    } else {
      note(`That didn't work (${e.message}).`);
    }
  }
  pollSoon();
  setTimeout(pollSoon, 1200); // Spotify sometimes reports the new track a moment late
}

function playPause() {
  if (state.playing) {
    command('/me/player/pause', 'PUT', null, () => { state.progress = currentProgress(); state.progressAt = performance.now(); state.playing = false; });
  } else {
    command('/me/player/play', 'PUT', null, () => { state.progressAt = performance.now(); state.playing = true; });
  }
}
function prev() { if (!state.disallow?.skipping_prev) command('/me/player/previous', 'POST'); }
function next() { if (!state.disallow?.skipping_next) command('/me/player/next', 'POST'); }

/* Volume: send at most every 300 ms while dragging. */
let volDragging = false, volTimer = 0;
function setVolume(v, now) {
  state.volume = v;
  clearTimeout(volTimer);
  const send = () => command('/me/player/volume', 'PUT', { volume_percent: String(v) });
  if (now) send(); else volTimer = setTimeout(send, 300);
}

/* Seek by clicking or dragging the progress bar. */
let seekPreview = null;
function seekFromEvent(e) {
  const r = $('track').getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  return Math.round(f * (state.item ? state.item.duration : 0));
}
function setupSeek() {
  const tr = $('track');
  tr.addEventListener('pointerdown', (e) => {
    if (!state.item || body.classList.contains('no-control')) return;
    tr.setPointerCapture(e.pointerId);
    body.classList.add('seeking');
    seekPreview = seekFromEvent(e);
    tick();
  });
  tr.addEventListener('pointermove', (e) => { if (seekPreview != null) { seekPreview = seekFromEvent(e); tick(); } });
  const end = (e) => {
    if (seekPreview == null) return;
    const ms = seekFromEvent(e);
    seekPreview = null;
    body.classList.remove('seeking');
    command('/me/player/seek', 'PUT', { position_ms: String(ms) }, () => { state.progress = ms; state.progressAt = performance.now(); });
  };
  tr.addEventListener('pointerup', end);
  tr.addEventListener('pointercancel', () => { seekPreview = null; body.classList.remove('seeking'); });
}

/* ================================================================== UI bits */
let noteTimer = 0;
function note(msg) {
  const n = $('note');
  if (!msg) { if (!noteTimer) n.hidden = true; return; }
  n.textContent = msg;
  n.hidden = false;
  showUi();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { n.hidden = true; noteTimer = 0; }, 6000);
}

let idleTimer = 0, lastPointer = 'mouse';
addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, { passive: true, capture: true });
function showUi() {
  body.classList.add('show-ui');
  body.classList.remove('idle-ui');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideUi, UI_IDLE);
}
function hideUi() {
  // keep controls up while the pointer is over them or the menu is open
  const hovering = lastPointer === 'mouse' && document.querySelector('#bar:hover, #menu:hover');
  if (hovering || !$('menu').hidden || seekPreview != null) {
    idleTimer = setTimeout(hideUi, UI_IDLE);
    return;
  }
  body.classList.remove('show-ui');
  body.classList.add('idle-ui');
}

function applyPrefs() {
  body.classList.toggle('fit', prefs.fit);
  body.classList.toggle('show-info', prefs.info);
  $('bView').textContent = { album: 'Album', artist: 'Artist', alternate: 'Both' }[prefs.view];
  $('bFit').textContent = prefs.fit ? 'Fit' : 'Fill';
  $('mSpeed').textContent = `Motion: ${prefs.speed}`;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

/* Keep the screen awake while the page is open (where supported). */
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed: fine */ }
}

function bindUi() {
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, showUi, { passive: true }));

  $('bPlay').onclick = playPause;
  $('bPrev').onclick = prev;
  $('bNext').onclick = next;
  $('bFull').onclick = toggleFullscreen;
  $('bInfo').onclick = () => { prefs.info = !prefs.info; store.set('info', prefs.info); applyPrefs(); };
  $('bFit').onclick = () => { prefs.fit = !prefs.fit; store.set('fit', prefs.fit); applyPrefs(); };
  $('bView').onclick = () => {
    const order = ['album', 'artist', 'alternate'];
    prefs.view = order[(order.indexOf(prefs.view) + 1) % order.length];
    store.set('view', prefs.view);
    applyPrefs();
    kb.alt = prefs.view === 'alternate' ? 1 : 0;
    const u = pictureNow();
    if (u && u !== kb.url) showPicture(u);
    else if (prefs.view === 'artist' && state.item && !artistImage(state.item.artistId)) note('No artist picture for this one — showing the album.');
  };
  $('bMenu').onclick = (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; };
  addEventListener('click', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target)) $('menu').hidden = true; });
  $('mSpeed').onclick = () => {
    const order = ['slow', 'normal', 'fast'];
    prefs.speed = order[(order.indexOf(prefs.speed) + 1) % order.length];
    store.set('speed', prefs.speed);
    applyPrefs();
  };
  $('mSetup').onclick = () => { store.del('token'); showSetup(); };
  $('mOut').onclick = DEMO ? () => location.replace(REDIRECT_URI) : signOut;
  if (DEMO) $('mOut').textContent = 'Leave demo';

  const vol = $('volume');
  vol.addEventListener('pointerdown', () => { volDragging = true; });
  vol.addEventListener('input', () => setVolume(Number(vol.value), false));
  vol.addEventListener('change', () => { volDragging = false; setVolume(Number(vol.value), true); });

  setupSeek();

  // Double-click / double-tap the picture for full screen
  $('stage').addEventListener('dblclick', toggleFullscreen);

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;          // typing a client ID, or arrows on the volume slider
    const k = e.key.toLowerCase();
    if ((k === ' ' || k === 'enter') && e.target.closest('button')) return; // let the focused button handle it
    if (k === ' ' || k === 'k') { e.preventDefault(); playPause(); }
    else if (k === 'arrowright') next();
    else if (k === 'arrowleft') prev();
    else if (k === 'arrowup' || k === 'arrowdown') {
      if (state.volume == null) return;
      e.preventDefault();
      const v = Math.max(0, Math.min(100, state.volume + (k === 'arrowup' ? 5 : -5)));
      $('volume').value = v;
      setVolume(v, false);
    }
    else if (k === 'f') toggleFullscreen();
    else if (k === 'i') $('bInfo').click();
    else if (k === 'v') $('bView').click();
    else if (k === 'c') $('bFit').click();
    else if (k === 'escape') $('menu').hidden = true;
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { keepAwake(); pollSoon(); }
  });
}

/* ================================================================== setup screen */
function showSetup(err) {
  state.active = false;
  clearTimeout(state.pollTimer);
  $('setup').hidden = false;
  $('bar').hidden = true;
  $('redirectUri').textContent = REDIRECT_URI;
  $('clientId').value = store.get('clientId', '');
  if (err) { $('setupErr').textContent = err; $('setupErr').hidden = false; }
  $('bCopy').onclick = () => {
    navigator.clipboard.writeText(REDIRECT_URI).then(() => { $('bCopy').textContent = 'Copied'; }).catch(() => {
      const range = document.createRange(); range.selectNodeContents($('redirectUri'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
  };
  $('bSave').onclick = () => {
    const id = $('clientId').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      $('setupErr').textContent = 'That doesn\'t look like a client ID. It is 32 letters and numbers, shown under "Client ID" in your app\'s settings.';
      $('setupErr').hidden = false;
      return;
    }
    store.set('clientId', id);
    signIn();
  };
  $('clientId').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('bSave').click(); });
}

/* ================================================================== demo mode (no Spotify needed) */
/* Paints sample "album art" on a canvas so the effect can be tried offline.
 * Use ?demo for generated pictures, or ?demo=<image url> to try your own picture. */
const demo = (() => {
  const tracks = [
    { title: 'Neon Harbour', artist: 'Sample Artist', hue: 200, duration: 214000 },
    { title: 'Copper Field', artist: 'Another Sample', hue: 25, duration: 187000 },
    { title: 'Violet Hours', artist: 'Third Example', hue: 285, duration: 241000 },
  ];
  let i = 0, playing = true, pos = 30000, at = performance.now(), vol = 60;
  const custom = params.get('demo');

  function paint(hue, seed, artist) {
    const c = document.createElement('canvas');
    c.width = c.height = 1200;
    const g = c.getContext('2d');
    let s = seed;
    const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const bg = g.createLinearGradient(0, 0, 1200, 1200);
    bg.addColorStop(0, `hsl(${hue},70%,18%)`);
    bg.addColorStop(1, `hsl(${(hue + 60) % 360},65%,8%)`);
    g.fillStyle = bg; g.fillRect(0, 0, 1200, 1200);
    for (let k = 0; k < 26; k++) {
      const x = r() * 1200, y = r() * 1200, rad = 60 + r() * 320;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `hsla(${(hue + r() * 90 - 45 + 360) % 360},85%,${45 + r() * 25}%,.75)`);
      gr.addColorStop(1, 'hsla(0,0%,0%,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    // a grid of fine lines so motion and edges are easy to judge
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 2;
    for (let k = 0; k <= 1200; k += 100) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 1200); g.moveTo(0, k); g.lineTo(1200, k); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.font = '600 64px system-ui, sans-serif';
    g.fillText(artist ? 'ARTIST' : 'ALBUM', 70, 1120);
    return c.toDataURL('image/jpeg', 0.9);
  }
  const art = tracks.map((t, k) => (custom ? custom : paint(t.hue, 1000 + k * 77, false)));

  return {
    player() {
      const t = tracks[i];
      let p = pos + (playing ? performance.now() - at : 0);
      if (p >= t.duration) { i = (i + 1) % tracks.length; pos = 0; at = performance.now(); p = 0; }
      return {
        is_playing: playing, progress_ms: Math.round(p),
        device: { name: 'Demo speaker', volume_percent: vol, supports_volume: true },
        actions: { disallows: {} },
        item: { type: 'track', id: 'demo' + i, name: tracks[i].title, duration_ms: tracks[i].duration,
          artists: [{ id: 'demoArtist' + i, name: tracks[i].artist }], album: { images: [{ url: art[i], width: 1200 }] } },
      };
    },
    command(path, q) {
      const now = performance.now();
      const cur = pos + (playing ? now - at : 0);
      pos = cur;
      if (path.endsWith('/pause')) playing = false;
      else if (path.endsWith('/play')) playing = true;
      else if (path.endsWith('/next')) { i = (i + 1) % tracks.length; pos = 0; }
      else if (path.endsWith('/previous')) { if (cur <= 3000) i = (i + tracks.length - 1) % tracks.length; pos = 0; }
      else if (path.endsWith('/seek')) pos = Number(q.position_ms);
      else if (path.endsWith('/volume')) vol = Number(q.volume_percent);
      at = now;
    },
    paint,
  };
})();
function demoArtist(id) {
  const k = Number(id.replace('demoArtist', '')) || 0;
  return Promise.resolve(params.get('demo') || demo.paint((k * 120 + 140) % 360, 5000 + k * 31, true));
}

/* ================================================================== start */
async function start() {
  applyPrefs();
  bindUi();
  showUi();
  requestAnimationFrame(tickThrottle);
  keepAwake();

  if (DEMO) {
    state.premium = true;
    state.user = 'Demo mode';
    note('Demo mode: sample pictures, controls work locally.');
    state.active = true;
    return poll();
  }

  if (params.has('code') || params.has('error')) {
    try { await finishSignIn(); } catch (e) { return showSetup(e.message); }
  }
  if (!store.get('clientId', '')) return showSetup();
  if (!store.get('token', null)) return signIn();

  // Who is signed in, and are they Premium?
  try {
    const me = await api('/me');
    state.user = me.display_name || me.id;
    if (me.product) state.premium = me.product === 'premium';
    if (state.premium === false) note('Free account: the art works; play/pause, skip and volume need Premium.');
  } catch (e) {
    if (e.status === 401) return signIn();
    if (e.status === 403) return showSetup('Spotify refused this account. In Development Mode, add your Spotify email under "User Management" in your developer app, then try again.');
  }
  renderTransport();
  state.active = true;
  poll();
}

start();
