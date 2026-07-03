'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http2   = require('http2');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.TOMTOM_KEY || '';

/* ===== APNs (background push) configuration =====
   Set these in Render → Environment:
     APNS_KEY        = the full contents of your AuthKey_XXXX.p8 file
     APNS_KEY_ID     = HTLYWJU28H
     APNS_TEAM_ID    = 3F6UVAJ38B
     APNS_BUNDLE_ID  = com.homerununit.towstrike   (optional, this is the default)
   Until these are set, the push engine stays OFF and the rest of the API runs normally. */
const APNS_KEY     = (process.env.APNS_KEY || '').replace(/\\n/g, '\n');
const APNS_KEY_ID  = process.env.APNS_KEY_ID  || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_BUNDLE  = process.env.APNS_BUNDLE_ID || 'com.homerununit.towstrike';

/* APNs hosts — which one Apple honors depends on how the APP was SIGNED, not the server:
     SANDBOX    (api.sandbox.push.apple.com) → DEVELOPMENT builds: Xcode "Run"/debug installs
                                               to a device. Entitlement aps-environment=development.
                                               ← your current builds mint SANDBOX tokens.
     PRODUCTION (api.push.apple.com)         → TestFlight and App Store builds.
                                               Entitlement aps-environment=production.
   A token minted for one environment is rejected by the OTHER host with 400 BadDeviceToken.
   Strategy: try APNS_PRIMARY first, then auto-retry the OTHER host once on BadDeviceToken — so the
   SAME server works for dev tokens now AND shipped (TestFlight/App Store) tokens later, no redeploy.
   Default primary = sandbox to match today's dev builds. Set APNS_HOST env to pin production first
   (e.g. after you ship) — the fallback still covers the other environment either way. */
const APNS_HOST_PROD    = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
const APNS_PRIMARY = process.env.APNS_HOST || APNS_HOST_SANDBOX;
const APNS_ALT     = (APNS_PRIMARY === APNS_HOST_PROD) ? APNS_HOST_SANDBOX : APNS_HOST_PROD;

app.use(cors());
app.use(express.json());

/* ================= helpers ================= */

/** Return a bbox string ~25 miles around a lat/lon. */
function bbox25(lat, lon) {
  const R     = 3958.8;
  const miles = 25;
  const degLat = (miles / R) * (180 / Math.PI);
  const degLon = degLat / Math.cos(lat * Math.PI / 180);
  return [
    (lon - degLon).toFixed(5),
    (lat - degLat).toFixed(5),
    (lon + degLon).toFixed(5),
    (lat + degLat).toFixed(5)
  ].join(',');
}

/** Lightweight HTTPS GET returning {status, data}. */
function httpsGet(url) {
  return new Promise(resolve => {
    const u   = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': 'TowStrike/2.0' } },
      res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch (_) { resolve({ status: res.statusCode, data: null }); }
        });
      }
    );
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ status: 0, data: null }); });
    req.end();
  });
}

/** Minutes since an ISO timestamp, or null. */
function ageMin(isoStr) {
  if (!isoStr) return null;
  const diff = Date.now() - new Date(isoStr).getTime();
  return isNaN(diff) ? null : Math.round(diff / 60000);
}

/** Haversine straight-line distance in km. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dO = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2 +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dO / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Call TomTom Routing API for one incident.
 * Returns { roadMiles, driveMin } or {} on any failure.
 */
async function routeIncident(oLat, oLon, iLat, iLon) {
  try {
    const url =
      'https://api.tomtom.com/routing/1/calculateRoute/' +
      oLat + ',' + oLon + ':' + iLat + ',' + iLon + '/json' +
      '?key=' + KEY + '&travelMode=car&routeType=fastest';
    const r = await httpsGet(url);
    const summary = r.data && r.data.routes && r.data.routes[0] && r.data.routes[0].summary;
    if (!summary) return {};
    const meters  = summary.lengthInMeters;
    const seconds = summary.travelTimeInSeconds;
    if (typeof meters !== 'number' || typeof seconds !== 'number') return {};
    return {
      roadMiles: Math.round((meters / 1609.34) * 10) / 10,
      driveMin:  Math.round(seconds / 60)
    };
  } catch (_) {
    return {};
  }
}

/* ================= APNs push engine ================= */

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let _jwt = { token: '', iat: 0 };
/** Build (and cache for <40min) the ES256 JWT APNs requires. */
function apnsJWT() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwt.token && (now - _jwt.iat) < 2400) return _jwt.token;
  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const payload = b64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }));
  const signingInput = header + '.' + payload;
  const sig = crypto.sign('sha256', Buffer.from(signingInput),
    { key: APNS_KEY, dsaEncoding: 'ieee-p1363' });
  _jwt = { token: signingInput + '.' + b64url(sig), iat: now };
  return _jwt.token;
}

