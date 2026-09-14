/**
 * Shared test doubles for orchestrator/tool tests. Keeping these in one
 * place means a new tool's test file doesn't need to reinvent a fake user
 * or a scripted OpenAI client — see src/__tests__/orchestrator.test.ts for
 * the pattern.
 */
import type OpenAI from 'openai';
import type { RagService } from '../rag/rag.service.js';
import type { PtoService } from '../hr/pto.service.js';
import type { ToolContext } from '../orchestrator/types.js';
import type { User } from '../auth/users.repo.js';
import type { PtoBalance } from '../hr/adp-client.interface.js';

export const fakeUser: User = {
  id: 'u1',
  oktaId: 'mock-okta-1',
  email: 'jane.doe@example.com',
  name: 'Jane Doe',
  employeeId: 'E1001'
};

export function toolCallMessage(id: string, name: string, args: unknown) {
  return {
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }]
  };
}

export function finalMessage(content: string) {
  return { role: 'assistant' as const, content, tool_calls: undefined };
}

/**
 * Fake OpenAI client that returns a scripted sequence of chat completion
 * messages. `onRequest`, when given, is called with each raw request body
 * passed to `create()` — lets a test assert on what messages (e.g. prior
 * conversation history) the orchestrator actually sent, without every
 * other scriptedOpenAI caller needing to care.
 */
export function scriptedOpenAI(messages: unknown[], onRequest?: (request: any) => void): OpenAI {
  let call = 0;
  return {
    chat: {
      completions: {
        create: (request: unknown) => {
          onRequest?.(request);
          const message = messages[Math.min(call, messages.length - 1)];
          call++;
          return Promise.resolve({ choices: [{ message }] });
        }
      }
    }
  } as unknown as OpenAI;
}

export const fakePtoBalance: PtoBalance = {
  employeeId: fakeUser.employeeId,
  accrued: 20,
  used: 10,
  remaining: 10,
  asOf: '2026-09-13'
};

function defaultFakePtoService(): Partial<PtoService> {
  return { getBalanceForEmployee: () => Promise.resolve(fakePtoBalance) };
}

export function fakeToolContext(
  openai: OpenAI,
  overrides: { ragService?: Partial<RagService>; ptoService?: Partial<PtoService>; debug?: boolean } = {}
): ToolContext {
  return {
    user: fakeUser,
    openai,
    ragService: (overrides.ragService ?? {}) as RagService,
    ptoService: (overrides.ptoService ?? defaultFakePtoService()) as PtoService,
    debug: overrides.debug ?? false
  };
}
