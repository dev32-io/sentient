# ingress-proxy — loopback ingress for the internal-only addons.
#
# Not an MCP server itself: it publishes the host ports the confined MCPs can no
# longer publish for themselves and forwards inward over sentient-internal. See
# nginx.conf for why that indirection exists, and
# .claude/rules/gateway/mcp-deployment.md for the deployment standard.
#
# Pinned to the nginx 1.30 STABLE line (1.30.4 at time of writing). Minor-pinned,
# not patch-pinned: the patch level is the host's business, same convention as
# the pinned Python interpreters.
FROM nginx:1.30-alpine

# REPLACES the stock default server (welcome page on :80) instead of adding to
# it, so nothing listens except the two addon ports.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Fail the BUILD on a malformed conf rather than at container start. Safe with
# the runtime resolver — `nginx -t` does not resolve variable upstreams, so this
# needs none of the services it fronts.
RUN nginx -t

EXPOSE 8087 8088
