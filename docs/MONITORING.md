# Monitoring (Sentry + uptime)

Use **three Sentry projects** (separate DSNs): API, Web, Mobile. Leave DSNs unset in local/dev — Sentry stays off.

## Sentry — API (Node / Express)

1. Create a **Node.js / Express** project at [sentry.io](https://sentry.io).
2. Set on Railway:

```bash
SENTRY_DSN=https://…@….ingest.sentry.io/…
SENTRY_ENVIRONMENT=production
```

3. Redeploy. Startup log: `[sentry] Enabled`.
4. Reports unhandled 5xx / crashes. Auth headers/cookies stripped. 4xx not sent.

## Sentry — Web (React / Vite)

1. Create a **React** (browser) project in Sentry (different from API).
2. Set on Vercel (or your host) as build env:

```bash
VITE_SENTRY_DSN=https://…@….ingest.sentry.io/…
VITE_SENTRY_ENVIRONMENT=production
```

3. Redeploy the frontend. Unhandled errors + React error boundary are reported.
4. Leave unset locally.

## Sentry — Mobile (Expo / React Native)

1. Create a **React Native** project in Sentry (different DSN again).
2. Set for EAS builds (EAS Secrets or `eas.json` env):

```bash
EXPO_PUBLIC_SENTRY_DSN=https://…@….ingest.sentry.io/…
EXPO_PUBLIC_SENTRY_ENVIRONMENT=production
```

3. Rebuild the app (Expo Go / new native build picks up the public env).
4. Optional for source maps on EAS: add secret `SENTRY_AUTH_TOKEN` and configure org/project on the `@sentry/react-native` Expo plugin.
5. Leave unset in local `.env` while developing.

## Uptime

### Already in repo (GitHub Actions)

Workflow: `.github/workflows/uptime.yml`  
Probes every **5 minutes**:

`GET https://vibe-api-production-5ab1.up.railway.app/api/health`

- Must return **HTTP 200** and `{"ok":true}`
- Manual run: GitHub → Actions → **API uptime** → Run workflow
- Optional: repo **Settings → Secrets and variables → Actions → Variables**  
  `UPTIME_API_BASE` = new API origin (no `/api` suffix) when you change hosts
- Email on failure: GitHub → Settings → Notifications → Actions (workflow failed)

One-shot local check:

```bash
./scripts/uptime-check.sh
# or
API_BASE=https://your-host ./scripts/uptime-check.sh
```

### Optional: UptimeRobot (email/SMS without GitHub)

1. [uptimerobot.com](https://uptimerobot.com) → free account  
2. Add monitor → **HTTPS**  
3. URL: `https://vibe-api-production-5ab1.up.railway.app/api/health`  
4. Interval: 5 minutes → alert email when down  

## Later

- Log shipper when you leave Railway for a VPS
- Prometheus/Grafana only if you need server metrics dashboards
- Session Replay / performance tracing (`*_TRACES_SAMPLE_RATE`) if volume stays low
