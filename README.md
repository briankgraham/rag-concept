# Simple RAG Chat

A Retrieval-Augmented Generation (RAG) app for answering questions about internal company documentation — general policy questions are answered from markdown docs, and personal questions (like "how many PTO days do I have left") are answered from a per-employee HR data lookup, behind SSO login.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the codebase's conventions and concrete recipes (adding a tool, a route, a migration, swapping a mock integration for the real thing).

## What It Does

Ask natural language questions about company policies, benefits, procedures, and more. General questions search through markdown documents and generate answers from the relevant content found. Personal questions about your own PTO balance are answered directly from HR data (ADP) for your logged-in identity — this is a structured lookup, not a document search, since no document contains individual employee data.

## Architecture

### Web app (`src/server.ts`) — production entrypoint

- **Auth** (`src/auth/`): Okta SSO (OIDC) login. `OktaClient` is an interface with a mock implementation (`okta-client.mock.ts`) standing in for a real Okta tenant — see [Mock mode](#mock-mode) below. Sessions are stored in Postgres (`users`, `sessions` tables), identified by an `HttpOnly` cookie holding a random token (only its hash is stored in the DB).
- **HR / PTO data** (`src/hr/`): `AdpClient` is an interface with a mock implementation (`adp-client.mock.ts`) standing in for ADP's real API. Balances are cached in Postgres (`pto_cache`) with a TTL so a chat question doesn't hit ADP every time.
- **RAG pipeline** (`src/rag/`): `EmbeddingsService` (chunking, embedding, and cosine-similarity search via Postgres/pgvector — see `doc_sources`/`doc_chunks` in `src/db/migrations/004_create_rag_tables.sql`) and `RagService` (query proposal → multi-search → context assembly, plus a single-shot `answerFromDocs` used by the CLI). Source markdown still lives on local disk (`data/company-data/`); only the chunk/embedding storage and search live in Postgres.
- **Orchestrator** (`src/orchestrator/`): every `POST /api/chat` question goes through an LLM tool-calling agent loop, not a hand-written if/else. The model itself decides — from each tool's name, description, and JSON-schema parameters — whether the question needs the `get_pto_balance` tool (the user's own HR data), the `search_company_docs` tool (vector search over the docs corpus), both, or neither, then produces the final answer once it has what it needs.
  - `orchestrator.ts` — the request/tool-call/response loop (capped at a few turns), shared by every question type.
  - `tools/*.tool.ts` — one file per capability: a JSON schema advertised to the model, a Zod schema that validates the model's arguments before they're used, and an `execute()` that does the actual work. **Adding a new capability (a paystub lookup, benefits enrollment, an IT ticket tool, …) means adding one file here and one line in `tools/index.ts` — no changes to the orchestrator, the system prompt, or `chat.service.ts`.**
  - A tool can return a `preferredAnswer` string (see `get-pto-balance.tool.ts`) that the model is instructed to relay verbatim rather than paraphrase, so an exact figure like a PTO balance can't drift when the model writes the final sentence.
- **Chat composition** (`src/chat/chat.service.ts`): calls the orchestrator and labels the response (`pto_lookup` / `rag` / `direct`) from which tool(s) actually ran, for logging/analytics.
- **Conversation history** (`src/chat/conversation.repo.ts`): each user has a single ongoing conversation, persisted in Postgres (`conversation_messages`, see `src/db/migrations/006_create_conversation_messages.sql`) and capped at `config.maxConversationMessages` (default 20 rows / 10 exchanges — older turns are pruned on every append). `chat.service.ts` loads it before calling the orchestrator and appends the new turn after, so a follow-up question (e.g. answering a clarifying question the model itself asked) has the prior exchange as context. `DELETE /api/chat` clears it so a user can start over.

### CLI (`src/cli/rag-cli.ts`) — dev tool

Kept for local content iteration. Shares the RAG pipeline with the web app but has no login/session concept, so it can only answer general docs questions, never personal PTO questions. Since the RAG pipeline's embeddings live in Postgres, the CLI needs a reachable `DATABASE_URL` too (see [Local Postgres](#local-postgres) below) — it is no longer Postgres-free.

### Company Data (`data/company-data/`)

Sample knowledge base of 20 markdown documents covering policies, procedures, and company information.

## Local Postgres

The web app, the CLI, the eval script, and most of the test suite all need a reachable Postgres with the `pgvector` extension available (for the `doc_sources`/`doc_chunks` embeddings tables — see `src/db/migrations/004_create_rag_tables.sql`). The recommended way to get one locally is `docker-compose.yml`, which runs the `pgvector/pgvector` image and matches `.env.example`'s default `DATABASE_URL` with no further setup:

```bash
docker compose up -d
```

If you'd rather use a Postgres you already run yourself, make sure the `vector` extension is installed for it (e.g. `brew install pgvector` on macOS) — `CREATE EXTENSION IF NOT EXISTS vector` (run automatically by `npm run migrate`) still requires the extension files to be present on disk.

