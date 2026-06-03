const https = require('https');
const http = require('http');
const PORT = process.env.PORT || 3001;
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || '';
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; TowStrike/1.0)'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('HTTP', res.statusCode, url.substring(0, 80));
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch(e) {
          console.log('Parse error. Body:', body.substring(0, 300));
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', (e) => {
      console.log('Request error:', e.message);
      reject(e);
    });
    req.setTimeout(10000, () => {
      console.log('Request timeout');
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}
async function getTomTom() {
  if (!TOMTOM_KEY) {
    console.log('ERROR: No TomTom API key found in environment');
    return [];
  }
  console.log('TomTom key found:', TOMTOM_KEY.substring(0, 8) + '...');
  try {
    const url = 'https://api.tomtom.com/traffic/services/5/incidentDetails' +
      '?key=' + TOMTOM_KEY +
      '&bbox=-85.20,41.50,-82.00,43.45' +
      '&fields={incidents{type,geometry{type,coordinates},properties{id,iconCategory,startTime,from,to,roadNumbers,events{description}}}}' +
      '&language=en-US' +
      '&timeValidityFilter=present';
    const result = await httpsGet(url);
    console.log('TomTom response:', result.status);
    if (result.status !== 200 || !result.data) {
      console.log('TomTom failed with status:', result.status);
      return [];
    }
    const raw = result.data.incidents || [];
    console.log('TomTom raw incidents:', raw.length);
    const types = {
      0:'Incident', 1:'Accident', 2:'Weather Hazard', 3:'Hazard',
      4:'Weather Hazard', 5:'Hazard', 6:'Congestion', 7:'Lane Closure',
      8:'Road Closure', 9:'Construction', 10:'Weather Hazard',
      11:'Hazard', 14:'Disabled Vehicle'
    };
    const parsed = raw.map((inc, i) => {
      const p = inc.properties || {};
      const coords = inc.geometry?.coordinates || [];
      let lat = 0, lon = 0;
      if (inc.geometry?.type === 'Point') {
        lon = coords[0]; lat = coords[1];
      } else if (inc.geometry?.type === 'LineString' && coords.length > 0) {
        lon = coords[0][0]; lat = coords[0][1];
      }
      const desc = (p.events || []).map(e => e.description).filter(Boolean).join('. ');
      const roads = (p.roadNumbers || []).join(', ');
      const loc = [roads, p.from, p.to].filter(Boolean).join(' to ') || 'Michigan';
      return {
        id: 'tt-' + (p.id || i),
        source: 'TomTom',
        type: types[p.iconCategory] || 'Incident',
        description: desc,
        lat: lat,
        lon: lon,
        location: loc,
        direction: '',
        reported: p.startTime || new Date().toISOString()
      };
    }).filter(i => i.lat !== 0 && i.lon !== 0 && !isNaN(i.lat));
    console.log('TomTom parsed incidents:', parsed.length);
    return parsed;
  } catch(e) {
    console.log('TomTom exception:', e.message);
    return [];
  }
}
async function getWaze() {
  try {
    const url = 'https://www.waze.com/live-map/api/georss' +
      '?top=43.45&bottom=41.50&left=-85.20&right=-82.00' +
      '&env=na&types=alerts,jams';
    const result = await httpsGet(url);
    if (result.status !== 200 || !result.data) return [];
    const alerts = result.data.alerts || [];
    console.log('Waze alerts:', alerts.length);
    return alerts
      .filter(a => a.location?.x && a.location?.y)
      .map((a, i) => ({
        id: 'waze-' + i,
        source: 'Waze',
        type: a.type === 'ACCIDENT' ? 'Accident' :
              a.type === 'HAZARD' ? 'Hazard' : 'Incident',
        description: a.subtype || a.type || '',
        lat: a.location.y,
        lon: a.location.x,
        location: a.street || a.city || 'Michigan',
        direction: '',
        reported: new Date(a.pubMillis || Date.now()).toISOString()
      }));
  } catch(e) {
    console.log('Waze error:', e.message);
    return [];
  }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', tomtomKey: !!TOMTOM_KEY }));
    return;
  }
  if (req.url !== '/incidents') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const [tomtomResult, wazeResult] = await Promise.allSettled([
    getTomTom(),
    getWaze()
  ]);
  const tomtom = tomtomResult.status === 'fulfilled' ? tomtomResult.value : [];
  const waze = wazeResult.status === 'fulfilled' ? wazeResult.value : [];
  const incidents = [...tomtom, ...waze];
  console.log('RESPONSE - TomTom:', tomtom.length, 'Waze:', waze.length, 'Total:', incidents.length);
  res.writeHead(200);
  res.end(JSON.stringify({
    incidents: incidents,
    sources: {
      tomtom: tomtom.length,
      waze: waze.length,
      total: incidents.length,
      isLive: incidents.length > 0
    },
    fetchedAt: new Date().toISOString()
  }));
});
server.listen(PORT, () => {
  console.log('TowStrike API running on port', PORT);
  console.log('TomTom key present:', !!TOMTOM_KEY);
});
