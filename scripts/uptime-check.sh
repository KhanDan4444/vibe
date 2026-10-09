#!/usr/bin/env bash
# One-shot health probe (local or CI).
#   API_BASE=https://… ./scripts/uptime-check.sh
set -euo pipefail
BASE="${API_BASE:-https://vibe-api-production-5ab1.up.railway.app}"
BASE="${BASE%/}"
URL="${BASE}/api/health"
echo "Checking ${URL}"
CODE=$(curl -sS -o /tmp/niku-health.json -w '%{http_code}' --max-time 20 "$URL")
echo "HTTP ${CODE}"
cat /tmp/niku-health.json
echo
test "$CODE" = "200"
grep -qE '"ok"[[:space:]]*:[[:space:]]*true' /tmp/niku-health.json
echo "OK"
