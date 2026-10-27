# Archived upstream source snapshots, built on CI/operator build workers.
# No dependency on the retired minio/minio or minio/mc container repositories.
FROM golang:1.26-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOFLAGS=-p=2
WORKDIR /src
RUN git init minio && cd minio && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth 1 origin 7aac2a2c5b7c882e68c1ce017d8256be2feea27f \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 7aac2a2c5b7c882e68c1ce017d8256be2feea27f
RUN cd minio && go build -trimpath -buildvcs=false -o /out/minio .
RUN git init mc && cd mc && git remote add origin https://github.com/minio/mc.git \
    && git fetch --depth 1 origin 77f82e18b5401a65958f1619df6ebb994634bd88 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 77f82e18b5401a65958f1619df6ebb994634bd88
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
