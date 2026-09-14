# Notes for Claude

See README.md and CONTRIBUTING.md first — they're the source of truth for
architecture, conventions, and recipes. This file only holds things not
yet written down there: open backlog items and one environment gotcha.

## Retrieval quality / reranking (items 1-2 done, 3-5 still open design discussion)

**Current state**: `RagService` (`src/rag/rag.service.ts`) asks the LLM
for 2-4 candidate search queries (`proposeSearchQueries`), then
`EmbeddingsService.multiSearch()` (`src/rag/embeddings.service.ts`)
embeds each query and, per query string, runs both a pgvector
nearest-neighbor query (`ORDER BY embedding <=> $1 LIMIT k*2`) and a
Postgres full-text query (`keywordSearch()`, `ts_rank`/`plainto_tsquery`
over the `content_tsv` generated column added in
`005_add_doc_chunks_fts.sql`), fuses the two ranked lists with Reciprocal
Rank Fusion (`fuseRankings()`, RRF constant 60, untuned) down to `k=3`,
then dedupes by chunk id across queries and hands whatever survives
straight to `buildContext()` with no further scoring. There is still no
cross-encoder/rerank step and no MMR/diversity pass. Chunking
(`chunkText()`) first splits each file into sections on
markdown ATX headers (`splitIntoSections()` — a header stays attached to
the content under it, and to a table's header row, instead of an earlier
purely-positional cut landing between them); a section that still exceeds
`CHUNK_SIZE = 400` tokens (cl100k_base, via
`gpt-tokenizer/encoding/cl100k_base`) is then split into overlapping
token windows (`OVERLAP_TOKENS`, ~15% of `CHUNK_SIZE`) so a fact near a
window boundary still appears whole in at least one chunk. Changing
`chunkText()`'s behavior requires bumping `CHUNKER_VERSION` (folded into
`hashContent()`) so `rebuildCache()` re-chunks every file even though
their on-disk content hasn't changed.

**Gap**: `src/eval/retrieval-eval.ts` (`npm run eval:retrieval`) now covers
this — 16 question -> expected-source cases across boundary/
exact-term/paraphrase/general failure modes, checking whether the
relevant *source document* makes it into the deduped chunk set
`buildContext()` sees (not which tool gets picked — that's
`eval:tools`/`tool-selection-eval.ts`). Note this checks source-level
recall, not chunk-level: a doc can still "pass" via a different chunk than
the one carrying the specific fact a case targets, so a passing eval run
doesn't by itself prove a boundary bug is fixed — read chunk content
directly (as the chunking unit tests in `embeddings-service.test.ts` do)
to confirm that.

**Options discussed** (roughly effort-to-payoff order):

1. **Fix chunking first** (done) — ~15% overlap between adjacent chunks,
   and markdown-header-aware section splitting, both in `chunkText()`/
   `splitIntoSections()` above. Was higher-leverage than reranking at this
   corpus size (20 files, 42+ chunks) since the old chunker could orphan a
   fact from its context with no later retrieval-time fix able to recover
   it.
2. **Hybrid search (dense + keyword) via Postgres full-text search**
   (done) — a `content_tsv` generated column + GIN index on `doc_chunks`
   (`005_add_doc_chunks_fts.sql`), `EmbeddingsService.keywordSearch()`
   running `ts_rank`/`plainto_tsquery` alongside the existing `<=>` cosine
   query, fused via `fuseRankings()` (Reciprocal Rank Fusion) inside
   `multiSearch()`. No new external dependency. `npm run eval:retrieval`
   stayed 12/12 (2/2 exact-term) after landing this — a useful regression
   guard, not proof the RRF weighting is well-tuned (see deferred
   follow-ups below).
3. **"Contextual retrieval"** — before embedding, prepend a short
   LLM-generated blurb to each chunk describing what document/section it's
   from, so a chunk like "$250/month with itemized receipts" isn't
   semantically orphaned from "coworking reimbursement." One extra cheap
   LLM call per chunk at index time (`EmbeddingsService.upsertSource()`),
   not at query time.
