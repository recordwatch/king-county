#!/usr/bin/env bash
# Decides whether a failed scrape should turn the run red (and send GitHub's
# failure email). Usage: scrape-health.sh <success|failure>
#
# A failure stays a warning (run stays green) until the scraper has gone
# BROKEN_AFTER_HOURS without a single success. Then one run goes red -- one
# email -- and later failed runs are warnings again until a scrape succeeds.
# State lives in .github/scrape-health.json (SCRAPE_HEALTH_FILE to change it,
# for a repo with several scrape workflows), committed with the data.
set -euo pipefail

STATE=${SCRAPE_HEALTH_FILE:-.github/scrape-health.json}
DATA_PATH=${SCRAPE_DATA_PATH:-data/}
BROKEN_AFTER_HOURS=${BROKEN_AFTER_HOURS:-24}
outcome=${1:-failure}
now=$(date -u +%s)
now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)

write_state() { # $1 = lastSuccess ISO, $2 = alerted (true/false)
  printf '{"lastSuccess":"%s","alerted":%s}\n' "$1" "$2" > "$STATE"
}
out() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "fail=$1" >> "$GITHUB_OUTPUT"; return 0; }

if [ "$outcome" = "success" ]; then
  write_state "$now_iso" false
  out false
  exit 0
fi

# Last success: from the state file if it parses, else the last commit that
# changed DATA_PATH (first run after this was added), else now.
last_iso=$(jq -r '.lastSuccess // empty' "$STATE" 2>/dev/null || true)
last=""
[ -n "$last_iso" ] && last=$(date -u -d "$last_iso" +%s 2>/dev/null || true)
if [ -z "$last" ]; then
  last=$(git log -1 --format=%ct -- "$DATA_PATH" 2>/dev/null || true)
  [ -n "$last" ] || last=$now
  last_iso=$(date -u -d "@$last" +%Y-%m-%dT%H:%M:%SZ)
fi
alerted=$(jq -r 'if .alerted == true then "true" else "false" end' "$STATE" 2>/dev/null || echo false)
hours=$(( (now - last) / 3600 ))

if [ $(( now - last )) -lt $(( BROKEN_AFTER_HOURS * 3600 )) ]; then
  echo "::warning::Scrape failed; last success ${hours}h ago ($last_iso). Not failing the run until ${BROKEN_AFTER_HOURS}h without a success."
  write_state "$last_iso" false
  out false
elif [ "$alerted" = "true" ]; then
  echo "::warning::Still broken: no successful scrape since $last_iso (${hours}h). Already alerted once; staying green until it recovers."
  write_state "$last_iso" true
  out false
else
  echo "::error::Scraper broken: no successful scrape since $last_iso (${hours}h)."
  write_state "$last_iso" true
  out true
fi
