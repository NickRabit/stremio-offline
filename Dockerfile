FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/source-selection/package.json packages/source-selection/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY packages/source-selection packages/source-selection
COPY server server
COPY web web
RUN npm run build \
    && npm ci --omit=dev --workspace=@stremio-offline/server \
    && npm cache clean --force

FROM ubuntu:24.04 AS runtime
# Stamped by the build script and by CI so a running server can say which image it is.
ARG BUILD_TIME=""
ARG GIT_COMMIT=""
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data DOWNLOAD_DIR=/downloads \
    BUILD_TIME=$BUILD_TIME GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
# Intel QuickSync drivers exist only for amd64; the arm64 image is built without them.
# Architecture comes from dpkg, not ARG TARGETARCH: only BuildKit fills that in, and
# the classic builder (Container Manager on Synology) leaves it empty, so the drivers
# would be skipped silently and QuickSync would never run on the NAS.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libva-drm2 vainfo util-linux \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver i965-va-driver; fi \
    && useradd --uid 1001 --create-home node \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY package.json package-lock.json ./
COPY packages/source-selection/package.json packages/source-selection/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/source-selection/dist /app/packages/source-selection/dist
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/web/dist /app/web
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data /downloads && chown -R node:node /app /data /downloads && chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
