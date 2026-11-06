# Share for CortenDesk. Built by GitHub Actions and published to ghcr.io.
FROM node:24-alpine AS build
WORKDIR /src/webclient
COPY webclient/package.json webclient/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY webclient/ ./
COPY public/ /src/public/
RUN npx tsc --noEmit \
 && npx vitest run src/gateway \
 && npm run build \
 && npm run build:server

FROM node:24-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} PORT=8090 DATA_DIR=/data PUBLIC_DIR=/app/public NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /src/dist/sidecar.mjs /app/dist/sidecar.mjs
COPY --from=build /src/public/ /app/public/
RUN mkdir -p /data && chown node:node /data && find /app/public -name '*.map' -delete
USER node
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8090}/health" || exit 1
CMD ["node", "/app/dist/sidecar.mjs"]
