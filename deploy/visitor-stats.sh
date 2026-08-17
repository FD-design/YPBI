#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${1:-/var/log/nginx/config-driven-bi-access.log}"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "No access log found: $LOG_FILE"
  exit 0
fi

TODAY="$(date +%F)"
PAGE_PATTERN='"GET / HTTP/'

echo "BI visitor statistics"
echo "Log started: $(head -n 1 "$LOG_FILE" | awk '{print $2}' | tr -d '[]')"
echo "Page loads: $(grep -c "$PAGE_PATTERN" "$LOG_FILE" || true)"
echo "Unique IPs: $(grep "$PAGE_PATTERN" "$LOG_FILE" | awk '{print $1}' | sort -u | wc -l)"
echo "Today's page loads: $(grep "$PAGE_PATTERN" "$LOG_FILE" | grep -c "$TODAY" || true)"
echo "Today's unique IPs: $(grep "$PAGE_PATTERN" "$LOG_FILE" | grep "$TODAY" | awk '{print $1}' | sort -u | wc -l)"
echo "Last visit: $(grep "$PAGE_PATTERN" "$LOG_FILE" | tail -n 1 | awk '{print $2}' | tr -d '[]')"
