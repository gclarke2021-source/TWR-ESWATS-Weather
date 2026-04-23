// Cloudflare Pages Function: /api/weather  (v4)
//
// Changes from v3:
//   - All Ambient API calls now go through a single global rate-limiter
//     (gatedFetch) that enforces a minimum gap between every call, including
//     the previously-ungated gap between /devices and the first /devices/{mac}
//     history call. That gap is what was getting Lugaganeni's today-history
//     rate-limited (HTTP 429) on every request.
//   - Automatic retry with exponential backoff on 429 responses.
//   - computeHiLo() no longer falls back to current-temp-as-both-hi-and-lo
//     when history is empty; it returns nulls so the UI shows "–" instead of
//     misleading identical values.
//   - Partial/error payloads are now cached for only 10s (vs 60s on success)
//     so transient rate-limit hits heal quickly instead of locking in bad
//     data for a full minute.
//   - In-flight request coalescing: concurrent hits on a cold isolate share
//     the same upstream fetch instead of racing each other into 429s.
//
// Environment variables:
//   AW_API_KEY, AW_APP_KEY, LUGAGANENI_MAC, MPANGELA_MAC, STATION_TZ

const AW_BASE = 'https://rt.ambientweather.net/v1';

// Cache tuning
const CACHE_TTL_OK_MS    = 60 * 1000;   // good payload: cache 60s
const CACHE_TTL_DEGRADED_MS = 10 * 1000; // payload with history errors: 10s

// Ambient Weather API limit is 1 req/sec per apiKey. We enforce a slightly
// larger gap to absorb clock/network jitter.
const MIN_GAP_MS = 1300;

// 429 retry policy
const RETRY_BACKOFFS_MS = [1500, 3000]; // two retries; ~1.5s then ~3s

let cache = { ts: 0, data: null, degraded: false };
let inflight = null;          // Promise of the in-flight build, for coalescing
let lastAwCallAt = 0;         // Timestamp of the last Ambient call start

export async function onRequestGet({ env }) {
  try {
    const now = Date.now();
    const ttl = cache.degraded ? CACHE_TTL_DEGRADED_MS : CACHE_TTL_OK_MS;
    if (cache.data && now - cache.ts < ttl) {
      return jsonResponse(cache.data, true);
    }

    // Coalesce concurrent requests so we don't fire two sets of 5 calls at once
    if (!inflight) {
      inflight = buildPayload(env)
        .then((result) => {
          cache = {
            ts: Date.now(),
            data: result.payload,
            degraded: result.degraded,
          };
          return result;
        })
        .finally(() => { inflight = null; });
    }

    const { payload } = await inflight;
    return jsonResponse(payload, false);
  } catch (err) {
    return jsonResponse({ error: String(err && err.message || err) }, false, 500);
  }
}

// ── Main build ────────────────────────────────────────────────────────────────
async function buildPayload(env) {
  const missing = ['AW_API_KEY', 'AW_APP_KEY', 'LUGAGANENI_MAC', 'MPANGELA_MAC']
    .filter((k) => !env[k]);
  if (missing.length) {
    throw new Error('Missing environment variables: ' + missing.join(', '));
  }

  const tz = env.STATION_TZ || 'Africa/Mbabane';
  const stations = [
    { id: 'lugaganeni', name: 'Lugaganeni', mac: env.LUGAGANENI_MAC },
    { id: 'mpangela',   name: 'Mpangela',   mac: env.MPANGELA_MAC  },
  ];

  // 1. Current data for all devices in one call
  const devicesUrl = `${AW_BASE}/devices?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}`;
  const devicesRes = await gatedFetch(devicesUrl);
  if (!devicesRes.ok) {
    throw new Error(`Ambient /devices returned ${devicesRes.status}`);
  }
  const devices = await devicesRes.json();
  const devicesByMac = {};
  for (const d of devices) {
    if (d.macAddress) devicesByMac[d.macAddress.toUpperCase()] = d;
  }

  // 2. Historical windows per station, all through the same global rate-limiter
  const startOfToday = startOfTodayMs(tz);
  const results = [];
  for (const station of stations) {
    const mac = station.mac.toUpperCase();
    const device = devicesByMac[mac];
    const historyResults = await fetchHistoryWindows(mac, env, startOfToday);
    results.push(buildStationPayload(station, device, historyResults, startOfToday));
  }

  const degraded = results.some(r =>
    r.historyErrors && (r.historyErrors.today || r.historyErrors.yesterday)
  );

  const payload = {
    fetchedAt: new Date().toISOString(),
    tz,
    stations: results,
  };

  return { payload, degraded };
}

