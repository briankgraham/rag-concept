import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';
// Whether to use mock implementations of external integrations (Okta, ADP).
// Both default to true since this phase has no live Okta tenant or ADP credentials.
const oktaMock = (process.env.OKTA_MOCK ?? 'true') === 'true';
const adpMock = (process.env.ADP_MOCK ?? 'true') === 'true';

// Frontend origin(s) allowed to call this API cross-origin with the
// session cookie attached (comma-separated). Deliberately not required —
// an empty list is a valid "no cross-origin caller configured yet" state,
// not a config error, and CORS simply allows nothing until one is set.
const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

// The mock Okta login (/auth/mock-login, MockOktaClient) lets anyone sign in
// as any of the hardcoded MOCK_EMPLOYEES without any real credential check —
// it's a deliberate dev-only stand-in for real Okta SSO (see
// okta-client.mock.ts). Both mocks default to true, so a production deploy
// that simply forgets to set OKTA_MOCK/ADP_MOCK=false would silently expose
// a full authentication bypass (and, once RealAdpClient exists, mocked HR
// data) instead of failing loudly. Fail fast instead.
if (isProduction && oktaMock) {
  throw new Error(
    'OKTA_MOCK must be false in production (NODE_ENV=production) — the mock login bypasses real authentication.'
  );
}
if (isProduction && adpMock) {
  throw new Error(
    'ADP_MOCK must be false in production (NODE_ENV=production) — it never leaves demo HR data.'
  );
}

// Where the separate web/ frontend is served from. The /auth/callback
// redirect target after login — deliberately not required, same
// rationale as allowedOrigins: local dev should work with zero env
// setup, defaulting to Vite's own default port.
const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  openaiApiKey: required('OPENAI_API_KEY'),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/simple_rag'),
  sessionCookieName: 'session_token',
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000), 10), // 7 days
  ptoCacheTtlMs: parseInt(process.env.PTO_CACHE_TTL_MS ?? String(15 * 60 * 1000), 10), // 15 minutes
  // Caps how much conversation history is stored and replayed per user (10
  // question/answer exchanges) — each append prunes back down to this, so
  // the table can't grow unbounded and there's no separate "how much to
  // send the LLM" decision: whatever's stored is exactly what gets replayed.
  maxConversationMessages: parseInt(process.env.MAX_CONVERSATION_MESSAGES ?? '20', 10),
  oktaMock,
  adpMock,
  allowedOrigins,
  frontendUrl,
  isProduction
};
