# searxng-mcp — dockerized HTTP MCP adapter for SearXNG.
#
# Wraps the upstream searxng-mcp-server (IceWreck) in streamable-http
# transport. Forwards search queries to the sibling `sentient-searxng`
# container over the sentient-internal network. No direct upstream egress
# here — SearXNG is the one that fans out to engines via egress-proxy.
#
# Tool surface (5 tools):
#   search_web     — general web search
#   search_images  — image search
#   search_videos  — video search
#   search_news    — news search
#   fetch_url      — fetch + convert URL to markdown
#
# SEARXNG_URL is required. Defaults to the sibling container on
# sentient-internal; overridden at runtime by the service template.
#
# FastMCP 3.x binds to 127.0.0.1 by default; FASTMCP_HOST=0.0.0.0
# overrides this to accept connections from within sentient-internal.
#
# See .claude/rules/gateway/mcp-deployment.md for the deployment standard.

FROM python:3.13-slim

ARG SEARXNG_MCP_VERSION=0.1.9

RUN pip install --no-cache-dir "searxng-mcp-server==${SEARXNG_MCP_VERSION}"

ENV PYTHONUNBUFFERED=1
ENV FASTMCP_HOST=0.0.0.0
ENV SEARXNG_URL=http://sentient-searxng:8080

EXPOSE 8087

CMD ["python", "-m", "searxng_mcp_server.main", "--port", "8087"]
