# Build the Vite SPA, serve it as static files via nginx.
FROM node:20-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
# Baked into the bundle at build time — point it at your public API URL.
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ARG API_UPSTREAM_HOST=localhost:3000
ENV API_UPSTREAM_HOST=$API_UPSTREAM_HOST
# Opt-in demo-credentials hint on the login page (demo stands only; default off).
ARG VITE_DEMO_HINT=
ENV VITE_DEMO_HINT=$VITE_DEMO_HINT
# Build shared first so `tsc -b` can resolve @leadprocure/shared types (its dist).
RUN pnpm --filter @leadprocure/shared build && pnpm --filter web build

FROM nginx:alpine AS run
ARG API_UPSTREAM_HOST=localhost:3000
ENV API_UPSTREAM_HOST=$API_UPSTREAM_HOST
ENV NGINX_ENVSUBST_FILTER=API_UPSTREAM_HOST
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
