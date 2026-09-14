#!/usr/bin/env node
import path from 'path';
import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import OpenAI from 'openai';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { EmbeddingsService } from './rag/embeddings.service.js';
import { RagService } from './rag/rag.service.js';
import { PtoService } from './hr/pto.service.js';
import { MockAdpClient } from './hr/adp-client.mock.js';
import { RealAdpClient } from './hr/adp-client.real.js';
import { MockOktaClient } from './auth/okta-client.mock.js';
import { RealOktaClient } from './auth/okta-client.real.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { corsMiddleware } from './middleware/cors.js';
import { attachUser } from './auth/auth.middleware.js';
import { createAuthRouter } from './auth/auth.routes.js';
import { createChatRouter } from './chat/chat.routes.js';

const DOCS_DIR = path.resolve('data', 'company-data');
const debug = process.env.DEBUG === 'true';

async function main(): Promise<void> {
  // --- Wiring: every service/integration is constructed once here and
  // handed to whatever needs it (routers, the orchestrator's ToolContext).
  // Nothing downstream reaches for a module-level singleton — that's what
  // keeps each piece swappable and independently testable. See
  // src/orchestrator/types.ts for the same rule applied to tools.
  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  const embeddingsService = new EmbeddingsService(openai, DOCS_DIR, pool);
  console.log('Initializing embeddings cache...');
  await embeddingsService.initialize();
  const stats = await embeddingsService.getCacheStats();
  console.log(`Loaded ${stats.chunkCount} chunks (embedding dim: ${stats.embeddingDim})`);
  const ragService = new RagService(openai, embeddingsService, debug);

  const adpClient = config.adpMock ? new MockAdpClient() : new RealAdpClient();
  const ptoService = new PtoService(adpClient);

  const oktaClient = config.oktaMock ? new MockOktaClient() : new RealOktaClient();

  const app = new Koa();

  const healthRouter = new Router();
  healthRouter.get('/health', async (ctx) => {
    await pool.query('SELECT 1');
    ctx.body = { status: 'ok' };
  });

  const authRouter = createAuthRouter({ oktaClient });
  const chatRouter = createChatRouter({ openai, ragService, ptoService, debug });

  // requestLogger must wrap errorHandler, not the other way around: Koa
  // middleware is an onion, and once an exception propagates out of
  // requestLogger's `await next()` uncaught, that call has already
  // rejected — there's no way for its post-next() log line to "resume"
  // after an outer catch handles the error later. With errorHandler
  // nested inside requestLogger instead, errorHandler fully absorbs any
  // downstream throw and returns normally, so requestLogger's `next()`
  // always resolves and its log line runs for every request, success or
  // failure, with the real final ctx.status.
  app.use(requestLogger);
  app.use(errorHandler);
  app.use(corsMiddleware(config.allowedOrigins));
  app.use(bodyParser());
  app.use(attachUser);

  app.use(healthRouter.routes());
  app.use(authRouter.routes());
  app.use(chatRouter.routes());

  app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
    console.log(`Mock mode: Okta=${config.oktaMock} ADP=${config.adpMock}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
