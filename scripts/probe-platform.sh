#!/usr/bin/env bash
# Proves abort/resume of the repair Actor on the real platform with the dummy `probe` mode:
# start a run, abort it while slow_steps is in the middle, start again with the same input, show both logs.
# Usage: scripts/probe-platform.sh <repairActorId> <scraperActorId> <failedRunId> [abortAfterSeconds]
set -euo pipefail
REPAIR=$1; SCRAPER=$2; FAILED=$3; ABORT_AFTER=${4:-75}
API=https://api.apify.com/v2
H=(-H "Authorization: Bearer $APIFY_TOKEN" -H "content-type: application/json")
INPUT=$(printf '{"actorId":"%s","failedRunId":"%s","mode":"probe"}' "$SCRAPER" "$FAILED")

start() { curl -s -X POST "${H[@]}" "$API/acts/$REPAIR/runs" -d "$INPUT" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])'; }
status() { curl -s "${H[@]}" "$API/actor-runs/$1" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])'; }
logof() { curl -s "${H[@]}" "$API/actor-runs/$1/log" | grep -v "^\s*$" | grep "\] \[" || true; }

echo "== run 1: start"; R1=$(start); echo "run 1 = $R1"
sleep "$ABORT_AFTER"
echo "== run 1: abort at ${ABORT_AFTER}s (status before: $(status "$R1"))"
curl -s -X POST "${H[@]}" "$API/actor-runs/$R1/abort" > /dev/null
for _ in $(seq 1 30); do s=$(status "$R1"); [ "$s" = "ABORTED" ] && break; sleep 2; done
echo "run 1 status: $(status "$R1")"
logof "$R1" | tail -n 25
echo; echo "== run 2: same input"; R2=$(start); echo "run 2 = $R2"
for _ in $(seq 1 90); do s=$(status "$R2"); case "$s" in SUCCEEDED|FAILED|ABORTED|TIMED-OUT) break;; esac; sleep 5; done
echo "run 2 status: $(status "$R2")"
logof "$R2" | cut -c1-260
