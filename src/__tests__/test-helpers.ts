/**
 * Shared test doubles for orchestrator/tool tests. Keeping these in one
 * place means a new tool's test file doesn't need to reinvent a fake user
 * or a scripted chat provider — see src/__tests__/orchestrator.test.ts for
 * the pattern.
 */
import type { AssistantMessage, ChatProvider } from '../providers/chat-provider.interface.js';
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

export function toolCallMessage(id: string, name: string, args: unknown): AssistantMessage {
  return { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

export function finalMessage(content: string): AssistantMessage {
  return { role: 'assistant', content };
}

/**
 * Fake ChatProvider that returns a scripted sequence of assistant messages
 * (from both complete() and completeWithTools()). `onRequest`, when given,
 * is called with `{ messages, tools }` for each call — lets a test assert
 * on what messages (e.g. prior conversation history) the orchestrator
 * actually sent, without every other caller needing to care.
 */
export function scriptedChat(
  messages: AssistantMessage[],
  onRequest?: (request: { messages: unknown[]; tools?: unknown[] }) => void
): ChatProvider {
  let call = 0;
  const next = (): AssistantMessage => {
    const message = messages[Math.min(call, messages.length - 1)];
    call++;
    return message;
  };
  return {
    complete: (requestMessages) => {
      onRequest?.({ messages: requestMessages });
      return Promise.resolve({ content: next().content ?? '', model: 'fake-model' });
    },
    completeWithTools: (requestMessages, tools) => {
      onRequest?.({ messages: requestMessages, tools });
      return Promise.resolve({ message: next(), model: 'fake-model' });
    }
  };
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
  chat: ChatProvider,
  overrides: { ragService?: Partial<RagService>; ptoService?: Partial<PtoService>; debug?: boolean } = {}
): ToolContext {
  return {
    user: fakeUser,
    chat,
    ragService: (overrides.ragService ?? {}) as RagService,
    ptoService: (overrides.ptoService ?? defaultFakePtoService()) as PtoService,
    debug: overrides.debug ?? false
  };
}