function apnsConfigured() { return !!(APNS_KEY && APNS_KEY_ID && APNS_TEAM_ID); }

function hostLabel(host) { return host.indexOf('sandbox') >= 0 ? 'sandbox' : 'production'; }

/** Low-level: POST an already-built payload to ONE host.
 *  Resolves {status, reason, data, host}; never throws. `reason` is Apple's exact
 *  error string parsed from the JSON body (BadDeviceToken, TopicDisallowed, ...). */
function apnsSendOnce(host, token, jwt, payload) {
  return new Promise(resolve => {
    let client;
    try { client = http2.connect(host); }
    catch (e) { return resolve({ status: 0, reason: 'connect-error', data: '', host: host }); }

    let done = false;
    const finish = (r) => { if (done) return; done = true; try { client.close(); } catch (_) {} resolve(Object.assign({ host: host }, r)); };
    client.on('error', () => finish({ status: 0, reason: 'client-error', data: '' }));

    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + token,
      'authorization': 'bearer ' + jwt,
      'apns-topic': APNS_BUNDLE,
      'apns-push-type': 'alert',
      'apns-priority': '10'
    });
    let status = 0, data = '';
    req.on('response', h => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', d => data += d);
    req.on('end', () => {
      let reason = '';
      try { if (data) reason = (JSON.parse(data).reason || ''); } catch (_) {}
      finish({ status: status, reason: reason, data: data });
    });
    req.on('error', () => finish({ status: 0, reason: 'req-error', data: '' }));
    req.setTimeout(8000, () => { try { req.close(); } catch (_) {} finish({ status: 0, reason: 'timeout', data: '' }); });
    req.end(payload);
  });
}

/** Send one push to one device token, with automatic host fallback on env mismatch.
 *  Tries APNS_PRIMARY, then retries APNS_ALT once if Apple says 400 BadDeviceToken
 *  (dev token vs prod host, or vice-versa). Logs Apple's exact status + reason for
 *  EVERY attempt. Resolves {status, reason, data, host}; never throws. */
async function sendPush(token, title, body, extra) {
  if (!apnsConfigured()) { console.log('[APNs] skip — engine not configured'); return { status: 0, reason: 'not-configured' }; }
  let jwt;
  try { jwt = apnsJWT(); }
  catch (e) { console.log('[APNs] jwt-error ' + e.message); return { status: 0, reason: 'jwt-error:' + e.message }; }

  const payload = JSON.stringify(Object.assign({
    aps: {
      alert: { title: title, body: body || '' },
      sound: 'towstrike_alert.wav',
      'interruption-level': 'time-sensitive'
    }
  }, extra || {}));

  const tok = String(token).slice(0, 12);

  let r = await apnsSendOnce(APNS_PRIMARY, token, jwt, payload);
  console.log('[APNs] host=' + hostLabel(r.host) + ' token=' + tok + '… status=' + r.status + ' reason=' + (r.reason || '-'));

  // Environment mismatch → Apple returns 400 BadDeviceToken. Retry the OTHER host once.
  if (r.status === 400 && r.reason === 'BadDeviceToken') {
    r = await apnsSendOnce(APNS_ALT, token, jwt, payload);
    console.log('[APNs] retry host=' + hostLabel(r.host) + ' token=' + tok + '… status=' + r.status + ' reason=' + (r.reason || '-') + (r.status === 200 ? '  ✓ delivered on fallback host' : ''));
  }
  return r;
}

/* ---- device registry (in-memory; self-heals because the app re-registers on every open) ---- */
const devices = new Map(); // token -> { lat, lon, tier, updated }
const STALE_MS = 21 * 24 * 3600 * 1000;
function gridKey(lat, lon) { // ~28-mile cells so nearby drivers share one TomTom lookup
  return (Math.round(lat / 0.4) * 0.4).toFixed(1) + ',' + (Math.round(lon / 0.4) * 0.4).toFixed(1);
}

