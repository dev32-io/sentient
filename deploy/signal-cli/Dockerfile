# sentient/signal-cli — signal-cli native HTTP daemon, multi-account mode.
#
# Hermes' Signal adapter (gateway/platforms/signal.py in the Hermes image)
# is written for signal-cli's native HTTP daemon. It expects:
#   GET  /api/v1/check                  — health
#   GET  /api/v1/events?account=<E164>  — SSE inbound message stream
#   POST /api/v1/rpc                    — JSON-RPC for send + everything else
#
# bbernhard/signal-cli-rest-api exposes a different, REST-shaped API at /v1/...
# Hermes does NOT speak that. We run the upstream signal-cli binary directly.
#
# Multi-account mode: started WITHOUT `-a` so the same daemon serves every
# user's linked account. Per-request `"account":"+E164"` selects which one.
# Linking uses startLink / finishLink JSON-RPC methods (no account parameter
# needed pre-link).
#
# Build:
#   docker build -f deploy/signal-cli/Dockerfile -t sentient/signal-cli:local .

ARG SIGNAL_CLI_VERSION=0.14.3
ARG LIBSIGNAL_CLIENT_JAR_VERSION=0.92.1

# ---------------------------------------------------------------------------
# Stage 1: pull bbernhard's published image purely to extract their
# linux/aarch64 build of libsignal_jni.so. Upstream signal-cli ships native
# JNI shims for macOS arm64/x64, Linux x64, and Windows x64 — but NOT Linux
# aarch64. Without an arm64 .so the JVM aborts at boot with
# "no signal_jni in java.library.path" on Apple Silicon Docker Desktop or
# Raspberry Pi 5. bbernhard solves this by injecting their own arm64 build
# named "libsignal_jni.so" (no arch suffix) into the same jar.
# ---------------------------------------------------------------------------
FROM bbernhard/signal-cli-rest-api:latest AS libsignal-arm64-source

# ---------------------------------------------------------------------------
# Stage 2: the actual signal-cli daemon image.
# ---------------------------------------------------------------------------
# signal-cli 0.14.x targets Java 25 (class file version 69). Older Temurin
# bases (21, 24) crash with UnsupportedClassVersionError at JVM boot.
FROM eclipse-temurin:25-jre

ARG SIGNAL_CLI_VERSION
ARG LIBSIGNAL_CLIENT_JAR_VERSION
ENV SIGNAL_CLI_VERSION=${SIGNAL_CLI_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates zip unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/signal-cli.tar.gz \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
    && tar -xzf /tmp/signal-cli.tar.gz -C /opt \
    && ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli \
    && rm /tmp/signal-cli.tar.gz

# Patch the upstream libsignal-client jar with bbernhard's linux/aarch64
# libsignal_jni.so. Only effective on linux/arm64 builds — amd64 builds
# already have what they need in the upstream jar.
COPY --from=libsignal-arm64-source \
     /opt/signal-cli-${SIGNAL_CLI_VERSION}/lib/libsignal-client-${LIBSIGNAL_CLIENT_JAR_VERSION}.jar \
     /tmp/libsignal-bbernhard.jar
RUN set -eu; \
    arch="$(uname -m)"; \
    if [ "$arch" = "aarch64" ]; then \
      unzip -p /tmp/libsignal-bbernhard.jar libsignal_jni.so > /tmp/libsignal_jni.so; \
      zip -j "/opt/signal-cli-${SIGNAL_CLI_VERSION}/lib/libsignal-client-${LIBSIGNAL_CLIENT_JAR_VERSION}.jar" /tmp/libsignal_jni.so; \
      echo "patched libsignal-client jar with linux/aarch64 libsignal_jni.so"; \
    else \
      echo "linux/${arch} — upstream jar ships its native libsignal_jni"; \
    fi; \
    rm -f /tmp/libsignal-bbernhard.jar /tmp/libsignal_jni.so

# Stable data path. Mounted from ~/.sentient/signal-cli/ on the host so
# linked-device keys + message store survive rebuilds.
ENV SIGNAL_CLI_DATA_DIR=/var/lib/signal-cli

# UID 1000 is occupied by `ubuntu` in eclipse-temurin:25-jre's Ubuntu base.
# Use 1001 so this image is reproducible across base bumps.
RUN useradd --create-home --shell /bin/sh --uid 1001 signal \
    && mkdir -p ${SIGNAL_CLI_DATA_DIR} \
    && chown -R signal:signal ${SIGNAL_CLI_DATA_DIR}

USER signal
WORKDIR /home/signal

# Multi-account daemon. No -a flag → all linked accounts served from one JVM.
# 0.0.0.0:8080 so sibling docker containers can dial via container name.
# --receive-mode on-start eagerly subscribes inbound stream so SSE
# /api/v1/events delivers messages immediately on connect.
EXPOSE 8080
CMD ["sh", "-c", "exec signal-cli --config ${SIGNAL_CLI_DATA_DIR} daemon --http 0.0.0.0:8080 --receive-mode on-start"]
