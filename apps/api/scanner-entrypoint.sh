#!/bin/sh
set -eu

# Update signatures only when an upload or catch-up execution actually starts. If
# the update endpoint is temporarily unavailable, baked signatures remain usable;
# a database older than seven days fails closed and leaves every row PENDING.
if ! freshclam --stdout; then
  if ! find /var/lib/clamav -type f \( -name '*.cvd' -o -name '*.cld' \) -print -quit | grep -q .; then
    echo 'No ClamAV signature database is available' >&2
    exit 1
  fi
  if ! find /var/lib/clamav -type f \( -name 'daily.cvd' -o -name 'daily.cld' \) -mtime -7 -print -quit | grep -q .; then
    echo 'ClamAV daily signatures are older than seven days and could not be updated' >&2
    exit 1
  fi
  echo 'Freshclam update failed; using recent baked signatures' >&2
fi

clamd --foreground=true &
clamd_pid=$!
cleanup() {
  kill "$clamd_pid" 2>/dev/null || true
  wait "$clamd_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node /repo/apps/api/dist/scan-job.js