/** Lightweight incident lookup for the poll loop: ONE TomTom call, no routing. */
async function pollIncidents(lat, lon) {
  if (!KEY) return [];
  const box = bbox25(lat, lon);
  const fields = encodeURIComponent(
    '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,startTime,from,to,roadNumbers,events{description}}}}'
  );
  const url =
    'https://api.tomtom.com/traffic/services/5/incidentDetails' +
    '?key=' + KEY + '&bbox=' + box + '&fields=' + fields +
    '&language=en-US&categoryFilter=1,14&timeValidityFilter=present';
  const r = await httpsGet(url);
  if (r.status !== 200 || !Array.isArray(r.data && r.data.incidents)) return [];
  const out = [];
  for (const inc of r.data.incidents) {
    const p = inc.properties || {};
    const cat = p.iconCategory;
    if (cat !== 1 && cat !== 14) continue;
    if (!p.id) continue;
    const coords = (inc.geometry && inc.geometry.coordinates) || [];
    let iLat = 0, iLon = 0;
    if (inc.geometry && inc.geometry.type === 'Point') { iLon = coords[0]; iLat = coords[1]; }
    else if (inc.geometry && inc.geometry.type === 'LineString' && coords.length) { iLon = coords[0][0]; iLat = coords[0][1]; }
    if (!iLat || isNaN(iLat)) continue;
    const road = [(p.roadNumbers || []).join(', '), p.from, p.to].filter(Boolean).join(' -> ') || 'Local road';
    out.push({
      id: 'tt-' + p.id,
      type: cat === 1 ? 'accident' : 'disabled',
      road: road,
      ageMin: ageMin(p.startTime),
      slKm: haversineKm(lat, lon, iLat, iLon)
    });
  }
  return out;
}

/* ---- poll loop: detect new leads per area, push to the right phones ---- */
const seenByCell   = new Map(); // cellKey -> Set(incidentId)
const delayedQueue = [];        // { token, title, body, extra, fireAt }
const POLL_MS        = 180000;          // check each active area every 3 min
const NUDGE_DELAY_MS = 40 * 60 * 1000;  // expired-trial nudge fires 40 min late
const FRESH_MIN      = 25;              // only push leads younger than this
let pollCalls = { day: '', n: 0 };
function canPoll() { // hygiene cap so polling never starves the on-demand feed (no-card on TomTom is the real cost backstop)
  const today = new Date().toISOString().slice(0, 10);
  if (pollCalls.day !== today) pollCalls = { day: today, n: 0 };
  return pollCalls.n < 1500;
}

async function pollOnce() {
  if (!apnsConfigured() || devices.size === 0) return;

  // drop devices we haven't heard from in weeks
  const nowT = Date.now();
  for (const [t, d] of devices) if (nowT - d.updated > STALE_MS) devices.delete(t);

  // group active devices into coarse cells
  const cells = new Map(); // cellKey -> { lat, lon, list:[{token,tier}] }
  for (const [token, d] of devices) {
    const key = gridKey(d.lat, d.lon);
    if (!cells.has(key)) cells.set(key, { lat: d.lat, lon: d.lon, list: [] });
    cells.get(key).list.push({ token: token, tier: d.tier });
  }

  for (const [key, cell] of cells) {
    if (!canPoll()) break;
    let incs;
    try { incs = await pollIncidents(cell.lat, cell.lon); pollCalls.n++; }
    catch (_) { continue; }
    if (!Array.isArray(incs)) continue;

    let seen = seenByCell.get(key);
    if (!seen) { seen = new Set(); seenByCell.set(key, seen); }
    const firstRun = seen.size === 0;

    for (const inc of incs) {
      if (seen.has(inc.id)) continue;
      seen.add(inc.id);
      if (firstRun) continue;                                   // prime quietly on first poll of an area
      if (inc.ageMin != null && inc.ageMin > FRESH_MIN) continue; // skip stale leads

      const label = inc.type === 'accident' ? 'Accident' : 'Disabled vehicle';
      const instTitle  = label + ' lead near you';
      const instBody   = (inc.road || 'Nearby road') + ' — open TowStrike to see the net payout.';
      const nudgeTitle = 'A lead just dropped near you';
      const nudgeBody  = label + ' nearby — Pro members got pinged the second it hit. Upgrade so you never miss the next one.';

      for (const dev of cell.list) {
        if (dev.tier === 'trial' || dev.tier === 'pro') {
          sendPush(dev.token, instTitle, instBody, { lead: 1 });
        } else if (dev.tier === 'expired') {
          delayedQueue.push({ token: dev.token, title: nudgeTitle, body: nudgeBody, extra: { nudge: 1 }, fireAt: Date.now() + NUDGE_DELAY_MS });
        }
        // tier 'new' (free, never started trial) gets no push
      }
    }

    if (seen.size > 400) seenByCell.set(key, new Set([...seen].slice(-200))); // bound memory
  }
}

function drainDelayed() {
  const now = Date.now();
  for (let i = delayedQueue.length - 1; i >= 0; i--) {
    if (delayedQueue[i].fireAt <= now) {
      const item = delayedQueue.splice(i, 1)[0];
      sendPush(item.token, item.title, item.body, item.extra);
    }
  }
}

if (apnsConfigured()) {
  setInterval(() => { pollOnce().catch(() => {}); }, POLL_MS);
  setInterval(drainDelayed, 30000);
  console.log('Push engine ON (APNs configured)');
} else {
  console.log('Push engine OFF — set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID to enable');
}

/* ================= routes ================= */

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    tomtom: !!KEY,
    push: apnsConfigured(),
    devices: devices.size,
    queued: delayedQueue.length,
    pollsToday: pollCalls.n
  });
});

