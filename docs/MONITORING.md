# Monitoring (Sentry + uptime)

## Sentry (API errors)

1. Sign up at [sentry.io](https://sentry.io) → create a **Node.js / Express** project.
2. Copy the **DSN** (Settings → Client Keys).
3. Set on Railway (or your host):

```bash
SENTRY_DSN=https://…@….ingest.sentry.io/…
SENTRY_ENVIRONMENT=production
```

4. Redeploy the API. Startup log should show `[sentry] Enabled`.
5. Optional test: temporarily throw in a route, confirm the issue appears in Sentry, then revert.

**Local:** leave `SENTRY_DSN` unset — Sentry stays off.

**What gets reported:** unhandled 5xx and crashes. Auth headers/cookies are stripped. 4xx are not sent.

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

- Web/mobile Sentry projects (separate DSNs)
- Log shipper when you leave Railway for a VPS
- Prometheus/Grafana only if you need server metrics dashboards
