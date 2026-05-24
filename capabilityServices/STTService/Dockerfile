# STT Service — Silero VAD + Smart-Turn v3 + SenseVoice-Small
#
# Multi-arch build: linux/arm64 (Raspberry Pi 5) + linux/amd64 (dev/CI).
# Models are BAKED IN at build time — `docker pull` gives you a fully
# self-contained service. No first-boot setup beyond copying config.yaml.
#
# Build:
#   docker buildx build --platform linux/amd64,linux/arm64 -t stt-service .
#
# Run (standalone, without compose):
#   docker run --rm -it \
#     -p 8766:8766 \
#     -v ~/.sentient/stt-service/config/config.yaml:/app/config/config.yaml:ro \
#     -v ~/.sentient/stt-service/logs:/app/logs \
#     -v ~/.sentient/stt-service/data/recordings:/app/data/recordings \
#     stt-service

FROM python:3.12-slim-bookworm

# Version is owned by the source — `stt_service/__init__.py:__version__` is
# the single source of truth. The /health endpoint reads it directly. No
# Dockerfile ARG/ENV chain to drift out of sync.

# Runtime libs:
#   libgomp1     — required by torch aarch64 wheels (silero-vad pulls torch)
#   libsndfile1  — required by soundfile (via sherpa-onnx)
#   libopus0     — system shared lib for opuslib (ESP32 cube uplink decode)
#   ca-certificates — needed to fetch models from HuggingFace at build time
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        libsndfile1 \
        libopus0 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Layer 1: Python dependencies (cached unless requirements.txt changes) ---
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Layer 2: Model weights (~240 MB, cached unless download_models.py changes) ---
COPY scripts/download_models.py ./scripts/download_models.py
RUN python scripts/download_models.py /app/models

# --- Layer 3: Application source (rebuilt on every code change — fast) ---
COPY src/ ./src/
COPY config/config.example.yaml ./config/config.example.yaml
# Default config baked into image at the path STT_CONFIG_PATH points to.
# Operator can override by mounting a custom config.yaml over this path.
COPY config/config.example.yaml ./config/config.yaml

# Volume mount points — compose bind-mounts host dirs into these.
RUN mkdir -p /app/logs /app/data/recordings /app/config

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    # RPi5: 4 Cortex-A76 cores. Cap thread pools to avoid oversubscription.
    OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4 \
    TOKENIZERS_PARALLELISM=false \
    # Container-internal paths — match docker-compose volume mounts.
    STT_MODEL_DIR=/app/models \
    STT_LOG_DIR=/app/logs \
    STT_RECORDING_DIR=/app/data/recordings \
    STT_CONFIG_PATH=/app/config/config.yaml

EXPOSE 8766
# Health HTTP endpoint — GET /health returns {"status":"ok","version":"..."}
EXPOSE 8767

# Health check: TCP probe on the WebSocket port. Port open = models
# loaded = service is ready. start_period gives the service time to
# load models on first boot (3-5 s warm, up to 60 s cold).
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
    CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8766), timeout=2)" || exit 1

# `python -m stt_service` runs src/stt_service/__main__.py.
CMD ["python", "-m", "stt_service"]
