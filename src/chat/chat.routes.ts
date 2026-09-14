import Router from '@koa/router';
import { requireAuth } from '../auth/auth.middleware.js';
import { answerChatMessage, type ChatDeps } from './chat.service.js';
import { clearConversation } from './conversation.repo.js';
import { HttpError } from '../middleware/error-handler.js';

// No inherent product need for a long question, and each character here
// ends up in an LLM prompt (directly, and again via search_company_docs'
// generated sub-queries) — without a cap, an authenticated user could send
// an arbitrarily large body (up to koa-bodyparser's own limit) and drive
// outsized per-request OpenAI token cost/latency.
const MAX_QUESTION_LENGTH = 2000;

export function createChatRouter(deps: ChatDeps): Router {
  const router = new Router();

  router.post('/api/chat', requireAuth, async (ctx) => {
    const body = ctx.request.body as { question?: unknown } | undefined;
    const question = typeof body?.question === 'string' ? body.question.trim() : '';

    if (!question) {
      throw new HttpError(400, 'invalid_request', 'Field "question" (string) is required');
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new HttpError(400, 'invalid_request', `Field "question" must be ${MAX_QUESTION_LENGTH} characters or fewer`);
    }

    const result = await answerChatMessage(deps, ctx.state.user!, question);
    ctx.body = result;
  });

  // Lets a user deliberately start over instead of being stuck replaying
  // stale context from an earlier, unrelated conversation forever.
  router.delete('/api/chat', requireAuth, async (ctx) => {
    await clearConversation(ctx.state.user!.id);
    ctx.status = 204;
  });

  router.get('/api/me', requireAuth, async (ctx) => {
    const user = ctx.state.user!;
    ctx.body = { id: user.id, email: user.email, name: user.name };
  });

  return router;
}
