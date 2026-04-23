// Cloudflare Pages Function: /api/weather  (v3)
//
// Changes from v2:
//   - Increased all sleep() delays from 1200ms to 2000ms to avoid HTTP 429
//     rate-limit errors from the Ambient Weather API (1 req/sec per apiKey).
//
// Environment variables:
//   AW_API_KEY, AW_APP_KEY, LUGAGANENI_MAC, MPANGELA_MAC, STATION_TZ
 
const AW_BASE = 'https://rt.ambientweather.net/v1';
const CACHE_TTL_MS = 60 * 1000;
let cache = { ts: 0, data: null };
 
export async function onRequestGet({ env }) {
  try {
    const now = Date.now();
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      return jsonResponse(cache.data, true);
    }
 
    const missing = ['AW_API_KEY', 'AW_APP_KEY', 'LUGAGANENI_MAC', 'MPANGELA_MAC']
      .filter((k) => !env[k]);
    if (missing.length) {
      return jsonResponse(
        { error: 'Missing environment variables: ' + missing.join(', ') },
        false, 500
      );
    }
 
    const tz = env.STATION_TZ || 'Africa/Mbabane';
    const stations = [
      { id: 'lugaganeni', name: 'Lugaganeni', mac: env.LUGAGANENI_MAC },
      { id: 'mpangela',   name: 'Mpangela',   mac: env.MPANGELA_MAC  },
    ];
 
    // 1. Current data for all devices in one call
    const devicesUrl = `${AW_BASE}/devices?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}`;
    const devicesRes = await fetch(devicesUrl);
    if (!devicesRes.ok) {
      return jsonResponse({ error: `Ambient API returned ${devicesRes.status}` }, false, 502);
    }
    const devices = await devicesRes.json();
    const devicesByMac = {};
    for (const d of devices) {
      if (d.macAddress) devicesByMac[d.macAddress.toUpperCase()] = d;
    }
 
    // 2. Historical data for each station.
    //    We fetch TWO windows per station: today-so-far (for today hi/lo)
    //    and yesterday (for yesterday hi/lo + total rain).
    //    Sequential calls with 2000ms delay between them to stay well under
    //    the Ambient API 1 req/sec per-apiKey rate limit.
    const results = [];
    for (let i = 0; i < stations.length; i++) {
      const station = stations[i];
      const mac = station.mac.toUpperCase();
      const device = devicesByMac[mac];
 
      const startOfToday = startOfTodayMs(tz);
      const historyResults = await fetchHistoryWindows(mac, env, startOfToday);
 
      results.push(buildStationPayload(station, device, historyResults, startOfToday));
 
      // Politeness delay between stations (skip after last)
      if (i < stations.length - 1) await sleep(2000);
    }
 
    const payload = {
      fetchedAt: new Date().toISOString(),
      tz,
      stations: results,
    };
 
    cache = { ts: now, data: payload };
    return jsonResponse(payload, false);
  } catch (err) {
    return jsonResponse({ error: String(err) }, false, 500);
  }
}
 
// Fetch both history windows needed for today/yesterday stats.
async function fetchHistoryWindows(mac, env, startOfTodayMs) {
  const result = { today: [], yesterday: [], errors: {} };
 
  // Today-so-far: endDate = now (default). Filter client-side to startOfToday forward.
  try {
    const url = `${AW_BASE}/devices/${encodeURIComponent(mac)}?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}&limit=288`;
    const res = await fetch(url);
    if (!res.ok) {
      result.errors.today = `HTTP ${res.status}`;
    } else {
      const data = await res.json();
      if (Array.isArray(data)) {
        result.today = data.filter(r => typeof r.dateutc === 'number' && r.dateutc >= startOfTodayMs);
      } else {
        result.errors.today = 'unexpected response shape';
      }
    }
  } catch (e) {
    result.errors.today = String(e);
  }
 
  // 2000ms between today and yesterday calls for this station
  await sleep(2000);
 
  // Yesterday: endDate = start of today in tz. API returns descending 288 records.
  try {
    const url = `${AW_BASE}/devices/${encodeURIComponent(mac)}?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}&limit=288&endDate=${startOfTodayMs}`;
    const res = await fetch(url);
    if (!res.ok) {
      result.errors.yesterday = `HTTP ${res.status}`;
    } else {
      const data = await res.json();
      if (Array.isArray(data)) {
        result.yesterday = data;
      } else {
        result.errors.yesterday = 'unexpected response shape';
      }
    }
  } catch (e) {
    result.errors.yesterday = String(e);
  }
 
  return result;
}
 
