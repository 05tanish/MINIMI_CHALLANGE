import { useEffect, useRef, useState } from 'react';

const stages = { understanding: 'Understanding your question', memory: 'Retrieving conversation context', search: 'Searching the web', compare: 'Comparing evidence', answer: 'Preparing your answer' };
const apiFetch = (url, options = {}) => fetch(url, { credentials: 'include', ...options, headers: { ...(options.headers ?? {}) } });

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { const response = await apiFetch(`/api/auth/${mode === 'signup' ? 'signup' : 'login'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? 'Unable to sign in.'); onAuthenticated(result.data.user); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><form className="auth-card" onSubmit={submit}><div className="brand"><div className="mark">m</div><div><b>minimi</b><small>RESEARCH</small></div></div><h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1><p>Your conversation research stays private to your account.</p><label>Email<input autoComplete="email" type="email" required maxLength="254" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Password<input autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" required minLength="10" maxLength="128" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <div className="error">{error}</div>}<button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button><button className="auth-switch" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>{mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}</button></form></main>;
}

function renderText(text) {
  const inline = (line, keyPrefix) => line.split(/(\[S\d+\]|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (/^\[S\d+\]$/.test(part)) return <sup className="cite" key={`${keyPrefix}-${i}`}>{part}</sup>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(part)) return <em key={`${keyPrefix}-${i}`}>{part.slice(1, -1)}</em>;
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
  const lines = text.split('\n'); const output = [];
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const isTableRule = (line) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i + 1 < lines.length && line.includes('|') && isTableRule(lines[i + 1])) {
      const headers = cells(line); const rows = []; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      i--;
      output.push(<div className="answer-table-wrap" key={`table-${i}`}><table className="answer-table"><thead><tr>{headers.map((cell, j) => <th key={j}>{inline(cell, `th-${i}-${j}`)}</th>)}</tr></thead><tbody>{rows.map((row, j) => <tr key={j}>{headers.map((_, k) => <td key={k}>{inline(row[k] ?? '', `td-${i}-${j}-${k}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (line.startsWith('## ')) output.push(<h2 key={i}>{inline(line.slice(3), i)}</h2>);
    else if (line.startsWith('### ')) output.push(<h3 key={i}>{inline(line.slice(4), i)}</h3>);
    else if (line.trim() === '---') output.push(<hr key={i} />);
    else if (/^\d+\. /.test(line)) output.push(<div className="answer-list-item" key={i}>{line.match(/^\d+/)[0]}. {inline(line.replace(/^\d+\. /, ''), i)}</div>);
    else if (line.startsWith('- ')) output.push(<div className="answer-list-item" key={i}>• {inline(line.slice(2), i)}</div>);
    else output.push(line ? <p key={i}>{inline(line, i)}</p> : <br key={i} />);
  }
  return output;
}

const diffStatus = { changed: { label: 'CHANGED', cls: 'd-changed' }, unchanged: { label: 'UNCHANGED', cls: 'd-unchanged' }, new_finding: { label: 'NEW', cls: 'd-new' }, no_current_evidence: { label: 'NO CURRENT DATA', cls: 'd-missing' } };

function DiffTable({ entries }) {
  return <div className="diff-panel"><div className="diff-title">EVIDENCE COMPARISON</div><table className="diff-table"><thead><tr><th>Entity</th><th>Attribute</th><th>Historical</th><th>Current</th><th>Status</th></tr></thead><tbody>{entries.map((e, i) => { const s = diffStatus[e.status] ?? { label: e.status, cls: '' }; return <tr key={i} className={s.cls}><td>{e.entity}</td><td>{e.attribute}</td><td>{e.historicalValue ?? '—'}</td><td>{e.currentValue ?? '—'}</td><td><span className="diff-badge">{s.label}</span></td></tr>; })}</tbody></table></div>;
}

