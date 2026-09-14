import { useEffect, useState } from 'react';
import { askQuestion, getMe, loginUrl, resetConversation, type Me } from './api';

type AuthState = { status: 'loading' } | { status: 'unauthenticated' } | { status: 'authenticated'; me: Me };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    getMe()
      .then((me) => setAuth(me ? { status: 'authenticated', me } : { status: 'unauthenticated' }))
      .catch(() => setAuth({ status: 'unauthenticated' }));
  }, []);

  return (
    <div className="page">
      <Brand />
      {auth.status === 'loading' && (
        <div className="centered">
          <div className="spinner" />
        </div>
      )}
      {auth.status === 'unauthenticated' && <UnauthCard />}
      {auth.status === 'authenticated' && <Chat />}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden />
      <span>Company Chat</span>
    </div>
  );
}

function UnauthCard() {
  return (
    <div className="centered">
      <div className="card">
        <h1>uh oh! we don&rsquo;t know you!</h1>
        <p>Sign in to start asking questions.</p>
        <a className="btn" href={loginUrl()}>
          Log in
        </a>
      </div>
    </div>
  );
}

type Exchange = { question: string; answer?: string; error?: string };

function Chat() {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [exchange, setExchange] = useState<Exchange | null>(null);

  async function startNewConversation() {
    if (pending) return;
    setExchange(null);
    setQuestion('');
    try {
      await resetConversation();
    } catch {
      // Best-effort: even if the server call fails, clearing local state
      // still lets the user start typing a fresh question.
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setQuestion('');
    // The UI itself still only renders the latest exchange, but the server
    // now remembers this user's conversation (see ../../src/chat/chat.
    // routes.ts) so a follow-up question has that context even though it
    // isn't shown here.
    setExchange({ question: trimmed });
    try {
      const result = await askQuestion(trimmed);
      setExchange({ question: trimmed, answer: result.answer });
    } catch (err) {
      setExchange({ question: trimmed, error: err instanceof Error ? err.message : 'Something went wrong' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="chat-shell">
      <div className="thread-header">
        <button type="button" className="btn-link" onClick={startNewConversation} disabled={pending}>
          New conversation
        </button>
      </div>
      <div className="thread">
        {!exchange && <p className="empty-hint">Ask anything about company docs, PTO, or policy.</p>}
        {exchange && (
          <>
            <div className="bubble user">{exchange.question}</div>
            {exchange.error && <div className="bubble error">{exchange.error}</div>}
            {exchange.answer && <div className="bubble assistant">{exchange.answer}</div>}
            {pending && (
              <div className="bubble assistant">
                <span className="typing">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
          disabled={pending}
          autoFocus
        />
        <button className="btn" type="submit" disabled={pending || !question.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