/* register / refresh a device for background pushes */
app.post('/register', (req, res) => {
  const b = req.body || {};
  const token = b.token;
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!token || isNaN(lat) || isNaN(lon)) return res.status(400).json({ ok: false, error: 'need token, lat, lon' });
  const tier = ['new', 'trial', 'expired', 'pro'].indexOf(b.tier) >= 0 ? b.tier : 'new';
  devices.set(token, { lat: lat, lon: lon, tier: tier, updated: Date.now() });
  res.json({ ok: true, devices: devices.size });
});

app.post('/unregister', (req, res) => {
  const token = (req.body || {}).token;
  if (token) devices.delete(token);
  res.json({ ok: true });
});

/* fire a one-off test push to a token (for verifying the pipeline) */
app.post('/push/test', async (req, res) => {
  const token = (req.body || {}).token;
  if (!token) return res.status(400).json({ ok: false, error: 'need token' });
  const r = await sendPush(token, 'TowStrike', 'Background notifications are working. Tap to open.', { test: 1 });
  res.json({ ok: r.status === 200, apns: r });
});

app.get('/incidents', async (req, res) => {
  if (!KEY) return res.json([]);

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon)) return res.json([]);

  try {
    /* 1. Fetch incidents from TomTom Traffic */
    const box    = bbox25(lat, lon);
    const fields = encodeURIComponent(
      '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,startTime,from,to,roadNumbers,events{description}}}}'
    );
    const incUrl =
      'https://api.tomtom.com/traffic/services/5/incidentDetails' +
      '?key=' + KEY + '&bbox=' + box + '&fields=' + fields +
      '&language=en-US&categoryFilter=1,14&timeValidityFilter=present';

    const result = await httpsGet(incUrl);

    if (result.status !== 200 || !Array.isArray(result.data && result.data.incidents)) {
      console.error('TomTom traffic error:', result.status,
        JSON.stringify(result.data) && JSON.stringify(result.data).slice(0, 200));
      return res.json([]);
    }

    /* 2. Parse and filter incidents */
    const seen = new Set();
    const out  = [];

    for (const inc of result.data.incidents) {
      const p   = inc.properties || {};
      const cat = p.iconCategory;
      if (cat !== 1 && cat !== 14) continue;

      const id = 'tt-' + (p.id || Math.random().toString(36).slice(2));
      if (seen.has(id)) continue;
      seen.add(id);

      const coords = (inc.geometry && inc.geometry.coordinates) || [];
      let iLat = 0, iLon = 0;
      if (inc.geometry && inc.geometry.type === 'Point') {
        iLon = coords[0]; iLat = coords[1];
      } else if (inc.geometry && inc.geometry.type === 'LineString' && coords.length) {
        iLon = coords[0][0]; iLat = coords[0][1];
      }
      if (!iLat || isNaN(iLat)) continue;

      const road = [
        (p.roadNumbers || []).join(', '),
        p.from,
        p.to
      ].filter(Boolean).join(' -> ') || 'Local road';

      const desc = (Array.isArray(p.events) && p.events.length > 0)
        ? (p.events[0].description || null)
        : null;

      out.push({
        id,
        type:     cat === 1 ? 'accident' : 'disabled',
        road,
        lat:      iLat,
        lon:      iLon,
        ageMin:   ageMin(p.startTime),
        severity: typeof p.magnitudeOfDelay === 'number' ? p.magnitudeOfDelay : 0,
        desc,
        _slKm:    haversineKm(lat, lon, iLat, iLon)
      });
    }

    /* 3. Route the 12 closest incidents in parallel */
    const MAX_ROUTE = 12;
    out.sort(function(a, b) { return a._slKm - b._slKm; });

    const toRoute = out.slice(0, MAX_ROUTE);
    const routeResults = await Promise.all(
      toRoute.map(function(inc) { return routeIncident(lat, lon, inc.lat, inc.lon); })
    );

    const final = out.map(function(inc, idx) {
      const entry = {
        id:       inc.id,
        type:     inc.type,
        road:     inc.road,
        lat:      inc.lat,
        lon:      inc.lon,
        ageMin:   inc.ageMin,
        severity: inc.severity,
        desc:     inc.desc
      };
      if (idx < MAX_ROUTE) {
        const r = routeResults[idx];
        if (typeof r.roadMiles === 'number') entry.roadMiles = r.roadMiles;
        if (typeof r.driveMin  === 'number') entry.driveMin  = r.driveMin;
      }
      return entry;
    });

    res.json(final);

  } catch (err) {
    console.error('incidents handler error:', err.message);
    res.json([]);
  }
});

/* ================= start ================= */
app.listen(PORT, function() {
  console.log('TowStrike API running on port ' + PORT + ' - TomTom incidents + routing + push');
});
