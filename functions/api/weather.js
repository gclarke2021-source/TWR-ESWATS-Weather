// Cloudflare Pages Function: /api/weather
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
      { id: 'mpangela', name: 'Mpangela', mac: env.MPANGELA_MAC },
    ];

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

    const results = [];
    for (const station of stations) {
      const mac = station.mac.toUpperCase();
      const device = devicesByMac[mac];
      let history = [];
      try {
        const yesterdayEnd = endOfYesterdayMs(tz);
        const histUrl = `${AW_BASE}/devices/${encodeURIComponent(mac)}?applicationKey=${env.AW_APP_KEY}&apiKey=${env.AW_API_KEY}&limit=288&endDate=${yesterdayEnd}`;
        const histRes = await fetch(histUrl);
        if (histRes.ok) history = await histRes.json();
      } catch (e) {}
      await sleep(1100);
      results.push(buildStationPayload(station, device, history));
    }

    const payload = { fetchedAt: new Date().toISOString(), tz, stations: results };
    cache = { ts: now, data: payload };
    return jsonResponse(payload, false);
  } catch (err) {
    return jsonResponse({ error: String(err) }, false, 500);
  }
}

function buildStationPayload(station, device, history) {
  if (!device || !device.lastData) {
    return { id: station.id, name: station.name, online: false, error: 'No recent data' };
  }
  const d = device.lastData;
  const yesterday = computeYesterdayStats(history);
  return {
    id: station.id, name: station.name, online: true,
    observedAt: d.date || (d.dateutc ? new Date(d.dateutc).toISOString() : null),
    tempC: fToC(d.tempf), humidity: d.humidity,
    tempInC: fToC(d.tempinf), humidityIn: d.humidityin,
    windKph: mphToKph(d.windspeedmph), windGustKph: mphToKph(d.windgustmph),
    windDirDeg: d.winddir, windDirCardinal: degToCardinal(d.winddir),
    rainTodayMm: inToMm(d.dailyrainin), rainRateMmPerHr: inToMm(d.hourlyrainin),
    pressureHpa: inHgToHpa(d.baromrelin), uv: d.uv, solarWm2: d.solarradiation,
    yesterday,
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
    tempLowC: found ? fToC(lo) : null,
    rainMm: inToMm(rainMax),
  };
}

function fToC(f) { if (typeof f !== 'number') return null; return Math.round((f - 32) * 5/9 * 10)/10; }
function mphToKph(m) { if (typeof m !== 'number') return null; return Math.round(m * 1.60934 * 10)/10; }
function inToMm(i) { if (typeof i !== 'number') return null; return Math.round(i * 25.4 * 10)/10; }
function inHgToHpa(i) { if (typeof i !== 'number') return null; return Math.round(i * 33.8639 * 10)/10; }
function degToCardinal(deg) {
  if (typeof deg !== 'number') return null;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

function endOfYesterdayMs(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const localMidnightGuess = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 0, 0, 0);
  const tzDate = new Date(localMidnightGuess);
  const tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false });
  const tzHour = +tzFmt.format(tzDate);
  const offsetHours = tzHour >= 12 ? tzHour - 24 : tzHour;
  return localMidnightGuess - offsetHours * 3600 * 1000;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jsonResponse(data, fromCache, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'x-cache': fromCache ? 'HIT' : 'MISS',
      'access-control-allow-origin': '*',
    },
  });
}
