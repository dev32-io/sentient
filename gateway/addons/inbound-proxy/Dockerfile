# The PUBLIC entrance. Stock nginx, one config, no code of ours — the same
# encapsulation the internal ingress-proxy uses.
FROM nginx:1.30-alpine

COPY nginx.conf /etc/nginx/conf.d/inbound-proxy.conf

# The stock image ships a default server on :80 that would shadow ours.
RUN rm -f /etc/nginx/conf.d/default.conf

# Fail the BUILD on a malformed config rather than at 3am on a restart loop.
# `-t` needs the cert paths to exist; they are mounted at runtime, so point the
# test at throwaway material and delete it in the same layer.
RUN apk add --no-cache openssl \
  && mkdir -p /etc/sentient/outward /etc/sentient/upstream \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
       -subj "/CN=buildcheck" \
       -keyout /etc/sentient/outward/key.pem \
       -out /etc/sentient/outward/cert.pem 2>/dev/null \
  && cp /etc/sentient/outward/cert.pem /etc/sentient/upstream/cert.pem \
  && nginx -t \
  && rm -f /etc/sentient/outward/key.pem /etc/sentient/outward/cert.pem /etc/sentient/upstream/cert.pem \
  && apk del openssl

EXPOSE 8080 8443
