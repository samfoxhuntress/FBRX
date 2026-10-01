# FBRX OS control plane + admin console.
#   docker build -t fbrx/control-plane .
#   docker compose -f deploy/control-plane/docker-compose.yml up -d
# The server is bundled into one file with no native modules, so the runtime image is just Node + dist/.

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/core/package.json packages/core/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/admin-console/package.json apps/admin-console/
COPY apps/desktop/package.json apps/desktop/
COPY plugins/example-toolkit/package.json plugins/example-toolkit/
# Electron's binary is not needed to build the server image.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/control-plane apps/control-plane
COPY apps/admin-console apps/admin-console
ARG FBRX_CP_VERSION
RUN npm run build -w @fbrx/admin-console && FBRX_CP_VERSION=${FBRX_CP_VERSION} npm run build -w @fbrx/control-plane

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    FBRX_CP_HOST=0.0.0.0 \
    FBRX_CP_PORT=8787 \
    FBRX_CP_DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/apps/control-plane/dist/ ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FBRX_CP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
