FROM oven/bun:1.3.11-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV DANGEROUS_DOMAINS_BUNDLED=/app/src/dangerous-domains.txt
ENV PORT=8090
USER bun
CMD ["bun", "run", "src/server.ts"]
