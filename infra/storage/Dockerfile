# Archived upstream source snapshots, built on CI/operator build workers.
# No dependency on the retired minio/minio or minio/mc container repositories.
FROM golang:1.26-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2
WORKDIR /src

# This image is built from source on every pull request (the `fresh-install` job,
# a REQUIRED check), and building it means fetching two git trees and some
# hundreds of Go modules over the network. One dropped connection out of all of
# those turned the gate red twice on 2026-11-01 — on PR #83
# ("stream error ... INTERNAL_ERROR; received from peer" on
# proxy.golang.org/github.com/cosnicolaou/pbzip2) and on `main` at d2acc3e
# ("net/http: TLS handshake timeout" fetching github.com/klauspost/compress) —
# and neither time was anything wrong with the change under test. `go build`
# resolves modules inline and gives up on the first network error, so the whole
# build dies with it.
#
# `retry` is a bounded backoff (5 attempts, 5s/10s/15s/20s between them) and it
# does NOT loosen what this image pins: the base image is still a digest, both
# upstream trees are still checked against their exact commit, and every module
# is still verified against the repository's own go.sum and the default checksum
# database. Retrying a download cannot change what gets built — only whether it
# arrives. If all five attempts fail the step still fails, loudly, naming the
# command: a network outage must not pass for a green build.
RUN printf '%s\n' '#!/bin/sh' \
    'i=1; while [ "$i" -le 5 ]; do "$@" && exit 0;' \
    '  echo "retry: attempt $i of 5 failed: $*" >&2; sleep "$((i * 5))"; i="$((i + 1))"; done;' \
    'echo "retry: giving up after 5 attempts: $*" >&2; exit 1' \
    > /usr/local/bin/retry && chmod 755 /usr/local/bin/retry

RUN git init minio && cd minio && git remote add origin https://github.com/minio/minio.git \
    && retry git fetch --depth 1 origin 7aac2a2c5b7c882e68c1ce017d8256be2feea27f \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 7aac2a2c5b7c882e68c1ce017d8256be2feea27f
# Downloading separately from building is the point: this is the step that
# touches the network, so it is the step that may be retried. `go build` below
# then works from a warm module cache and fails only on real build errors.
RUN cd minio && retry go mod download
RUN cd minio && go build -trimpath -buildvcs=false -o /out/minio .
RUN git init mc && cd mc && git remote add origin https://github.com/minio/mc.git \
    && retry git fetch --depth 1 origin 77f82e18b5401a65958f1619df6ebb994634bd88 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 77f82e18b5401a65958f1619df6ebb994634bd88
RUN cd mc && retry go mod download
RUN cd mc && go build -trimpath -buildvcs=false -o /out/mc .

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /src/minio/LICENSE /usr/share/doc/minio/LICENSE
COPY --from=build /src/mc/LICENSE /usr/share/doc/mc/LICENSE
COPY bootstrap-bucket.sh /usr/local/bin/bootstrap-bucket.sh
RUN chmod 755 /usr/local/bin/bootstrap-bucket.sh
LABEL org.opencontainers.image.title="Leadprocure bundled S3 fixture" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="7aac2a2c5b7c882e68c1ce017d8256be2feea27f" \
      org.leadprocure.mc.revision="77f82e18b5401a65958f1619df6ebb994634bd88"
EXPOSE 9000 9001
HEALTHCHECK --interval=5s --timeout=3s --retries=30 CMD curl -fsS http://127.0.0.1:9000/minio/health/live || exit 1
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
