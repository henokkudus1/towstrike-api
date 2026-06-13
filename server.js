'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.TOMTOM_KEY || '';

app.use(cors());

/* ─── helpers ─────────────────────────────────────── */

/** Return a bbox string ~25 miles around a lat/lon. */
function bbox25(lat, lon) {
    const R        = 3958.8;
    const miles    = 25;
    const degLat   = (miles / R) * (180 / Math.PI);
    const degLon   = degLat / Math.cos(lat * Math.PI / 180);
    const minLat   = (lat - degLat).toFixed(5);
    const maxLat   = (lat + degLat).toFixed(5);
    const minLon   = (lon - degLon).toFixed(5);
    const maxLon   = (lon + degLon).toFixed(5);
    return `${minLon},${minLat},${maxLon},${maxLat}`;
}

/** Lightweight HTTPS GET returning {status, data}. */
function httpsGet(url) {
    return new Promise(resolve => {
          const u = new URL(url);
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

/* ─── routes ──────────────────────────────────────── */

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', tomtom: !!KEY });
});

app.get('/incidents', async (req, res) => {
    // Always return a valid JSON array; never fake data
          if (!KEY) {
                return res.json([]);
          }

          const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);

          if (isNaN(lat) || isNaN(lon)) {
                return res.json([]);
          }

          try {
                const box    = bbox25(lat, lon);
                const fields = encodeURIComponent(
                        '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,startTime,from,to,roadNumbers,events{description}}}}'
                      );
                // iconCategory 1 = Accident, 14 = Disabled / broken-down vehicle
      const url = `https://api.tomtom.com/traffic/services/5/incidentDetails` +
                        `?key=${KEY}&bbox=${box}&fields=${fields}` +
                        `&language=en-US&categoryFilter=1,14&timeValidityFilter=present`;

      const result = await httpsGet(url);

      if (result.status !== 200 || !Array.isArray(result.data?.incidents)) {
              console.error('TomTom error:', result.status, JSON.stringify(result.data)?.slice(0,200));
              return res.json([]);
      }

      const seen = new Set();
                const out  = [];

      for (const inc of result.data.incidents) {
              const p    = inc.properties || {};
              const cat  = p.iconCategory;

                  // Keep only accidents (1) and disabled vehicles (14)
                  if (cat !== 1 && cat !== 14) continue;

                  // Deduplicate
                  const id = 'tt-' + (p.id || Math.random().toString(36).slice(2));
              if (seen.has(id)) continue;
              seen.add(id);

                  // Coordinates
                  const coords = inc.geometry?.coordinates || [];
              let iLat = 0, iLon = 0;
              if (inc.geometry?.type === 'Point') {
                        iLon = coords[0]; iLat = coords[1];
              } else if (inc.geometry?.type === 'LineString' && coords.length) {
                        iLon = coords[0][0]; iLat = coords[0][1];
              }
              if (!iLat || isNaN(iLat)) continue;

                  // Human-readable road / location
                  const road = [
                            (p.roadNumbers || []).join(', '),
                            p.from,
                            p.to
                          ].filter(Boolean).join(' → ') || 'Local road';

                  out.push({
                            id,
                            type:   cat === 1 ? 'accident' : 'disabled',
                            road,
                            lat:    iLat,
                            lon:    iLon,
                            ageMin: ageMin(p.startTime)
                  });
      }

      res.json(out);

          } catch (err) {
                console.error('incidents handler error:', err.message);
                res.json([]);
          }
});

/* ─── start ───────────────────────────────────────── */
app.listen(PORT, () =>
    console.log(`TowStrike API running on port ${PORT} — real TomTom incidents enabled`)
           );
