FROM oven/bun:1.3.13-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts components.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.13-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY src/shared ./src/shared

RUN mkdir -p /data/uploads && chown -R bun:bun /data /app
USER bun

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'const response = await fetch("http://127.0.0.1:3000/healthz"); if (!response.ok) process.exit(1)'

CMD ["bun", "src/server/index.ts"]
