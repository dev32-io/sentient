FROM debian@sha256:f9c6a2fd2ddbc23e336b6257a5245e31f996953ef06cd13a59fa0a1df2d5c252

ARG ADDON_NAME=attachment-parser
ARG ADDON_VERSION
ARG ADDON_PROTOCOL_VERSION=2
ARG ADDON_REVISION

LABEL org.opencontainers.image.title="${ADDON_NAME}" \
      org.opencontainers.image.version="${ADDON_VERSION}" \
      org.opencontainers.image.revision="${ADDON_REVISION}" \
      io.sentient.addon.name="${ADDON_NAME}" \
      io.sentient.addon.version="${ADDON_VERSION}" \
      io.sentient.addon.protocol-version="${ADDON_PROTOCOL_VERSION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-minimal=3.11.2-1+b1 \
      poppler-utils=22.12.0-2+deb12u3 \
      libvips-tools=8.14.1-3+deb12u3 \
      python3-pip=23.0.1+dfsg-1 \
      python3-cffi=1.15.1-5 \
      libheif1=1.15.1-1+deb12u1 \
      ffmpeg=7:5.1.9-0+deb12u1 \
 && pip3 install --no-cache-dir --break-system-packages --no-deps pyvips==2.2.2 \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY addon.json addon_metadata.py server.py exec_client.py image_worker.py test.sh /app/
COPY tests /app/tests
COPY NOTICE.md /app/NOTICE.md
COPY licenses /app/licenses

USER 65534:65534
CMD ["python3", "/app/server.py"]
