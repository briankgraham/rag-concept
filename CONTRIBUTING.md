# Contributing

## Layout

```
src/
  server.ts        # composition root: constructs every service/integration once, wires routers
  config.ts        # env var loading (all config reads go through here, nowhere else)

  db/              # Postgres pool + hand-rolled migration runner (no ORM — see README)
  auth/            # Okta SSO: interface + mock/real implementations, sessions, routes
  hr/              # ADP integration: interface + mock/real implementations, PtoService (cache)
  rag/             # embeddings, chunking, docs search/answer pipeline (used by CLI + search_company_docs tool)
  orchestrator/    # the tool-calling agent loop + the tool registry
  chat/            # ties the orchestrator to an authenticated HTTP request
  middleware/      # Koa cross-cutting concerns (errors, logging)
  cli/             # dev tool, shares src/rag/* with the web app

  __tests__/       # Node built-in test runner; test-helpers.ts holds shared fakes
```

## The rules that keep this codebase easy to extend

**1. Every dependency is injected, nothing is a module-level singleton reached for from inside logic.**

`src/server.ts` is the _only_ place that decides "mock or real" and constructs services (`RagService`, `PtoService`, `OktaClient`). Routers are factories that take their dependencies as one options object (`createChatRouter({ openai, ragService, ptoService, debug })`, `createAuthRouter({ oktaClient })`) — they don't import a singleton. Tools receive everything through `ToolContext` (`src/orchestrator/types.ts`). This is what makes each layer testable with a plain fake object instead of a live database or API — see `src/__tests__/orchestrator.test.ts`, which never touches Postgres or OpenAI's real API.

If you add a new external integration (a paystub API, a benefits system, whatever), follow the existing shape:

- `foo-client.interface.ts` — the abstraction
- `foo-client.mock.ts` — a working fake, used by default until real credentials exist
- `foo-client.real.ts` — a stub that throws until it's actually implemented
- Construct the real-or-mock choice in `server.ts` based on a `config.fooMock` flag (see `config.ts`), not inside the service itself.

