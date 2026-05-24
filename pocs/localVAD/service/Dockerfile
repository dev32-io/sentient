# Silero VAD + Smart-Turn v3 PoC service
# Target: Raspberry Pi 5 (linux/arm64, Debian Bookworm)
# Build on the Pi natively: `docker build -t localvad-poc ./service`

FROM python:3.12-slim-bookworm

# Runtime libs:
#   libgomp1     — required by torch aarch64 wheels (silero-vad pulls torch)
#   libsndfile1  — required by soundfile / librosa
#   ca-certs     — needed to fetch model from Hugging Face at build time
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        libsndfile1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so this layer caches across source edits.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Smart-Turn v3.2 CPU ONNX weights into the image.
# This means the container starts fast and works offline.
COPY scripts/download_model.py ./scripts/download_model.py
RUN python scripts/download_model.py /app/models

# Application source.
COPY src/ ./src/

# Volume mount points (created so `docker run -v ...` lands cleanly).
RUN mkdir -p /app/logs /app/recordings

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # RPi5 has 4 Cortex-A76 cores; cap thread pools to avoid oversubscription.
    OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4 \
    TOKENIZERS_PARALLELISM=false \
    # PoC paths (can be overridden at run time)
    LOCALVAD_MODEL_DIR=/app/models \
    LOCALVAD_LOG_DIR=/app/logs \
    LOCALVAD_RECORDING_DIR=/app/recordings \
    LOCALVAD_HOST=0.0.0.0 \
    LOCALVAD_PORT=8765 \
    LOCALVAD_METRICS_INTERVAL_MS=1000

EXPOSE 8765

CMD ["python", "-m", "src.server"]
