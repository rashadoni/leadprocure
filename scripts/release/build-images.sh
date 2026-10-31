#!/usr/bin/env bash
set -euo pipefail

# Hosted worker only. No push, registry credentials, production access or deploy.
test "${GITHUB_ACTIONS:-}" = true || { echo 'Use the hosted release-artifacts workflow' >&2; exit 1; }
source_sha=$(git rev-parse HEAD)
public_api_url=${PUBLIC_API_URL:?Public browser API URL required}
release_dir=${RELEASE_OUTPUT_DIR:?Output directory required}
node -e 'const m=require("./scripts/release/manifest.cjs"); m.validateSource(process.argv[1]); m.validateEndpoint(process.argv[2]);' "$source_sha" "$public_api_url"
test -z "$(git status --porcelain --untracked-files=normal)" || { echo 'Build requires a clean checkout' >&2; exit 1; }
mkdir -p "$release_dir"
inspect_dir=$(mktemp -d)
trap 'rm -rf "$inspect_dir"' EXIT
for service in api web; do
  build_args=()
  if [[ "$service" == web ]]; then
    build_args+=(--build-arg "VITE_API_BASE_URL=$public_api_url")
  fi
  docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$source_sha" \
    --label 'org.opencontainers.image.source=https://github.com/rashadoni/leadprocure' \
    --file "apps/$service/Dockerfile" --tag "leadprocure-$service:$source_sha" "${build_args[@]}" .
  docker image inspect "leadprocure-$service:$source_sha" > "$inspect_dir/$service.json"
done
docker image save "leadprocure-api:$source_sha" "leadprocure-web:$source_sha" | gzip -1 > "$release_dir/leadprocure-images.tar.gz"
node scripts/release/manifest.cjs create "$release_dir" "$source_sha" "$public_api_url" "$inspect_dir/api.json" "$inspect_dir/web.json"
node scripts/release/manifest.cjs verify "$release_dir" "$source_sha" "$public_api_url"
# Prove the downloadable archive can restore both tagged images on this worker.
docker image rm "leadprocure-api:$source_sha" "leadprocure-web:$source_sha"
gzip -dc "$release_dir/leadprocure-images.tar.gz" | docker image load
node scripts/release/manifest.cjs verify-loaded "$release_dir" "$source_sha" "$public_api_url"
