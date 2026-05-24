# fetch-mcp — dockerized HTTP MCP server.
#
# Wraps the upstream mcp-server-fetch package. Outbound URL fetches
# route through `egress-proxy` because the container joins
# `sentient-internal` only.
#
# mcp-server-fetch uses the low-level MCP Server (not FastMCP) and its
# serve() is hardwired to stdio. run_http.py is a thin wrapper that
# replicates the server's tool/prompt registration and runs it via
# StreamableHTTPSessionManager + Uvicorn on 0.0.0.0:8088.
#
# See .claude/rules/gateway/mcp-deployment.md for the deployment standard.

FROM python:3.13-slim

ARG FETCH_MCP_VERSION=2025.4.7

RUN pip install --no-cache-dir \
    "mcp-server-fetch==${FETCH_MCP_VERSION}" \
    "uvicorn[standard]>=0.34" \
    "starlette>=0.46"

ENV PYTHONUNBUFFERED=1

EXPOSE 8088

COPY run_http.py /app/run_http.py

CMD ["python", "/app/run_http.py"]
