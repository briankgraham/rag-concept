#!/usr/bin/env node
/*
 * Tool-selection eval: sends a batch of representative questions to the
 * REAL orchestrator (real OpenAI calls, real embeddings/docs search) and
 * checks which tool actually got called for each. This is the thing unit
 * tests with a scripted fake OpenAI client can't tell you — whether the
 * live model reliably picks get_pto_balance vs. search_company_docs vs.
 * neither for real phrasings, including ambiguous/adversarial ones.
 *
 * Needs OPENAI_API_KEY, plus a reachable Postgres (DATABASE_URL, migrations
 * applied) since embeddings/search now live there (see
 * src/rag/embeddings.service.ts) — the PTO path itself still uses a fake
 * PtoService returning a fixed balance instead of the DB-backed one.
 */
import path from 'path';
import OpenAI from 'openai';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { EmbeddingsService } from '../rag/embeddings.service.js';
import { RagService } from '../rag/rag.service.js';
import { runOrchestrator } from '../orchestrator/orchestrator.js';
import type { PtoService } from '../hr/pto.service.js';
import type { PtoBalance } from '../hr/adp-client.interface.js';
import type { User } from '../auth/users.repo.js';

const DOCS_DIR = path.resolve('data', 'company-data');

const fakeUser: User = {
  id: 'eval-user',
  oktaId: 'eval',
  email: 'eval@example.com',
  name: 'Eval User',
  employeeId: 'E9999'
};

const fakeBalance: PtoBalance = {
  employeeId: fakeUser.employeeId,
  accrued: 20,
  used: 10,
  remaining: 10,
  asOf: new Date().toISOString().slice(0, 10)
};

const fakePtoServicePartial: Partial<PtoService> = {
  getBalanceForEmployee: () => Promise.resolve(fakeBalance)
};
const fakePtoService = fakePtoServicePartial as PtoService;

type ExpectedTool = 'get_pto_balance' | 'search_company_docs' | 'none';

interface Case {
  question: string;
  expectedTool: ExpectedTool;
  note?: string;
}

const CASES: Case[] = [
  // Clear personal-PTO phrasings
  { question: 'How many PTO days do I have left?', expectedTool: 'get_pto_balance' },
  { question: "What's my vacation balance?", expectedTool: 'get_pto_balance' },
  { question: 'Am I running low on time off?', expectedTool: 'get_pto_balance' },
  { question: 'How many days off have I used this year?', expectedTool: 'get_pto_balance' },
  { question: 'Do I have any PTO left?', expectedTool: 'get_pto_balance' },

  // Clear general-policy phrasings — must NOT trigger the personal tool
  { question: "What is the company's PTO policy?", expectedTool: 'search_company_docs' },
  { question: 'How does PTO accrual work?', expectedTool: 'search_company_docs' },
  { question: 'What is the remote work policy?', expectedTool: 'search_company_docs' },
  { question: "What's the 401k match?", expectedTool: 'search_company_docs' },
  { question: 'How many vacation days do new employees get?', expectedTool: 'search_company_docs' },

  // Ambiguous / adversarial — the interesting cases
  {
    question: 'My coworker wants to know how much PTO employees get per year.',
    expectedTool: 'search_company_docs',
    note: 'about general entitlement, not "my" balance — watch for a false positive on get_pto_balance'
  },
  { question: 'What is PTO?', expectedTool: 'search_company_docs', note: 'definitional, not personal' },
  { question: 'Who is the CEO?', expectedTool: 'search_company_docs' },
  { question: 'Hello, how are you?', expectedTool: 'none', note: 'no tool should be needed at all' }
];

interface EvalResult {
  question: string;
  expected: ExpectedTool;
  actualTools: string[];
  answer: string;
  ok: boolean;
  note?: string;
}

function matches(expected: ExpectedTool, actualTools: string[]): boolean {
  return expected === 'none' ? actualTools.length === 0 : actualTools.includes(expected);
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
    const result = await runOrchestrator(c.question, {
      user: fakeUser,
      openai,
      ragService,
      ptoService: fakePtoService,
      debug: false
    });
    const actualTools = result.toolCalls.map((tc) => tc.name);
    const ok = matches(c.expectedTool, actualTools);
    console.log(ok ? 'OK' : 'MISMATCH');
    results.push({
      question: c.question,
      expected: c.expectedTool,
      actualTools,
      answer: result.answer,
      ok,
      note: c.note
    });
  }

  console.log('\n=== Tool Selection Eval Results ===\n');
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✘'} "${r.question}"`);
    console.log(`   expected: ${r.expected} | actual tools called: [${r.actualTools.join(', ') || 'none'}]`);
    if (r.note) console.log(`   note: ${r.note}`);
    console.log(`   answer: ${r.answer.slice(0, 140)}${r.answer.length > 140 ? '...' : ''}\n`);
  }

  const passCount = results.filter((r) => r.ok).length;
  console.log(`${passCount}/${results.length} passed`);
  process.exitCode = passCount === results.length ? 0 : 1;

  await pool.end();
}

main().catch((err) => {
  console.error('Eval run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
