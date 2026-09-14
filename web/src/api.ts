// Thin fetch wrappers around the API (see ../../src/chat/chat.routes.ts,
// ../../src/auth/). Every call sends credentials so the httpOnly
// session_token cookie rides along on this cross-origin request — the
// API's CORS middleware (../../src/middleware/cors.ts) must have this
// page's origin in ALLOWED_ORIGIN or the browser will refuse it.

const API_URL = import.meta.env.VITE_API_URL as string;

export interface Me {
  id: string;
  email: string;
  name: string;
}

// Mirrors ChatAnswer in ../../src/chat/chat.service.ts.
export interface ChatAnswer {
  answer: string;
  source: 'pto_lookup' | 'rag' | 'direct';
  sources: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/** Resolves the current user, or null if not logged in (401). Throws on any other failure. */
export async function getMe(): Promise<Me | null> {
  const res = await fetch(`${API_URL}/api/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await parseErrorMessage(res));
  return (await res.json()) as Me;
}

export async function askQuestion(question: string): Promise<ChatAnswer> {
  const res = await fetch(`${API_URL}/api/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorMessage(res));
  return (await res.json()) as ChatAnswer;
}

export function loginUrl(): string {
  return `${API_URL}/auth/login`;
}

/** Clears the user's server-side conversation history (see DELETE /api/chat). */
export async function resetConversation(): Promise<void> {
  const res = await fetch(`${API_URL}/api/chat`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, await parseErrorMessage(res));
}
