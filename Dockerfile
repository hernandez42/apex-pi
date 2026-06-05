# syntax=docker/dockerfile:1.7
# Multi-stage build: keep the runtime image small by bundling all sources
# into a single ESM file and running it on the official Bun image.
# Bun's `--target=bun` bundle keeps ESM + import attributes intact.

# ---------- build stage ----------
FROM oven/bun:1.1.34-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills

# Bundle the HTTP server entry into one ESM file.
RUN bun build --target=bun --outfile=/out/cli.js src/cli.ts

# ---------- runtime stage ----------
FROM oven/bun:1.1.34-alpine
RUN apk add --no-cache ca-certificates tini
WORKDIR /app
COPY --from=build /out/cli.js /app/cli.js

# persistent volume (mounted via fly.toml)
RUN mkdir -p /data && chmod 777 /data
ENV APEX_PI_DATA=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    BUN_NO_DEBUG=1 \
    LOG_LEVEL=info \
    MCP_ENABLED=1

# tiny entrypoint shim: start --feishu when FEISHU_ENABLED=1, else plain HTTP.
RUN printf '#!/bin/sh\nset -e\nif [ "${FEISHU_ENABLED}" = "1" ]; then exec bun run /app/cli.js --feishu; else exec bun run /app/cli.js; fi\n' > /usr/local/bin/apex-pi-entry
RUN chmod +x /usr/local/bin/apex-pi-entry

# tini: reaps zombies, signals correctly
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/apex-pi-entry"]

EXPOSE 8080
