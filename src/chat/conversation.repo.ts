import { query } from '../db/pool.js';
import { config } from '../config.js';

export type ConversationRole = 'user' | 'assistant';

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

/**
 * The single active conversation for a user is just "every row for their
 * user_id", oldest first — there's no separate conversation/session id
 * (see CLAUDE.md discussion): one user has exactly one ongoing thread.
 */
export async function getRecentMessages(userId: string): Promise<ConversationMessage[]> {
  const result = await query<{ role: ConversationRole; content: string }>(
    'SELECT role, content FROM conversation_messages WHERE user_id = $1 ORDER BY created_at ASC',
    [userId]
  );
  return result.rows;
}

/**
 * Appends new turns and prunes back down to config.maxConversationMessages
 * in the same call, so a user's stored history — and therefore what gets
 * replayed into the LLM next time — can never grow unbounded.
 */
export async function appendMessages(userId: string, messages: ConversationMessage[]): Promise<void> {
  if (messages.length === 0) return;

  for (const message of messages) {
    await query('INSERT INTO conversation_messages (user_id, role, content) VALUES ($1, $2, $3)', [
      userId,
      message.role,
      message.content
    ]);
  }

  await query(
    `DELETE FROM conversation_messages
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM conversation_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
    [userId, config.maxConversationMessages]
  );
}

export async function clearConversation(userId: string): Promise<void> {
  await query('DELETE FROM conversation_messages WHERE user_id = $1', [userId]);
}