4. **Cross-encoder / rerank API** — widen initial retrieval (e.g. k=10),
   score each (question, chunk) pair jointly (Cohere Rerank, or a small
   local cross-encoder), trim back to top 3-5 before `buildContext()`. More
   accurate than bi-encoder cosine similarity since it lets the two texts
   attend to each other, but adds a network call + latency per question.
5. **Cap total context size** — not a ranking fix, but related:
   `multiSearch(queries, 3)` with up to 4 proposed queries means up to ~12
   deduped chunks can go into context uncapped today. Fine at current
   scale; a reranking step is a natural place to also enforce a hard cap.
   More natural still now that hybrid search's `k*2` candidate pool per
   query widens what feeds into fusion.

**Deferred from the hybrid search change (item 2)** — shipped small
deliberately; these were left for a follow-up session rather than done
alongside it:

- ~~Tuning the RRF constant and candidate pool size against
  `eval:retrieval` results~~ — done: swept `RRF_CONSTANT` ∈ {10, 30, 60,
  100} and the candidate pool multiplier ∈ {2, 3, 4} against the 12-case
  suite (sequentially, not cross-producted). Every combination scored
  12/12 with no case-level differences in retrieved sources either — kept
  both at their original defaults (`RRF_CONSTANT = 60`,
  `CANDIDATE_POOL_MULTIPLIER = 2`, now promoted to named module-level
  consts in `embeddings.service.ts` with the sweep numbers in their doc
  comment) since neither knob showed any measurable effect at this
  corpus/eval size, rather than picking an unsupported "tuned" value. This
  is a validated no-op, not evidence the fusion is well-tuned in general —
  the 12-case eval (2 exact-term cases) is too coarse to discriminate
  further; revisit once the next bullet below grows that signal.
- ~~Adding more `exact-term` cases to `retrieval-eval.ts`'s `CASES`~~ —
  done: added 4 cases (pnpm monorepo choice in `09_engineering_adr_001.md`,
  the CVSS≥9/24h patch SLA in `03_security_policy.md`, the `/healthz` vs
  `/status` health-check mismatch in `20_postmortem_2023-08-17_outage.md`,
  and the Q1 `<12h` CVE-patch OKR in `06_okrs_q1_2025.md` — the last two
  deliberately close to each other/the security-policy SLA to probe
  disambiguation), bringing exact-term from 2 to 6 cases. Full suite now
  16/16 (6/6 exact-term) on `npm run eval:retrieval`.
- A latency check on `multiSearch()`, which now runs 2x the SQL queries
  per proposed query string (dense + keyword, concurrently via
  `Promise.all`).

## Other known follow-ups (flagged in a code review, deliberately not fixed)

- **`PtoBalance.remaining` is redundant** (`src/hr/adp-client.interface.ts`)
  — always `accrued - used`, but removing it means a migration dropping
  `pto_cache.remaining` plus touching the mock/real client interface and
  `src/hr/format.ts`. Worth doing, but as its own reviewed change, not a
  drive-by fix.
- **`server.ts` blocks startup on `embeddingsService.initialize()`** — a
  deliberate tradeoff (no request is served before embeddings are ready,
  avoiding a race), not a bug. Worth reconsidering only if cold-start time
  ever becomes a problem.

## Local dev gotcha: port 5432 conflicts

If a request to the local `docker compose up -d` Postgres unexpectedly
lands somewhere unexpected (e.g. `npm run migrate` fails with "extension
\"vector\" is not available" pointing at a Homebrew Postgres path instead
of the container), check for another Postgres already bound to port 5432:

```bash
lsof -iTCP:5432 -sTCP:LISTEN
```

A pre-existing local service (e.g. `brew services list | grep postgres`
showing `postgresql@16` started) can silently win `localhost` connections
over Docker's port-forwarding proxy. Stop it
(`brew services stop postgresql@16`) rather than assuming the compose
Postgres itself is broken — it usually isn't.