## Run everything with Docker Compose

`docker-compose.yml` can also boot the whole stack — Postgres, the API
server, and the web UI — in one command, with no local `npm install`
needed:

```bash
cp .env.example .env
# edit .env: set OPENAI_API_KEY

docker compose up --build
```

This runs migrations automatically before the API starts (safe to
re-run — see `src/db/migrate.ts`), and both services hot reload: the
`web` container runs Vite's dev server (edits under `web/src` apply
immediately), and the `backend` container runs `tsx watch` (edits
under `src/` restart the server automatically) — no rebuild needed for
either. Once everything is up:

- Web UI: `http://localhost:5173`
- API directly: `http://localhost:3000` (see the `curl` examples below)

`docker compose down` stops everything; add `-v` to also drop the
Postgres data volume.

## Quick Start — Web App

The above is the fastest way to get everything running. This section
runs the API server directly on the host instead — useful for
debugging or when you don't want the backend containerized:

```bash
npm install
cp .env.example .env
# edit .env: set OPENAI_API_KEY, and DATABASE_URL if not using the default

docker compose up -d   # local Postgres + pgvector — see "Local Postgres" above
npm run build
npm run migrate   # applies src/db/migrations/*.sql to Postgres
npm run server
```

Then open `http://localhost:3000/auth/login` in a browser. In mock mode (the default — see below) this shows a "pick a user" page instead of a real Okta login; choosing one logs you in and sets a session cookie.

```bash
curl -b cookie.txt -c cookie.txt http://localhost:3000/api/me

curl -b cookie.txt -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"question": "how many PTO days do I have left"}'
# {"answer":"You have 10 days of PTO left (accrued 20, used 10, as of 2026-...).","source":"pto_lookup"}

curl -b cookie.txt -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"question": "what is the remote work policy"}'
# {"answer":"...","source":"rag"}
```

### Mock mode

There is no live Okta tenant or ADP API access yet, so both integrations run as mocks by default (`OKTA_MOCK=true`, `ADP_MOCK=true` in `.env.example`). Each is defined as an interface (`OktaClient`, `AdpClient`) with a mock implementation used today and a `*.real.ts` stub to fill in later — swapping to the real implementation should require no changes anywhere else in the app.

## Quick Start — CLI

```bash
npm install
export OPENAI_API_KEY="sk-..."
docker compose up -d   # local Postgres + pgvector — see "Local Postgres" above
npm run build
npm run migrate
npm start
```

If the API key is not set, the CLI will prompt for it interactively.

```
$ npm start

Hey, I'm your company docs assistant! Ask me about policies, benefits, or procedures.

> how many vacation days do I get
Employees receive 20 days of PTO per year, plus holidays.

> what's the 401k match
4% match with immediate vesting.

> exit
```

### Add a New Document

```bash
npx rag --add-file /path/to/document.md
```

### Rebuild Cache

Force rebuild of the embeddings cache:

```bash
npx rag train
```

### Debug Mode

See LLM requests/responses and search progress:

```bash
npx rag --debug
```

## Testing

```bash
npm test              # run the suite once
npm run test:coverage # run it with coverage enforced at 100% (lines/branches/functions/statements)
npm run eval:tools    # live tool-selection eval against the real OpenAI API (needs OPENAI_API_KEY and a reachable DB)
```

Requires a local Postgres with pgvector reachable at `DATABASE_URL` (default matches `docker compose up -d` — see [Local Postgres](#local-postgres) above) with migrations applied (`npm run migrate`) — most of the suite mocks its dependencies (OpenAI, Okta, ADP), but the auth/session/PTO-cache/embeddings tests intentionally exercise the real database rather than a fake, including full login-flow tests against real HTTP servers on ephemeral ports.

Coverage is enforced, not aspirational — see [CONTRIBUTING.md](./CONTRIBUTING.md#testing--coverage) for exactly what's excluded (bootstrap/entrypoint scripts and type-only files) and why, plus two non-obvious gotchas in the `c8` config if you need to touch it. `coverage/` is gitignored.

The eval script (`src/eval/tool-selection-eval.ts`) is a different thing entirely from the unit tests: it sends real questions to the live model and checks which tool it actually calls, since a scripted-fake-response test can prove the orchestrator's _mechanics_ but never whether the real model _chooses_ correctly for real phrasings.

## Requirements

- Node.js 22+ (required by the `pgvector` package)
- OpenAI API key with access to:
  - `text-embedding-3-small` model
  - `gpt-5` model
- PostgreSQL with the `pgvector` extension (see [Local Postgres](#local-postgres) above) — needed by the web app, the CLI, and most of the test suite

## Configuration

See `.env.example` for all environment variables. Key constants:

- `CHUNK_SIZE`: 400 characters per chunk (in `src/rag/embeddings.service.ts`)
- Embedding model: `text-embedding-3-small`
- Chat model: `gpt-5`
