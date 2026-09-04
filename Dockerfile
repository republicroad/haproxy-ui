FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
RUN groupadd --gid 1001 nodejs && useradd --uid 1001 --gid nodejs --shell /bin/sh --create-home appuser
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
USER appuser
EXPOSE 3000
ENV HAPROXY_UI_DB=/app/data/haproxy-ui.db
VOLUME /app/data
CMD ["node", "dist/server/server.js"]
