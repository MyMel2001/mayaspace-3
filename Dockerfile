# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# MayaSpace — Node ≥ 22, Temporal behind --harmony-temporal, tsx loader.
# Storage is embedded SQLite (better-sqlite3) + file uploads, so the image
# needs no external database — only a persistent volume mounted at /app/data.
# ─────────────────────────────────────────────────────────────────────────────

# ── deps: install production dependencies ───────────────────────────────────
# (tsx is a regular dependency, so it survives --omit=dev. Build tools are
#  only needed if a native module has no musl prebuild for this platform.)
FROM 24.20-trixie-slim AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm i

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

RUN addgroup -S maya && adduser -S maya -G maya

COPY --from=deps --chown=maya:maya /app/node_modules ./node_modules
COPY --chown=maya:maya package.json tsconfig.json ./
COPY --chown=maya:maya src ./src
COPY --chown=maya:maya views ./views
COPY --chown=maya:maya public ./public

RUN mkdir -p data logs && chown -R maya:maya data logs

USER maya
EXPOSE 3414

# Health endpoint is served at /healthz (see src/web/routes/home.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Same runtime command as `npm start`.
CMD ["node", "--harmony-temporal", "--import", "tsx", "src/index.ts"]
