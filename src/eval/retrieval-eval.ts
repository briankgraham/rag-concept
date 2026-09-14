#!/usr/bin/env node
/*
 * Retrieval-quality eval: checks whether the *right chunks* make it into
 * the context the model sees, not just which tool gets picked (that's
 * tool-selection-eval.ts). Runs the real RAG pipeline end-to-end —
 * RagService.proposeSearchQueries() -> EmbeddingsService.multiSearch(),
 * same as RagService.answerFromDocs()/searchDocs() in production — against
 * real OpenAI embeddings and a real Postgres/pgvector doc_chunks table.
 *
 * A case passes if its expected source document appears anywhere among the
 * deduped chunks multiSearch() returns (i.e. whatever buildContext() would
 * actually see), not some stricter top-N — that matches what the pipeline
 * hands to the answering LLM today.
 *
 * Cases are deliberately built around three failure modes called out in
 * CLAUDE.md's retrieval-quality backlog item, rather than just sampling
 * docs at random:
 *   - "boundary": a fact that the naive 400-char/no-overlap chunker
 *     actually splits (verified below against the real file content, not
 *     guessed) — checks whether chunking is orphaning facts from context.
 *   - "exact-term": an exact code/number/hex value a pure embedding search
 *     can miss even when it's semantically on-topic — checks whether
 *     hybrid/keyword search would help.
 *   - "paraphrase": a question that deliberately avoids the source
 *     document's own wording — checks basic semantic recall.
 *   - "general": one straightforward question per remaining source doc,
 *     for broad sanity coverage.
 *
 * Needs OPENAI_API_KEY, plus a reachable Postgres (DATABASE_URL, migrations
 * applied) — same preconditions as eval:tools.
 */
import path from 'path';
import OpenAI from 'openai';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { EmbeddingsService } from '../rag/embeddings.service.js';
import { RagService } from '../rag/rag.service.js';

const DOCS_DIR = path.resolve('data', 'company-data');

type FailureMode = 'boundary' | 'exact-term' | 'paraphrase' | 'general';

interface Case {
  question: string;
  expectedSource: string;
  mode: FailureMode;
  note?: string;
}

const CASES: Case[] = [
  // --- boundary: facts the 400-char/no-overlap chunker actually splits ---
  {
    question: "What's the target failure rate for simulated phishing campaigns?",
    expectedSource: 'data/company-data/08_user_security_guide.md',
    mode: 'boundary',
    note: 'the word "phishing" itself is split across the chunk boundary ("...phi" | "shing...campaigns..."), separating the "## Phishing Drills" header from the "<3% clicks" target'
  },
  {
    question: 'What handling is required for confidential data like source code?',
    expectedSource: 'data/company-data/03_security_policy.md',
    mode: 'boundary',
    note: 'the Confidential row ("Source code, customer data | Require VPN + SSO") falls entirely in the second chunk, stripped of the "| Level | Examples | Handling |" table header in the first'
  },

  // --- exact-term: exact codes/values a pure embedding match can miss ---
  {
    question: "What's the response SLA for a P1 IT support ticket?",
    expectedSource: 'data/company-data/14_it_support_runbook.md',
    mode: 'exact-term',
    note: 'exact ticket-priority code "P1"'
  },
  {
    question: "What's the hex code for Acme Red in the brand color palette?",
    expectedSource: 'data/company-data/19_marketing_style_guide.md',
    mode: 'exact-term',
    note: 'exact hex value "#E63946"'
  },
  {
    question: 'Which package manager did engineering decide on for the JS monorepo migration?',
    expectedSource: 'data/company-data/09_engineering_adr_001.md',
    mode: 'exact-term',
    note: 'exact tool name "pnpm" buried in prose; doc not otherwise covered by any existing case'
  },
  {
    question: 'How quickly do we have to fix a vulnerability that scores a 9 or higher in severity?',
    expectedSource: 'data/company-data/03_security_policy.md',
    mode: 'exact-term',
    note: 'exact threshold "CVSS ≥ 9 → 24 h"; same doc as the "confidential data handling" boundary case above but a different fact, and deliberately close to the Q1 OKR case below to test whether retrieval confuses the two docs'
  },
  {
    question: "What URL path was the load balancer checking that didn't match what the app actually served during the August 2023 outage?",
    expectedSource: 'data/company-data/20_postmortem_2023-08-17_outage.md',
    mode: 'exact-term',
    note: 'exact literal paths "/healthz" vs "/status"'
  },
  {
    question: "What's this quarter's target for how fast we patch critical CVEs?",
    expectedSource: 'data/company-data/06_okrs_q1_2025.md',
    mode: 'exact-term',
    note: 'exact value "<12 hours"; deliberately close to (but distinct from) the 24h CVSS SLA in 03_security_policy.md above'
  },

  // --- paraphrase: avoids the source doc's own wording ---
  {
    question: "Does the company help pay for a desk at a shared workspace when I'm not working from home?",
    expectedSource: 'data/company-data/07_remote_work_policy.md',
    mode: 'paraphrase',
    note: 'avoids "coworking reimbursement" wording from the doc'
  },
  {
    question: 'How is pay benchmarked against the outside market?',
    expectedSource: 'data/company-data/16_compensation_philosophy.md',
    mode: 'paraphrase',
    note: 'avoids "75th percentile of market data" wording from the doc'
  },

  // --- general: one straightforward question per remaining doc ---
  {
    question: 'Who is the CTO of Acme Corp?',
    expectedSource: 'data/company-data/02_company_roster.md',
    mode: 'general'
  },
  {
    question: 'When is payday?',
    expectedSource: 'data/company-data/12_payroll_faq.md',
    mode: 'general'
  },
  {
    question: "What's the daily meal allowance for business travel in the US?",
    expectedSource: 'data/company-data/13_travel_policy.md',
    mode: 'general'
  },
  {
    question: 'How much did Q3 2024 revenue grow year over year?',
    expectedSource: 'data/company-data/18_quarterly_financials_q3_2024.md',
    mode: 'general'
  },
  {
    question: 'What was the root cause of the August 2023 production outage?',
    expectedSource: 'data/company-data/20_postmortem_2023-08-17_outage.md',
    mode: 'general'
  },
  {
    question: 'How long is customer contract data retained under the privacy policy?',
    expectedSource: 'data/company-data/15_data_privacy.md',
    mode: 'general'
  }
];

