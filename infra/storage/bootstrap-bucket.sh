#!/bin/sh
set -eu
: "${S3_ACCESS_KEY:?required}"
: "${S3_SECRET_KEY:?required}"
: "${S3_BUCKET:?required}"
: "${S3_ENDPOINT:=http://minio:9000}"

# Credentials are arguments, never interpolated into shell source by Compose.
# Bounded retries and fail-closed creation/policy prevent false successful setup.
attempt=0
until mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'Object storage authentication/readiness failed' >&2
    exit 1
  fi
  sleep 2
done
mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"
echo 'Private application bucket ready'
