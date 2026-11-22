# syntax=docker/dockerfile:1.7
# Renovate pins these base images by digest.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm prisma generate && pnpm build

# Prisma CLI, same version as the app, in its own folder for the migration init container.
FROM base AS migrator
COPY --from=deps /app/node_modules/prisma/package.json /tmp/prisma-package.json
RUN npm install --prefix /migrator --omit=dev --no-audit --no-fund \
      "prisma@$(node -p "require('/tmp/prisma-package.json').version")"

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=migrator --chown=app:app /migrator /app/migrator
USER app
# 3000: the app. 3001: websocket relay for VM consoles (see README).
EXPOSE 3000 3001
# App: default. Migrations (init container):
#   node migrator/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
CMD ["node", "server.js"]
