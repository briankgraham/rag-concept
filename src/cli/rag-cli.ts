#!/usr/bin/env node
/*
 * Simple RAG CLI (backend-only) implemented in TypeScript.
 *
 * Features:
 *  - Load & chunk markdown docs from data/company-data/*.md
 *  - Embed and cache chunks in Postgres (doc_sources/doc_chunks, via
 *    pgvector) on first run — requires DATABASE_URL reachable with
 *    migrations applied (npm run migrate)
 *  - Interactive ask/answer loop (vector search + LLM)
 *  - Requires OPENAI_API_KEY environment variable
 *
 * This is a dev/debug tool kept alongside the production web app (see
 * src/server.ts). It shares the RAG pipeline (src/rag/*) with the web
 * app's chat endpoint, but has no concept of an authenticated user, so it
 * cannot answer personal-data questions like "how many PTO days do I have
 * left" — that requires a logged-in session (see src/chat/chat.service.ts).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import OpenAI from 'openai';
import { pool } from '../db/pool.js';
import { EmbeddingsService } from '../rag/embeddings.service.js';
import { RagService } from '../rag/rag.service.js';

const DOCS_DIR = path.resolve('data', 'company-data');

let openai: OpenAI;
let embeddingsService: EmbeddingsService;
let ragService: RagService;
let debug = false;

// --------------- Spinner ---------------------

function createSpinner(message = 'Thinking') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${message}...`);
  }, 80);
  return {
    stop() {
      clearInterval(id);
      process.stdout.write('\r' + ' '.repeat(message.length + 6) + '\r');
    }
  };
}

// --------------- CLI -------------------------

async function interactiveCLI(): Promise<void> {
  console.log('Simple RAG CLI. Type "exit" to quit.');

  console.log('Initializing embeddings cache...');
  await embeddingsService.initialize();

  const stats = await embeddingsService.getCacheStats();
  console.log(`Loaded ${stats.chunkCount} chunks (embedding dim: ${stats.embeddingDim})`);

  console.log("\nHey, I'm your company docs assistant! Ask me about policies, benefits, or procedures.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  // Tracks the currently in-flight answer, if any. Needed because with
  // non-interactive (piped) stdin, readline emits 'close' as soon as the
  // input stream ends — which can happen while the handler below is still
  // awaiting a live answer — so resolving interactiveCLI() on 'close' alone
  // could let a caller close the Postgres pool out from under that
  // in-flight query.
  let pending: Promise<void> | undefined;

  return new Promise((resolve) => {
    rl.on('close', () => {
      closed = true;
      void Promise.resolve(pending).then(resolve);
    });

    const ask = (): void => {
      if (closed) return;
      // readline's callback is a plain (non-Promise) callback API, so an
      // error thrown inside this async handler would otherwise become a
      // silent unhandled rejection instead of something the user ever sees.
      rl.question('\n> ', (line) => {
        pending = (async () => {
          const q = line.trim();
          if (!q || q.toLowerCase() === 'exit' || q.toLowerCase() === 'quit') {
            rl.close();
            return;
          }
          const spinner = createSpinner();
          try {
            const { answer, sources } = await ragService.answerFromDocs(q);
            spinner.stop();
            console.log('\n' + wrap(answer, 80));
            if (sources.length > 0) {
              console.log(`\n(sources: ${sources.join(', ')})`);
            }
          } catch (err) {
            spinner.stop();
            console.error('\nSomething went wrong answering that:', err instanceof Error ? err.message : err);
          }
          ask();
        })();
      });
    };

    ask();
  });
}

function wrapLine(line: string, width: number): string {
  if (line.length <= width) return line;
  const prefixMatch = line.match(/^(\s*(?:[-*•]\s+|\d+[.)]\s+)?)/);
  const indent = ' '.repeat(prefixMatch ? prefixMatch[0].length : 0);
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  const result: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      result.push(current);
      current = indent + word;
    }
  }
  if (current) result.push(current);
  return result.join('\n');
}

function wrap(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}

// --------------- Main ------------------------

async function promptForAPIKey(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter your OpenAI API key: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function addFile(filePath: string): Promise<void> {
  // Validate file exists
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  // Validate it's a file, not a directory
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    console.error(`Error: ${filePath} is not a file`);
    process.exit(1);
  }

  // Validate it's a markdown file
  if (!filePath.endsWith('.md')) {
    console.error('Error: Only .md (markdown) files are supported');
    process.exit(1);
  }

  // Create destination path
  const fileName = path.basename(filePath);
  const destPath = path.join(DOCS_DIR, fileName);

  // Check if file already exists
  if (fs.existsSync(destPath)) {
    console.error(`Error: File ${fileName} already exists in ${DOCS_DIR}`);
    process.exit(1);
  }

  // Copy file to company data directory
  console.log(`Adding ${fileName} to knowledge base...`);
  fs.copyFileSync(filePath, destPath);
  console.log(`✓ File copied to ${destPath}`);

  // Rebuild embeddings cache
  console.log('Rebuilding embeddings cache...');
  await embeddingsService.rebuildCache();

  const stats2 = await embeddingsService.getCacheStats();
  console.log(`✓ Cache rebuilt with ${stats2.chunkCount} chunks`);
  console.log('File added successfully!');
}

(async () => {
  let apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    apiKey = await promptForAPIKey();
    if (!apiKey) {
      console.error('Error: API key is required to run this CLI.');
      process.exit(1);
    }
  }

  openai = new OpenAI({ apiKey });
  embeddingsService = new EmbeddingsService(openai, DOCS_DIR, pool);

  // Parse command line arguments
  const args = process.argv.slice(2);
  debug = args.includes('--debug');
  const filteredArgs = args.filter((a) => a !== '--debug');
  const cmd = filteredArgs[0];

  ragService = new RagService(openai, embeddingsService, debug);

  if (cmd === 'train') {
    console.log('Rebuilding embeddings cache...');
    await embeddingsService.rebuildCache();
    console.log('Cache rebuilt successfully.');
    process.exit(0);
  }

  if (cmd === '--add-file') {
    const filePath = filteredArgs[1];
    if (!filePath) {
      console.error('Error: --add-file requires a file path');
      console.error('Usage: npx rag --add-file <path-to-file.md>');
      process.exit(1);
    }
    await addFile(filePath);
    process.exit(0);
  }

  // No command or unrecognized command - start interactive mode
  await interactiveCLI();
  // The other branches above all call process.exit() explicitly, which
  // force-quits regardless of open handles; this one doesn't, so the open
  // Postgres pool would otherwise keep the process alive after "exit".
  await pool.end();
})().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
