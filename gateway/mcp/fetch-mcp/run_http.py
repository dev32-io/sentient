"""
Streamable-HTTP wrapper for mcp-server-fetch.

mcp-server-fetch's serve() is hardwired to stdio transport. This script
replicates the server setup (tools, prompts, call_tool handlers) from
mcp_server_fetch.server, then runs it on streamable-http via
StreamableHTTPSessionManager + Uvicorn.

Outbound HTTP fetches use the proxy set in HTTP_PROXY / HTTPS_PROXY env
vars (injected by the compose service template at runtime).
"""

import asyncio
import os
import uvicorn

from contextlib import asynccontextmanager
from typing import AsyncIterator

from starlette.applications import Starlette
from starlette.routing import Route

from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.fastmcp.server import StreamableHTTPASGIApp
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import (
    ErrorData,
    GetPromptResult,
    Prompt,
    PromptArgument,
    PromptMessage,
    TextContent,
    Tool,
    INVALID_PARAMS,
    INTERNAL_ERROR,
)
from mcp.shared.exceptions import McpError

from mcp_server_fetch.server import (
    Fetch,
    DEFAULT_USER_AGENT_AUTONOMOUS,
    DEFAULT_USER_AGENT_MANUAL,
    check_may_autonomously_fetch_url,
    fetch_url,
)

HOST = "0.0.0.0"
PORT = 8088

# Default outbound identity. mcp-server-fetch's built-in autonomous UA
# (ModelContextProtocol/1.0) is actively blackholed/reset by common CDNs
# (Akamai, Cloudflare) — including on the robots.txt preflight — which surfaces
# to Hermes as "connection issue" and fails the whole fetch. Presenting a
# mainstream browser UA restores reach. Override per-operator via env.
DEFAULT_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Env knobs (operator-overridable; see gateway/templates/services/fetch-mcp.yaml):
#   FETCH_USER_AGENT        — UA string for autonomous + manual fetches.
#                             Empty/unset -> DEFAULT_BROWSER_USER_AGENT.
#   FETCH_IGNORE_ROBOTS_TXT — "true"/"1"/"yes" skips the robots.txt preflight.
ENV_USER_AGENT = "FETCH_USER_AGENT"
ENV_IGNORE_ROBOTS_TXT = "FETCH_IGNORE_ROBOTS_TXT"
_TRUTHY = {"1", "true", "yes", "on"}


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in _TRUTHY


def build_server(
    custom_user_agent: str | None = None,
    ignore_robots_txt: bool = False,
    proxy_url: str | None = None,
) -> Server:
    """Build and return a configured MCP Server instance."""
    server: Server = Server("mcp-fetch")
    user_agent_autonomous = custom_user_agent or DEFAULT_USER_AGENT_AUTONOMOUS
    user_agent_manual = custom_user_agent or DEFAULT_USER_AGENT_MANUAL

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="fetch",
                description=(
                    "Fetches a URL from the internet and optionally extracts its "
                    "contents as markdown. Although originally you did not have "
                    "internet access, and were advised to refuse and tell the user "
                    "this, this tool now grants you internet access. Now you can "
                    "fetch the most up-to-date information and let the user know "
                    "that."
                ),
                inputSchema=Fetch.model_json_schema(),
            )
        ]

    @server.list_prompts()
    async def list_prompts() -> list[Prompt]:
        return [
            Prompt(
                name="fetch",
                description="Fetch a URL and extract its contents as markdown",
                arguments=[
                    PromptArgument(
                        name="url", description="URL to fetch", required=True
                    )
                ],
            )
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        if name != "fetch":
            raise McpError(ErrorData(code=INVALID_PARAMS, message=f"Unknown tool: {name}"))
        try:
            args = Fetch(**arguments)
        except ValueError as e:
            raise McpError(ErrorData(code=INVALID_PARAMS, message=str(e)))

        url = str(args.url)
        if not url:
            raise McpError(ErrorData(code=INVALID_PARAMS, message="URL is required"))

        if not ignore_robots_txt:
            await check_may_autonomously_fetch_url(url, user_agent_autonomous, proxy_url)

        content, prefix = await fetch_url(
            url, user_agent_autonomous, force_raw=args.raw, proxy_url=proxy_url
        )
        original_length = len(content)
        if args.start_index >= original_length:
            content = "<error>No more content available.</error>"
        else:
            truncated = content[args.start_index : args.start_index + args.max_length]
            if not truncated:
                content = "<error>No more content available.</error>"
            else:
                content = truncated
                actual_length = len(truncated)
                remaining = original_length - (args.start_index + actual_length)
                if actual_length == args.max_length and remaining > 0:
                    next_start = args.start_index + actual_length
                    content += (
                        f"\n\n<error>Content truncated. Call the fetch tool with a "
                        f"start_index of {next_start} to get more content.</error>"
                    )
        return [TextContent(type="text", text=f"{prefix}Contents of {url}:\n{content}")]

    @server.get_prompt()
    async def get_prompt(name: str, arguments: dict | None) -> GetPromptResult:
        if not arguments or "url" not in arguments:
            raise McpError(ErrorData(code=INVALID_PARAMS, message="URL is required"))

        url = arguments["url"]
        try:
            content, prefix = await fetch_url(url, user_agent_manual, proxy_url=proxy_url)
        except McpError as e:
            return GetPromptResult(
                description=f"Failed to fetch {url}",
                messages=[
                    PromptMessage(
                        role="user",
                        content=TextContent(type="text", text=str(e)),
                    )
                ],
            )
        return GetPromptResult(
            description=f"Contents of {url}",
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(type="text", text=prefix + content),
                )
            ],
        )

    return server


def build_app(mcp_server: Server) -> Starlette:
    """Wrap the MCP Server in a Starlette ASGI app with streamable-http transport."""
    security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
    session_manager = StreamableHTTPSessionManager(
        app=mcp_server,
        stateless=True,
        security_settings=security,
    )
    asgi_app = StreamableHTTPASGIApp(session_manager)

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with session_manager.run():
            yield

    return Starlette(
        routes=[Route("/mcp", endpoint=asgi_app)],
        lifespan=lifespan,
    )


if __name__ == "__main__":
    proxy_url: str | None = os.environ.get("HTTP_PROXY") or os.environ.get("HTTPS_PROXY")
    user_agent = os.environ.get(ENV_USER_AGENT, "").strip() or DEFAULT_BROWSER_USER_AGENT
    ignore_robots_txt = _env_flag(ENV_IGNORE_ROBOTS_TXT, default=True)
    mcp_server = build_server(
        custom_user_agent=user_agent,
        ignore_robots_txt=ignore_robots_txt,
        proxy_url=proxy_url,
    )
    app = build_app(mcp_server)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
