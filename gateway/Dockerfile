# Sentient gateway — bundles Bun server + built Preact webui into one image.
#
# Stage layout:
#   deps       : workspace install (Bun native, AVX-independent)
#   webui      : vite build under Node (CI host lacks AVX so Bun crashes in JS)
#   build      : bun build src/main.ts → /app/gateway/dist/main.js
#   runtime    : oven/bun:1-slim + openssl + /app/dist/main.js + /app/webui/dist/

# ---------------------------------------------------------------------------
# Deps — resolve the Bun workspace and materialize node_modules.
# Bun's native install path is AVX-independent, so this works on the CI
# runner even though Bun's JS execution does not.
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY gateway/package.json gateway/
COPY gateway/webui/package.json gateway/webui/
COPY shared/ shared/
RUN bun install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# WebUI — vite build under Node.
#
# The CI runner's CPU lacks AVX, so running Vite under Bun crashes with
# SIGILL inside Bun's JS engine (oven-sh/bun#27006). Vite runs cleanly
# under Node against Bun's installed node_modules.
# ---------------------------------------------------------------------------
FROM node:22-slim AS webui
WORKDIR /app
COPY --from=deps /app /app
COPY gateway/webui/ gateway/webui/
RUN cd gateway/webui && node node_modules/vite/bin/vite.js build

# ---------------------------------------------------------------------------
# Gateway bundle — one-file bun runtime for src/main.ts.
#
# BUILD_PROFILE=release  → minified, no source maps (main branch / prod)
# BUILD_PROFILE=debug    → unminified, source maps inline (develop / default)
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS build
ARG BUILD_PROFILE=debug
WORKDIR /app
COPY --from=deps /app /app
COPY gateway/ gateway/
RUN cd gateway && \
    if [ "$BUILD_PROFILE" = "release" ]; then \
      bun build src/main.ts --outdir dist --target bun --minify \
        --external 'cpu-features' --external 'ssh2'; \
    else \
      bun build src/main.ts --outdir dist --target bun --sourcemap=inline \
        --external 'cpu-features' --external 'ssh2'; \
    fi

# ---------------------------------------------------------------------------
# Runtime — bun slim + openssl + bundled server + built webui.
# openssl is shelled out to by @sentient/tls on first boot to mint the
# self-signed cert for LAN HTTPS/WSS.
# ---------------------------------------------------------------------------
FROM oven/bun:1-slim
ARG BUILD_PROFILE=debug
ENV BUILD_PROFILE=${BUILD_PROFILE}
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl supervisor \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build  /app/gateway/dist        ./dist
COPY --from=webui  /app/gateway/webui/dist  ./webui/dist

COPY gateway/system_prompts/ ./system_prompts/
COPY gateway/prompts/ ./prompts/
COPY gateway/persona.md ./persona.md

# Default config baked into image. Operator may override at runtime by
# mounting their own files at /app/config/*.
COPY gateway/config.yaml ./config/config.yaml
COPY gateway/salience_map.yaml ./config/salience_map.yaml

# Baked-in template seeds (default SOUL etc). Read at runtime by
# template-loader from <runtimeDir>/templates/. Operator overrides
# at <gatewayRoot>/shared/templates/ take precedence.
COPY gateway/templates/ ./templates/

ENV GATEWAY_CONFIG_PATH=/app/config/config.yaml \
    GATEWAY_RUNTIME_DIR=/app \
    GATEWAY_CERTS_DIR=/app/certs \
    WEB_DIST_DIR=/app/webui/dist

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD bun -e "fetch('https://localhost:8888/api/v1/health', { tls: { rejectUnauthorized: false } }).then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1

CMD ["bun", "dist/main.js"]