// Fetch both history windows needed for today/yesterday stats.
// Every fetch goes through gatedFetch() — no raw fetch() calls here.
async function fetchHistoryWindows(mac, env, startOfTodayMs) {
  const result = { today: [], yesterday: [], errors: {} };

  // Today-so-far: no endDate; filter client-side to startOfToday forward.
  try {
    const url = `${AW_BASE}/devices/${encodeURIComponent(mac)}?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}&limit=288`;
    const res = await gatedFetch(url);
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
    result.errors.today = String(e && e.message || e);
  }

  // Yesterday: endDate = start of today in tz. API returns 288 records descending.
  try {
    const url = `${AW_BASE}/devices/${encodeURIComponent(mac)}?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}&limit=288&endDate=${startOfTodayMs}`;
    const res = await gatedFetch(url);
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
    result.errors.yesterday = String(e && e.message || e);
  }

  return result;
}

// ── Global rate limiter ───────────────────────────────────────────────────────
// Serializes ALL Ambient API calls through a single timeline. Every call
// waits until at least MIN_GAP_MS has elapsed since the previous call
// started. Transparently retries on HTTP 429 with exponential backoff.
async function gatedFetch(url) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, lastAwCallAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastAwCallAt = Date.now();

    const res = await fetch(url);
    if (res.status !== 429) return res;

    // 429 — decide whether to retry
    if (attempt >= RETRY_BACKOFFS_MS.length) return res;
    // Prefer server-provided Retry-After if present
    const retryAfterSec = parseInt(res.headers.get('retry-after') || '', 10);
    const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : RETRY_BACKOFFS_MS[attempt];
    await sleep(backoff);
    // Loop again; the lastAwCallAt gate will still be honored.
  }
}

// ── Station payload shaping ───────────────────────────────────────────────────
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

  const todayStats     = computeTodayHiLo(history.today, d, history.errors.today);
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

    rainTodayMm:     inToMm(d.dailyrainin),
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

// Compute today's high/low from history records + live reading.
// IMPORTANT: If no history records AND the history call errored, return nulls.
// We only use the live reading as a "seed" when we HAVE historical records too;
// otherwise we'd be reporting current-temp-as-both-high-and-low, which is a lie.
function computeTodayHiLo(records, latestCurrent, historyError) {
  const haveRecords = Array.isArray(records) && records.length > 0;

  if (!haveRecords) {
    // No history at all. Don't fake hi/lo from the live reading — show "–".
    return { tempHighC: null, tempLowC: null };
  }

  let hi = -Infinity, lo = Infinity, found = false;
  for (const rec of records) {
    if (typeof rec.tempf === 'number') {
      if (rec.tempf > hi) hi = rec.tempf;
      if (rec.tempf < lo) lo = rec.tempf;
      found = true;
    }
  }
  // Fold the live reading in so hi/lo stays current between history polls.
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
function fToC(f)      { if (typeof f !== 'number') return null; return Math.round((f - 32) * 5 / 9 * 10) / 10; }
function mphToKph(m)  { if (typeof m !== 'number') return null; return Math.round(m * 1.60934 * 10) / 10; }
function inToMm(i)    { if (typeof i !== 'number') return null; return Math.round(i * 25.4 * 10) / 10; }
function inHgToHpa(i) { if (typeof i !== 'number') return null; return Math.round(i * 33.8639 * 10) / 10; }
function degToCardinal(deg) {
  if (typeof deg !== 'number') return null;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
// Returns the UTC millisecond timestamp corresponding to 00:00 local-time today
// in the given IANA tz. Used as the cutoff between "today" and "yesterday" for
// Ambient's endDate param and for client-side filtering.
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