The one deliberate exception is the Postgres pool (`src/db/pool.ts`'s `query()` helper): `session.ts`, `users.repo.ts`, and `pto.service.ts` import and call it directly rather than receiving it via constructor injection. There's no mock/real split for the database the way there is for Okta/ADP, and `config.ts` is treated as an accepted global the same way — so this isn't a gap, but it does mean those files need a real local Postgres to test (see [Testing & coverage](#testing--coverage) below), not a fake. `EmbeddingsService` (`src/rag/embeddings.service.ts`) is the odd one out here: it takes a `pg.Pool` via constructor injection, like the Okta/ADP services, rather than importing `db/pool.ts` directly — a deliberate departure from this exception, not an oversight.

**2. Errors are `HttpError`s, never a hand-rolled `ctx.status = ...; ctx.body = ...`.**

`src/middleware/error-handler.ts` catches everything and shapes the JSON response. Throw `new HttpError(status, code, message)` from anywhere downstream (a route, a service) and it's handled consistently. Don't set `ctx.status`/`ctx.body` for an error case directly in a route — that was a real inconsistency this codebase had (see `auth.routes.ts`'s `/auth/callback` before it was fixed) and it's easy to reintroduce without noticing.

**3. Adding a new orchestrator capability is "write one file," not "add a branch."**

See [Adding a tool](#adding-a-tool) below. If you catch yourself writing an `if (question.includes(...))` anywhere in `src/chat/` or `src/orchestrator/`, that's a sign the logic belongs in a tool's `description` instead — the model decides intent from tool schemas, not from string matching in application code.

**4. Lint and format are enforced, not advisory.**

`npm run lint` runs typed ESLint (`@typescript-eslint/no-floating-promises` and friends are real errors, not warnings) — an unhandled rejection in a route handler or a tool is exactly the bug class this catches. `npm run format` runs Prettier. Run both before opening a PR; CI (once set up) should gate on both.

## Testing & coverage

`npm test` runs the full suite once; `npm run test:coverage` runs it under `c8` and enforces **100% lines/branches/functions/statements** (`.c8rc.json`) — the build fails if it drops below that. Both need a **local Postgres with pgvector reachable** at `DATABASE_URL` (default matches `docker compose up -d`, see README's [Local Postgres](./README.md#local-postgres)) with migrations applied (`npm run migrate`) — most of the suite mocks its dependencies, but the DB-touching files (`session.ts`, `users.repo.ts`, `pto.service.ts`, `db/pool.ts`, `embeddings.service.ts`, and the router tests that exercise a real login flow) intentionally run against the real thing rather than a fake, per the DB exception noted above. `coverage/` is gitignored — it's a generated report, not something to commit.

**Excluded from the 100% requirement** (see `.c8rc.json`'s `exclude`, and the reasoning stays here since JSON can't hold comments):

- `server.ts`, `cli/rag-cli.ts`, `db/migrate.ts`, `eval/tool-selection-eval.ts` — bootstrap/entrypoint scripts (process startup, `readline`, `process.exit`). These are verified by the manual smoke test (README) and the live eval (`npm run eval:tools`), not unit tests — mocking a process entrypoint down to 100% branch coverage buys nothing real.
- `*.interface.ts` files and `orchestrator/types.ts` — pure type declarations with no runtime code to execute.

Two non-obvious things about the `c8` config, if you're touching it:

- `include`/`exclude` glob patterns must target the **compiled `dist/**/*.js`** paths, not the `.ts` source — c8 filters by the executed file's runtime URL _before_ applying source maps, so a `.ts`-shaped glob silently matches nothing (this cost real debugging time to find).
- `"all": true` (so an entirely untested new file shows up as 0% instead of silently not appearing in the report at all) requires `"src": "dist"` alongside the compiled-path globs above — same root cause.

When adding a new source file, expect the coverage gate to fail until it has a test — that's the point. If it's a legitimate new entrypoint/bootstrap script, add it to `.c8rc.json`'s `exclude` and explain why here, not just in a commit message.

## Recipes

### Adding a tool

1. Create `src/orchestrator/tools/my-thing.tool.ts` exporting a `ToolDefinition` (see `get-pto-balance.tool.ts` for a no-args example, `search-company-docs.tool.ts` for one with parameters):
   - `name` / `description` — the description is what the model uses to decide _when_ to call this tool, so be explicit about what it's for and what it's NOT for (compare how `search_company_docs`'s description explicitly excludes personal data).
   - `parameters` — the JSON Schema advertised to OpenAI.
   - `argsSchema` — a Zod schema validating the model's raw arguments before `execute()` sees them.
   - `execute(args, ctx)` — do the work using `ctx` (never a module-level singleton), return `{ content, preferredAnswer? }`. Set `preferredAnswer` when the result contains an exact number/fact that must survive into the final answer unchanged (the orchestrator's system prompt tells the model to relay it verbatim).
2. Add it to the array in `src/orchestrator/tools/index.ts`.
3. If it needs a new dependency (a new API client, a new service), add it to `ToolContext` (`src/orchestrator/types.ts`) and construct/inject it in `src/server.ts` — never import it directly inside the tool file.
4. Write a test in `src/__tests__/` using `scriptedOpenAI`/`fakeToolContext` from `test-helpers.ts` to verify the orchestrator dispatches to your tool correctly with a scripted model response, and add a case (or two — a clear one and an adversarial one) to `src/eval/tool-selection-eval.ts`. The unit test proves the _mechanics_ (if the model calls your tool, it dispatches correctly); the eval proves the live model actually _chooses_ to call it for real phrasings — these are not substitutes for each other. See `npm run eval:tools` in the README.

### Adding an HTTP route

Add it inside the relevant router factory (or create a new one following the same shape) — a function taking a deps object and returning a `Router`, constructed once in `server.ts`. Throw `HttpError` for anything that isn't a 200.

### Adding a DB table

Add a new numbered file in `src/db/migrations/` (`00N_description.sql`), run `npm run migrate`. See `src/db/migrate.ts` for how the runner tracks what's applied.

### Swapping a mock integration for the real thing

Implement `*.real.ts` for real (it currently throws), then flip the corresponding `config.ts` flag (`OKTA_MOCK` / `ADP_MOCK`) to `false` via env var. Nothing else should need to change — if it does, that's a sign the interface leaked an implementation detail somewhere.
