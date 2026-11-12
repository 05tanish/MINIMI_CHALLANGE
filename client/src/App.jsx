import { useEffect, useRef, useState } from 'react';

const stages = { understanding: 'Understanding your question', memory: 'Retrieving conversation context', search: 'Searching the web', compare: 'Comparing evidence', answer: 'Preparing your answer' };
const apiFetch = (url, options = {}) => fetch(url, { ...options, headers: { ...(options.headers ?? {}), ...(import.meta.env.VITE_API_TOKEN ? { authorization: `Bearer ${import.meta.env.VITE_API_TOKEN}` } : {}) } });
function renderText(text) {
  return text.split(/(\[S\d+\])/g).map((part, i) => /^\[S\d+\]$/.test(part) ? <sup className="cite" key={i}>{part}</sup> : <span key={i}>{part}</span>);
}
export default function App() {
  const [conversations, setConversations] = useState([]); const [id, setId] = useState(null); const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(''); const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const abort = useRef(null); const bottom = useRef(null);
  async function loadList() { try { const r = await apiFetch('/api/conversations'); const j = await r.json(); if (j.success) setConversations(j.data.items); } catch {} }
  async function loadConversation(cid) { const r = await apiFetch(`/api/conversations/${cid}`); const j = await r.json(); if (j.success) { setId(cid); setMessages(j.data.messages.map((m) => ({ ...m, sources: m.sources ?? [] }))); setError(''); } }
  useEffect(() => { loadList(); }, []); useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, status]);
  async function submit(event) {
    event?.preventDefault(); if (!input.trim() || busy) return;
    const message = input.trim(); setInput(''); setError(''); setBusy(true); setStatus(stages.understanding);
    setMessages((old) => [...old, { role: 'user', content: message, createdAt: new Date().toISOString() }, { role: 'assistant', content: '', sources: [], streaming: true }]);
    const controller = new AbortController(); abort.current = controller;
    try {
      const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: id ?? undefined, message }), signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message ?? 'Request failed'); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split('\n\n'); buffer = events.pop() ?? ''; for (const raw of events) {
        const line = raw.split('\n').find((x) => x.startsWith('data: ')); if (!line) continue; const event = JSON.parse(line.slice(6));
        if (event.type === 'conversation') setId(event.conversationId);
        if (event.type === 'progress') setStatus(stages[event.stage] ?? 'Working');
        if (event.type === 'delta') setMessages((old) => old.map((m, i) => i === old.length - 1 ? { ...m, content: m.content + event.text } : m));
        if (event.type === 'done') setMessages((old) => old.map((m, i) => i === old.length - 1 ? { ...m, content: event.answer, sources: event.sources, streaming: false } : m));
        if (event.type === 'error') throw new Error(event.message);
      } }
      setStatus(''); await loadList();
    } catch (e) { setError(e.name === 'AbortError' ? 'Request cancelled.' : e.message); setMessages((old) => old.filter((m) => !m.streaming)); }
    finally { setBusy(false); setStatus(''); abort.current = null; }
  }
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><div className="mark">m</div><div><b>minimi</b><small>RESEARCH</small></div></div><button className="new-chat" onClick={() => { setId(null); setMessages([]); setError(''); }}>＋ <span>New conversation</span></button><div className="side-label">RECENT</div><nav>{conversations.map((c) => <button className={`conversation ${id === c.id ? 'active' : ''}`} key={c.id} onClick={() => loadConversation(c.id)}>{c.title}</button>)}</nav><div className="side-footer"><span className="dot"/> Research assistant</div></aside>
    <main className="main"><header className="topbar"><div className="mobile-brand">minimi <span>research</span></div><span className="connection"><i/> Private workspace</span></header>
      <section className="thread">
        {messages.length === 0 ? <div className="welcome"><div className="welcome-icon">✳</div><p className="eyebrow">YOUR CONVERSATION, WITH CONTEXT</p><h1>Research that remembers<br/>what matters.</h1><p className="subhead">Ask about past discussions, get current answers, and see how the evidence changed.</p><div className="suggestions"><button onClick={() => setInput('What did I ask you last week?')}>↗ &nbsp;What did I ask you last week?</button><button onClick={() => setInput('Has the pricing we discussed changed since?')}>↗ &nbsp;Check a price against our discussion</button><button onClick={() => setInput('Find the latest release notes for the product we discussed')}>↗ &nbsp;Find recent product updates</button></div></div> : <div className="messages">{messages.map((m, i) => <article className={`message ${m.role}`} key={i}><div className="avatar">{m.role === 'user' ? 'Y' : '✳'}</div><div className="bubble"><div className="role-label">{m.role === 'user' ? 'YOU' : 'MINIMI'}</div><div className="content">{renderText(m.content)}{m.streaming && <span className="cursor"/>}</div>{m.sources?.length > 0 && <div className="sources"><div className="sources-title">SOURCES</div>{m.sources.map((s) => <a href={s.url} target="_blank" rel="noreferrer" key={s.id}><span className="source-id">{s.id}</span><span><b>{s.title}</b><small>{new URL(s.url).hostname}</small></span><span className="external">↗</span></a>)}</div>}</div></article>)}</div>}
        {status && <div className="progress"><span className="spinner"/>{status}</div>}{error && <div className="error"><span>{error}</span><button onClick={() => { setInput(messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''); setError(''); }}>Retry</button></div>}<div ref={bottom}/>
      </section>
      <form className="composer" onSubmit={submit}><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }} placeholder="Ask about a past conversation or research something new…" rows="1"/><div className="composer-bottom"><span>Enter to send · Shift + Enter for a new line</span><button type="submit" disabled={busy || !input.trim()} aria-label="Send message">{busy ? '…' : '↑'}</button></div></form>
      <footer className="disclaimer">Answers are grounded in retrieved conversations and cited web sources.</footer>
    </main>
  </div>;
}
