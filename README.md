# Weather Stations Dashboard

A public web dashboard for two Ambient Weather WS-2902 stations (Lugaganeni and Mpangela),
styled to mirror the base station display. Installs as a phone and Windows app (PWA).

## What's in here

```
weather-app/
├── index.html              # The dashboard
├── manifest.webmanifest    # PWA manifest (home-screen install)
├── sw.js                   # Service worker (offline support)
├── icon.svg                # App icon (vector)
├── icon-192.png            # App icon (phone)
├── icon-512.png            # App icon (high-res)
└── functions/
    └── api/
        └── weather.js      # Cloudflare Pages Function - API proxy
```

## How it works

- The browser loads `index.html` (static) and calls `/api/weather`.
- `/api/weather` is a Cloudflare Pages Function running on the edge. It holds
  your Ambient Weather keys as secret environment variables, calls the Ambient API,
  converts units to metric, computes yesterday's high/low/rain from historical data,
  and returns a clean JSON blob.
- The browser renders the dashboard, auto-refreshing every 5 minutes.
- A 60-second edge cache means even if 1000 people view the dashboard at once,
  Ambient's API still only sees ~1 request per minute per station.

## First-time deployment (Cloudflare Pages)

### 1. Create a Cloudflare account
Go to https://dash.cloudflare.com/sign-up if you don't have one. Free plan is fine.

### 2. Upload the project

**Easiest: direct upload via dashboard**

1. In the Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Name your project something like `weather-stations`.
3. Drag the entire `weather-app` folder (or its zip) into the upload area.
4. Click **Deploy**.

**Or: connect a Git repo** (recommended if you'll change things later)

1. Push the `weather-app` folder to a GitHub repo.
2. In Cloudflare: **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Pick the repo. Build command: (leave blank). Build output directory: `/`.
4. Click **Save and Deploy**.

### 3. Set the environment variables

After the first deploy, go to your Pages project → **Settings** → **Variables and Secrets**.
Add these five variables (use "Encrypt" / secret type for the API keys):

| Name             | Value                                     |
| ---------------- | ----------------------------------------- |
| `AW_API_KEY`     | Your Ambient Weather apiKey               |
| `AW_APP_KEY`     | Your Ambient Weather applicationKey       |
| `LUGAGANENI_MAC` | `48:E7:29:69:B8:5E`                       |
| `MPANGELA_MAC`   | `48:E7:29:5E:9E:37`                       |
| `STATION_TZ`     | `Africa/Mbabane`                          |

After setting variables, go to **Deployments** and redeploy the latest version
(variables don't apply to existing deployments automatically).

### 4. Visit your site

Cloudflare will give you a URL like `https://weather-stations.pages.dev`.
That's your public dashboard. You can attach a custom domain later under
**Custom domains** if you own one.

### 5. Install as an app

- **Android (Chrome)**: Visit the site → menu → "Install app" / "Add to Home screen".
- **iPhone (Safari)**: Visit the site → share button → "Add to Home Screen".
- **Windows (Edge or Chrome)**: Visit the site → address bar shows an install icon
  (or menu → "Install Weather Stations"). It will show up in Start menu like a real app.

## Finding your Ambient Weather keys

1. Log into https://ambientweather.net
2. Click your username → **Account**
3. Scroll to **API Keys**
4. **Application Key**: create one if you don't have one (it's the one for developers)
5. **API Key**: create one for your account (the one that grants read access to your devices)

## Finding your station MAC addresses

1. Log into https://ambientweather.net
2. Click **Devices** (top menu)
3. Click the gear/settings icon next to each station
4. The MAC address is shown in the format `XX:XX:XX:XX:XX:XX`

## Local development (optional)

To preview before deploying, install Cloudflare's `wrangler`:

```bash
npm install -g wrangler
cd weather-app
wrangler pages dev . \
  --binding AW_API_KEY=your-api-key \
  --binding AW_APP_KEY=your-app-key \
  --binding LUGAGANENI_MAC=48:E7:29:69:B8:5E \
  --binding MPANGELA_MAC=48:E7:29:5E:9E:37 \
  --binding STATION_TZ=Africa/Mbabane
```

Then open http://localhost:8788

## Troubleshooting

**"Missing environment variables" shows up on screen**
You deployed before setting the variables, or haven't redeployed since setting them.
Go to Deployments → the three dots on the latest one → "Retry deployment".

**Stations show "offline"**
Either the MAC address in the env vars is wrong, or the station hasn't reported to
Ambient Weather Network recently. Check ambientweather.net to confirm the station
is online there first.

**Yesterday's high/low/rain show "–"**
The function couldn't fetch history. This can happen right after deploy if the
rate limit (1 req/sec per apiKey) hit. Wait 60 seconds and refresh. If it persists,
check your browser dev tools network tab for the response from `/api/weather`.

**Data feels stale**
The dashboard refreshes every 5 minutes. The edge function caches for 60 seconds.
Station itself reports every ~1 minute. Worst case lag: ~6 minutes.

## Future ideas (phase 2)

- Native home-screen widget (not just PWA icon): requires an Android-specific
  wrapper like Flutter or a native Kotlin app.
- Windows taskbar widget: similar story - needs a WinUI 3 app or a widget
  adopter like Rainmeter/WidgetKit.
- History graphs (last 24h temperature/rain trend): the function already pulls
  history - just needs a chart tile.
- Lightning alerts: Ambient API includes lightning fields if you add the sensor.
