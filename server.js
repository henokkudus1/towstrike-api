'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.TOMTOM_KEY || '';

app.use(cors());

/* --- helpers --- */

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

/* --- routes --- */

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', tomtom: !!KEY });
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

/* --- start --- */
app.listen(PORT, function() {
  console.log('TowStrike API running on port ' + PORT + ' - real TomTom incidents + routing enabled');
});