function buildStationPayload(station, device, history, startOfTodayMs) {
  if (!device || !device.lastData) {
    return {
      id: station.id,
      name: station.name,
      online: false,
      error: 'No recent data from this station',
    };
  }
  const d = device.lastData;
 
  const todayStats     = computeHiLo(history.today, d);
  const yesterdayStats = computeYesterdayStats(history.yesterday);
 
  return {
    id: station.id,
    name: station.name,
    online: true,
    observedAt: d.date || (d.dateutc ? new Date(d.dateutc).toISOString() : null),
 
    tempC:      fToC(d.tempf),
    humidity:   d.humidity,
    tempInC:    fToC(d.tempinf),
    humidityIn: d.humidityin,
 
    windKph:         mphToKph(d.windspeedmph),
    windGustKph:     mphToKph(d.windgustmph),
    windDirDeg:      d.winddir,
    windDirCardinal: degToCardinal(d.winddir),
 
    rainTodayMm:    inToMm(d.dailyrainin),
    rainRateMmPerHr: inToMm(d.hourlyrainin),
 
    pressureHpa: inHgToHpa(d.baromrelin),
    uv:          d.uv,
    solarWm2:    d.solarradiation,
 
    today:     todayStats,
    yesterday: yesterdayStats,
 
    historyErrors: {
      today:     history.errors.today     || null,
      yesterday: history.errors.yesterday || null,
    },
    historyCounts: {
      today:     history.today.length,
      yesterday: history.yesterday.length,
    },
  };
}
 
function computeHiLo(records, latestCurrent) {
  if (!Array.isArray(records) || records.length === 0) {
    if (latestCurrent && typeof latestCurrent.tempf === 'number') {
      const t = fToC(latestCurrent.tempf);
      return { tempHighC: t, tempLowC: t };
    }
    return { tempHighC: null, tempLowC: null };
  }
  let hi = -Infinity, lo = Infinity;
  let found = false;
  for (const rec of records) {
    if (typeof rec.tempf === 'number') {
      if (rec.tempf > hi) hi = rec.tempf;
      if (rec.tempf < lo) lo = rec.tempf;
      found = true;
    }
  }
  // Also include the current live reading so the hi/lo is always up to date
  if (latestCurrent && typeof latestCurrent.tempf === 'number') {
    if (latestCurrent.tempf > hi) hi = latestCurrent.tempf;
    if (latestCurrent.tempf < lo) lo = latestCurrent.tempf;
    found = true;
  }
  return {
    tempHighC: found ? fToC(hi) : null,
    tempLowC:  found ? fToC(lo) : null,
  };
}
 
function computeYesterdayStats(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { tempHighC: null, tempLowC: null, rainMm: null };
  }
  let hi = -Infinity, lo = Infinity, rainMax = 0, found = false;
  for (const rec of history) {
    if (typeof rec.tempf === 'number') {
      if (rec.tempf > hi) hi = rec.tempf;
      if (rec.tempf < lo) lo = rec.tempf;
      found = true;
    }
    if (typeof rec.dailyrainin === 'number' && rec.dailyrainin > rainMax) {
      rainMax = rec.dailyrainin;
    }
  }
  return {
    tempHighC: found ? fToC(hi) : null,
    tempLowC:  found ? fToC(lo) : null,
    rainMm:    inToMm(rainMax),
  };
}
 
// ── Unit helpers ──────────────────────────────────────────────────────────────
function fToC(f)       { if (typeof f !== 'number') return null; return Math.round((f - 32) * 5 / 9 * 10) / 10; }
function mphToKph(m)   { if (typeof m !== 'number') return null; return Math.round(m * 1.60934 * 10) / 10; }
function inToMm(i)     { if (typeof i !== 'number') return null; return Math.round(i * 25.4 * 10) / 10; }
function inHgToHpa(i)  { if (typeof i !== 'number') return null; return Math.round(i * 33.8639 * 10) / 10; }
function degToCardinal(deg) {
  if (typeof deg !== 'number') return null;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}
 
// ── Timezone helpers ──────────────────────────────────────────────────────────
function startOfTodayMs(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
  const localMidnightGuess = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 0, 0, 0);
  const tzDate = new Date(localMidnightGuess);
  const tzFmt  = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false });
  const tzHour = +tzFmt.format(tzDate);
  const offsetHours = tzHour >= 12 ? tzHour - 24 : tzHour;
  return localMidnightGuess - offsetHours * 3600 * 1000;
}
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
 
// ── Response helper ───────────────────────────────────────────────────────────
function jsonResponse(data, fromCache, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type':                'application/json; charset=utf-8',
      'cache-control':               'public, max-age=60',
      'x-cache':                     fromCache ? 'HIT' : 'MISS',
      'access-control-allow-origin': '*',
    },
  });
}
 