interface EvalResult {
  question: string;
  expectedSource: string;
  mode: FailureMode;
  retrievedSources: string[];
  ok: boolean;
  note?: string;
}

async function main(): Promise<void> {
  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const embeddingsService = new EmbeddingsService(openai, DOCS_DIR, pool);

  console.log('Initializing embeddings cache (this makes real OpenAI embedding calls)...');
  await embeddingsService.initialize();
  const ragService = new RagService(openai, embeddingsService, false);

  const results: EvalResult[] = [];

  for (const c of CASES) {
    process.stdout.write(`Running: "${c.question}" ... `);
    const queries = await ragService.proposeSearchQueries(c.question);
    const chunks = await embeddingsService.multiSearch(queries, 3);
    const retrievedSources = [...new Set(chunks.map((chunk) => chunk.source))];
    const ok = retrievedSources.includes(c.expectedSource);
    console.log(ok ? 'OK' : 'MISMATCH');
    results.push({
      question: c.question,
      expectedSource: c.expectedSource,
      mode: c.mode,
      retrievedSources,
      ok,
      note: c.note
    });
  }

  console.log('\n=== Retrieval Quality Eval Results ===\n');
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✘'} [${r.mode}] "${r.question}"`);
    console.log(`   expected source: ${r.expectedSource}`);
    console.log(`   retrieved sources: [${r.retrievedSources.join(', ') || 'none'}]`);
    if (r.note) console.log(`   note: ${r.note}`);
    console.log();
  }

  const passCount = results.filter((r) => r.ok).length;
  console.log(`${passCount}/${results.length} passed`);

  const byMode = new Map<FailureMode, { pass: number; total: number }>();
  for (const r of results) {
    const entry = byMode.get(r.mode) ?? { pass: 0, total: 0 };
    entry.total += 1;
    if (r.ok) entry.pass += 1;
    byMode.set(r.mode, entry);
  }
  console.log('\nBy failure mode:');
  for (const [mode, { pass, total }] of byMode) {
    console.log(`  ${mode}: ${pass}/${total}`);
  }

  process.exitCode = passCount === results.length ? 0 : 1;

  await pool.end();
}

main().catch((err) => {
  console.error('Eval run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
