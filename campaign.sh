#!/bin/sh
# Run (or resume) a campaign, then aggregate what exists.
# Usage: ./campaign.sh [YYYY-MM]
# env: SITES (default sites-1000.json), CONCURRENCY (default 3), STOP_AT (HH:MM, default: none = run to the end)
set -eu
cd "$(dirname "$0")"
CAMPAIGN="${1:-$(date +%Y-%m)}"
mkdir -p results
# one campaign at a time (the monthly cron job must not start a second one beside a manual run)
exec 9>results/.campaign.lock
flock -n 9 || { echo "a campaign is already running"; exit 1; }
chown -R 1001:1001 results 2>/dev/null || true   # pwuser (uid 1001) in the image
docker compose run --rm -T ram-blacklight node --max-old-space-size=3072 src/run.js \
  --out "results/$CAMPAIGN" --sites "${SITES:-sites-1000.json}" --concurrency "${CONCURRENCY:-3}" --min-free-gb 2.5 \
  ${STOP_AT:+--stop-at "$STOP_AT"} >> "results/$CAMPAIGN.log" 2>&1
docker compose run --rm -T ram-blacklight node --max-old-space-size=3072 src/aggregate.js "results/$CAMPAIGN" > "results/$CAMPAIGN.table.txt" 2>&1 || true
tail -n 3 "results/$CAMPAIGN.log"
