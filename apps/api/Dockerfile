# Multi-stage build for the NestJS API within the pnpm workspace.
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /repo

FROM base AS build
# Install with only the manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @leadprocure/shared build && pnpm --filter api build

FROM base AS run
ENV NODE_ENV=production
# The whole tree (incl. devDeps + ts-node) is carried so migrations can run at boot.
COPY --from=build /repo /repo
COPY apps/api/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/docker-entrypoint.sh"]
