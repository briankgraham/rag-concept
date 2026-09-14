# Backend API (src/server.ts) — see docker-compose.yml for how this is
# wired up alongside Postgres and the web UI.
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---
# Dev target: hot reload via `nodemon` (polling mode) + `tsx`. Plain fs
# events (inotify) don't reliably propagate through Docker bind mounts on
# every host/filesystem combination, so the dev script uses nodemon's
# `--legacy-watch` polling instead of tsx's own native-fs-event watch mode
# — see package.json's `dev` script. docker-compose.yml builds the
# `backend` service with `target: dev` and bind-mounts src/ and data/ over
# what's COPY'd here, so this stage's own copies only matter for a plain
# `docker build --target dev` with no mount. Keeps devDependencies (tsx
# and nodemon included) instead of the `--omit=dev` install the production
# stage below uses.
FROM deps AS dev
WORKDIR /app
ENV NODE_ENV=development

COPY tsconfig.json ./
COPY src ./src
COPY data ./data

EXPOSE 3000

# Same idempotent migrate-then-start shape as the production CMD below, via
# the equivalent npm scripts (tsx instead of compiled dist/) — see
# package.json's migrate:dev/dev scripts.
CMD ["sh", "-c", "npm run migrate:dev && npm run dev"]

# ---

FROM deps AS builder
WORKDIR /app

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=""

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# migrate.ts resolves its migrations dir relative to cwd (src/db/migrations),
# not dist/ — the .sql files themselves are data, not compiled, so they need
# to ship alongside the compiled runner rather than through tsc.
COPY src/db/migrations ./src/db/migrations
# RAG source docs, also resolved relative to cwd (server.ts/rag-cli.ts) —
# without these the embeddings cache reports every file as "no longer on
# disk" and rebuildCache() has nothing to read.
COPY data ./data

EXPOSE 3000

# Apply any pending migrations, then start the server. migrate.js is
# idempotent (tracks applied filenames in schema_migrations), so this is
# safe to re-run on every container start.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