function FindingsPanel({ findings }) {
  if (!findings.length) return null;
  return <div className="findings">{findings.map((f, i) => { if (f.findingsType === 'memory') return <div className="finding-group" key={i}><div className="finding-label">📖 MEMORY</div>{f.items.map((item, j) => <div className="finding-item" key={j}>{item.topic} {item.date && <span className="finding-date">· {new Date(item.date).toLocaleDateString()}</span>}</div>)}</div>; if (f.findingsType === 'search') return <div className="finding-group" key={i}><div className="finding-label">🔍 WEB</div>{f.items.map((item, j) => <div className="finding-item" key={j}>{item.title}{item.hasContent && <span className="finding-badge">full page</span>}</div>)}</div>; if (f.findingsType === 'diff') return <div className="finding-group" key={i}><div className="finding-label">📊 DIFF</div>{f.summary && <div className="finding-summary">{f.summary}</div>}<DiffTable entries={f.items} /></div>; return null; })}</div>;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(undefined);
  const [conversations, setConversations] = useState([]); const [id, setId] = useState(null); const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(''); const [status, setStatus] = useState(''); const [statusDetail, setStatusDetail] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [findings, setFindings] = useState([]);
  const abort = useRef(null); const bottom = useRef(null);
  async function loadList() { try { const r = await apiFetch('/api/conversations'); const j = await r.json(); if (j.success) setConversations(j.data.items); } catch {} }
  async function loadConversation(cid) { const r = await apiFetch(`/api/conversations/${cid}`); const j = await r.json(); if (j.success) { setId(cid); setMessages(j.data.messages.map((m) => ({ ...m, sources: m.sources ?? [], diff: [], searchRounds: 0 }))); setError(''); } }
  useEffect(() => { apiFetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then((j) => setCurrentUser(j?.data?.user ?? null)).catch(() => setCurrentUser(null)); }, []);
  useEffect(() => { if (currentUser) loadList(); }, [currentUser]); useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, status, findings]);
  async function submit(event) {
    event?.preventDefault(); if (!input.trim() || busy) return;
    const message = input.trim(); setInput(''); setError(''); setBusy(true); setStatus(stages.understanding); setStatusDetail(''); setFindings([]);
    setMessages((old) => [...old, { role: 'user', content: message, createdAt: new Date().toISOString() }, { role: 'assistant', content: '', sources: [], diff: [], searchRounds: 0, streaming: true }]);
    const controller = new AbortController(); abort.current = controller;
    try {
      const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: id ?? undefined, message }), signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message ?? 'Request failed'); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split('\n\n'); buffer = events.pop() ?? ''; for (const raw of events) {
        const line = raw.split('\n').find((x) => x.startsWith('data: ')); if (!line) continue; const event = JSON.parse(line.slice(6));
        if (event.type === 'conversation') setId(event.conversationId);
        if (event.type === 'progress') { setStatus(stages[event.stage] ?? 'Working'); setStatusDetail(event.detail ?? ''); }
        if (event.type === 'findings') setFindings((old) => [...old, event]);
        if (event.type === 'delta') setMessages((old) => old.map((m, i) => i === old.length - 1 ? { ...m, content: m.content + event.text } : m));
        if (event.type === 'done') setMessages((old) => old.map((m, i) => i === old.length - 1 ? { ...m, content: event.answer, sources: event.sources, diff: event.diff ?? [], diffSummary: event.diffSummary, searchRounds: event.searchRounds ?? 0, streaming: false } : m));
        if (event.type === 'error') throw new Error(event.message);
      } }
      setStatus(''); setStatusDetail(''); setFindings([]); await loadList();
    } catch (e) { setError(e.name === 'AbortError' ? 'Request cancelled.' : e.message); setMessages((old) => old.filter((m) => !m.streaming)); }
    finally { setBusy(false); setStatus(''); setStatusDetail(''); abort.current = null; }
  }
  if (currentUser === undefined) return <main className="auth-shell"><div className="auth-card">Checking your session…</div></main>;
  if (!currentUser) return <AuthScreen onAuthenticated={setCurrentUser} />;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><div className="mark">m</div><div><b>minimi</b><small>RESEARCH</small></div></div><button className="new-chat" onClick={() => { setId(null); setMessages([]); setError(''); }}>＋ <span>New conversation</span></button><div className="side-label">RECENT</div><nav>{conversations.map((c) => <button className={`conversation ${id === c.id ? 'active' : ''}`} key={c.id} onClick={() => loadConversation(c.id)}>{c.title}</button>)}</nav><div className="side-footer"><span className="dot"/> {currentUser.email}<button className="auth-switch" onClick={async () => { await apiFetch('/api/auth/logout', { method: 'POST' }); setCurrentUser(null); setConversations([]); setMessages([]); setId(null); }}>Sign out</button></div></aside>
    <main className="main"><header className="topbar"><div className="mobile-brand">minimi <span>research</span></div><span className="connection"><i/> Private workspace</span></header>
      <section className="thread">
        {messages.length === 0 ? <div className="welcome"><div className="welcome-icon">✳</div><p className="eyebrow">YOUR CONVERSATION, WITH CONTEXT</p><h1>Research that remembers<br/>what matters.</h1><p className="subhead">Ask about past discussions, get current answers, and see how the evidence changed.</p><div className="suggestions"><button onClick={() => setInput('What did I ask you last week?')}>↗ &nbsp;What did I ask you last week?</button><button onClick={() => setInput('Has the pricing we discussed changed since?')}>↗ &nbsp;Check a price against our discussion</button><button onClick={() => setInput('Find the latest release notes for the product we discussed')}>↗ &nbsp;Find recent product updates</button></div></div> : <div className="messages">{messages.map((m, i) => <article className={`message ${m.role}`} key={i}><div className="avatar">{m.role === 'user' ? 'Y' : '✳'}</div><div className="bubble"><div className="role-label">{m.role === 'user' ? 'YOU' : 'MINIMI'}</div><div className="content">{renderText(m.content)}{m.streaming && <span className="cursor"/>}</div>{m.diff?.length > 0 && <DiffTable entries={m.diff} />}{m.sources?.length > 0 && <div className="sources"><div className="sources-title">SOURCES{m.searchRounds > 1 && <span className="rounds-badge">· {m.searchRounds} search rounds</span>}</div>{m.sources.map((s) => <a href={s.url} target="_blank" rel="noreferrer" key={s.id}><span className="source-id">{s.id}</span><span><b>{s.title}</b><small>{(() => { try { return new URL(s.url).hostname; } catch { return s.url; } })()}</small></span><span className="external">↗</span></a>)}</div>}</div></article>)}</div>}
        {status && <div className="progress"><span className="spinner"/>{status}{statusDetail && <span className="progress-detail">{statusDetail}</span>}</div>}
        {busy && findings.length > 0 && <FindingsPanel findings={findings} />}
        {error && <div className="error"><span>{error}</span><button onClick={() => { setInput(messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''); setError(''); }}>Retry</button></div>}<div ref={bottom}/>
      </section>
      <form className="composer" onSubmit={submit}><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }} placeholder="Ask about a past conversation or research something new…" rows="1"/><div className="composer-bottom"><span>Enter to send · Shift + Enter for a new line</span><button type="submit" disabled={busy || !input.trim()} aria-label="Send message">{busy ? '…' : '↑'}</button></div></form>
      <footer className="disclaimer">Answers are grounded in retrieved conversations and cited web sources.</footer>
    </main>
  </div>;
}
