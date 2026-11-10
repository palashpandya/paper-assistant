import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connect, type AgentInfo, type CompileResult, type FileInfo, type NewThread, type ServerMsg, type Thread } from './api';
import { Comments } from './Comments';
import { Chat, type ContextChip, type Message } from './Chat';
import { Editor, type EditorDoc, type EditorSelection } from './Editor';
import { PdfView, type PdfHandle, type PdfSelection } from './PdfView';
import { THEMES, applyTheme, savedTheme, type ThemeId } from './themes';
import { HANDLE, PANE_LETTER, PRESETS, defaultSizes, load, save, type PaneId, type Sizes } from './layout';

const basename = (p: string) => p.split('/').pop()!;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function App() {
  const [name, setName] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [main, setMain] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [doc, setDoc] = useState<EditorDoc | null>(null);
  const [jump, setJump] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [pdfChips, setPdfChips] = useState<ContextChip[]>([]);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [connected, setConnected] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [tab, setTab] = useState<'chat' | 'comments'>('chat');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentChoice, setAgentChoice] = useState(() => load('agent', 'claude'));
  const [presetId, setPresetId] = useState(() => load('layout.preset', PRESETS[0].id));
  const [allSizes, setAllSizes] = useState<Record<string, Sizes>>(() => load('layout.sizes', {}));
  const [sidebarOpen, setSidebarOpen] = useState(() => load('sidebar.open', true));
  const [sidebarWidth, setSidebarWidth] = useState(() => load('sidebar.width', 190));

  const pdfRef = useRef<PdfHandle>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const version = useRef(0);
  const chipId = useRef(0);
  const live = useRef({ active, files });
  live.current = { active, files };

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  }, []);

  const refresh = useCallback(async () => {
    const st = await api.state();
    setName(st.name);
    setFiles(st.files);
    setMain(st.main);
    setCompiling(st.compiling);
    setCompile(st.compile);
    setAgents(st.agents);
    setThreads((await api.threads()).threads);
    setBusy(st.agentBusy);
    setActive((a) => a ?? st.main ?? st.files[0]?.path ?? null);
  }, []);

  // Live updates from the server.
  useEffect(() => {
    const onMsg = (msg: ServerMsg) => {
      if (msg.type === 'files') {
        setFiles(msg.files);
        setMain(msg.main);
      } else if (msg.type === 'compile') {
        if (msg.status === 'compiling') setCompiling(true);
        else {
          setCompiling(false);
          setCompile(msg.result);
        }
      } else if (msg.type === 'annotations') {
        setThreads(msg.threads);
      } else if (msg.type === 'fileChanged') {
        if (msg.path === live.current.active) {
          setDoc({ path: msg.path, content: msg.content, baseline: msg.baseline, version: ++version.current });
        }
      } else if (msg.type === 'agent') {
        const ev = msg.event;
        if (ev.kind === 'start') {
          setBusy(true);
          setMessages((ms) => [...ms, { role: 'assistant', agent: ev.agent, parts: [] }]);
        } else if (ev.kind === 'done') {
          setBusy(false);
          if (ev.error) setMessages((ms) => updateLast(ms, (m) => ({ ...m, error: ev.error })));
          // Bring the user to the agent's changes if they are in another file.
          const { active: current, files: list } = live.current;
          const pending = list.filter((f) => f.pending);
          if (pending.length && !pending.some((f) => f.path === current)) setActive(pending[0].path);
        } else {
          setMessages((ms) =>
            updateLast(ms, (m) => {
              const parts = [...m.parts];
              const last = parts[parts.length - 1];
              if (ev.kind === 'text') {
                if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + ev.text };
                else if (ev.text.trim()) parts.push({ type: 'text', text: ev.text });
              } else {
                parts.push({ type: 'tool', name: ev.name, detail: ev.detail });
              }
              return { ...m, parts };
            }),
          );
        }
      }
    };
    return connect(onMsg, (up) => {
      setConnected(up);
      if (up) void refresh().catch(() => {});
    });
  }, [refresh]);

  // Load the active file.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api.readFile(active).then(
      (f) => !cancelled && setDoc({ path: active, ...f, version: ++version.current }),
      (err) => !cancelled && flash(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [active, flash]);

  const onSave = useCallback(
    (path: string, content: string) => void api.writeFile(path, content).catch((e) => flash(`Could not save: ${e.message}`)),
    [flash],
  );
  const onBaseline = useCallback(
    (path: string, content: string) => void api.setBaseline(path, content).catch((e) => flash(e.message)),
    [flash],
  );

  const goTo = useCallback((path: string, line: number) => {
    setActive(path);
    setJump({ path, line, nonce: Date.now() + Math.random() });
  }, []);

  const showInPdf = useCallback(
    async (path: string, line: number) => {
      const { box } = await api.forward(path, line);
      if (box) pdfRef.current?.highlight(box);
      else flash('Could not find that line in the PDF.');
    },
    [flash],
  );

  const onReverse = useCallback(
    async (page: number, x: number, y: number) => {
      const { hit } = await api.reverse(page, x, y);
      if (hit) goTo(hit.path, hit.line);
      else flash('Could not find the source for that spot.');
    },
    [goTo, flash],
  );

  const onAsk = useCallback(async (sel: PdfSelection) => {
    const { hit } = await api.reverse(sel.page, sel.x, sel.y).catch(() => ({ hit: null }));
    const where = hit ? `${hit.path} line ${hit.line}` : 'source location unknown';
    setPdfChips((chips) => [
      ...chips,
      {
        id: ++chipId.current,
        label: `PDF p.${sel.page}${hit ? ` · ${basename(hit.path)}:${hit.line}` : ''} · “${clip(sel.text, 28)}”`,
        body: `Passage selected in the PDF (page ${sel.page}, ${where}): "${sel.text}"`,
        removable: true,
      },
    ]);
  }, []);

  // The editor selection is attached automatically while it exists.
  const chips: ContextChip[] = [...pdfChips];
  if (active && selection && selection.text.trim()) {
    const range =
      selection.fromLine === selection.toLine ? `${selection.fromLine}` : `${selection.fromLine}-${selection.toLine}`;
    chips.unshift({
      id: 0,
      label: `${basename(active)}:${range}`,
      body: `Text selected in the editor (${active} lines ${range}):\n${selection.text}`,
      removable: false,
    });
  }

  // The agent the next message goes to: the chosen one if installed, otherwise whichever is.
  const agent =
    agents.find((a) => a.name === agentChoice && a.available) ?? agents.find((a) => a.available) ?? agents[0] ?? null;
  const agentName = agent?.name ?? 'claude';
  useEffect(() => save('agent', agentChoice), [agentChoice]);

  const send = useCallback(
    (text: string, attached: ContextChip[] = []) => {
      const { active: current } = live.current;
      const context = [
        current ? `File open in the editor: ${current}${selection ? ` (cursor on line ${selection.line})` : ''}` : null,
        ...attached.map((c) => c.body),
      ].filter(Boolean);
      const prompt = context.length ? `<editor_context>\n${context.join('\n\n')}\n</editor_context>\n\n${text}` : text;
      setMessages((ms) => [...ms, { role: 'user', parts: [{ type: 'text', text }], attached: attached.map((c) => c.label) }]);
      setPdfChips([]);
      setBusy(true);
      api.send(agentName, prompt).catch((e) => {
        setBusy(false);
        flash(e.message);
      });
    },
    [selection, flash, agentName],
  );

  // ---------- comments and drawings ----------

  const sendThreads = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      const text = ids.length === 1 ? `Address comment #${ids[0]}.` : `Address comments ${ids.map((id) => `#${id}`).join(', ')}.`;
      setMessages((ms) => [...ms, { role: 'user', parts: [{ type: 'text', text }] }]);
      setBusy(true);
      api.sendThreads(agentName, ids).catch((e) => {
        setBusy(false);
        flash(e.message);
      });
    },
    [agentName, flash],
  );

  const createThread = useCallback(
    async (thread: NewThread, andSend: boolean) => {
      try {
        const { id } = await api.createThread(thread);
        setTab('comments');
        setActiveThread(id);
        if (andSend) sendThreads([id]);
      } catch (e) {
        flash(`Could not save the comment: ${(e as Error).message}`);
        throw e;
      }
    },
    [sendThreads, flash],
  );

  const activateThread = useCallback((id: number) => {
    setTab('comments');
    setActiveThread(id);
    pdfRef.current?.showThread(id);
  }, []);

  const openThreads = threads.filter((t) => !t.resolved);
  const shownThreads = showResolved ? threads : openThreads;

  const fixErrors = () => {
    if (!compile) return;
    const list = compile.errors
      .slice(0, 20)
      .map((e) => `- ${e.file ? `${e.file}:${e.line}: ` : ''}${e.message}`)
      .join('\n');
    send(`The LaTeX build is failing. Fix these errors:\n${list}`);
  };

  const newChat = () => {
    void api.reset();
    setMessages([]);
    setPdfChips([]);
  };

  // ---------- layout ----------

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const saved = allSizes[preset.id];
  const sizes = saved && saved.cols.length === preset.columns.length ? saved : defaultSizes(preset);
  const stackedCol = preset.columns.findIndex((col) => col.length > 1);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  useEffect(() => save('layout.preset', presetId), [presetId]);
  useEffect(() => save('layout.sizes', allSizes), [allSizes]);
  useEffect(() => save('sidebar.open', sidebarOpen), [sidebarOpen]);
  useEffect(() => save('sidebar.width', sidebarWidth), [sidebarWidth]);

  const setSizes = (next: Sizes) => setAllSizes((all) => ({ ...all, [preset.id]: next }));

  const drag = (onMove: (e: PointerEvent) => void, vertical = false) => (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add(vertical ? 'dragging-row' : 'dragging');
    const stop = () => {
      document.body.classList.remove('dragging', 'dragging-row');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
  };

  /** Drag the handle between column i and i+1: the two share their combined width. */
  const dragCol = (i: number) =>
    drag((e) => {
      const { cols, rows } = sizesRef.current;
      const rect = gridRef.current!.getBoundingClientRect();
      const avail = rect.width - HANDLE * (cols.length - 1);
      const total = cols.reduce((a, b) => a + b, 0);
      const px = cols.map((w) => (w / total) * avail);
      const left = rect.left + px.slice(0, i).reduce((a, b) => a + b, 0) + HANDLE * i;
      const pair = px[i] + px[i + 1];
      const min = Math.min(180, pair / 2);
      const first = Math.min(pair - min, Math.max(min, e.clientX - left));
      const next = [...cols];
      next[i] = (first / avail) * total;
      next[i + 1] = ((pair - first) / avail) * total;
      setSizes({ cols: next, rows });
    });

  const dragRow = drag((e) => {
    const rect = gridRef.current!.getBoundingClientRect();
    const avail = rect.height - HANDLE;
    const top = Math.min(avail - 120, Math.max(120, e.clientY - rect.top));
    setSizes({ cols: sizesRef.current.cols, rows: [top / avail, 1 - top / avail] });
  }, true);

  const dragSidebar = drag((e) => {
    const left = gridRef.current!.parentElement!.getBoundingClientRect().left;
    setSidebarWidth(Math.min(480, Math.max(120, e.clientX - left)));
  });

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: sizes.cols.map((w) => `minmax(0, ${w}fr)`).join(` ${HANDLE}px `),
    gridTemplateRows:
      stackedCol >= 0
        ? `minmax(0, ${sizes.rows[0]}fr) ${HANDLE}px minmax(0, ${sizes.rows[1]}fr)`
        : 'minmax(0, 1fr)',
  };

  /** Panes are always the same three siblings; only their grid position changes, so nothing remounts. */
  const place = (id: PaneId): React.CSSProperties => {
    const col = preset.columns.findIndex((c) => c.includes(id));
    const row = preset.columns[col].indexOf(id);
    return { gridColumn: 2 * col + 1, gridRow: col === stackedCol ? 2 * row + 1 : '1 / -1' };
  };

  const errors = compile?.errors ?? [];
  const warnings = compile?.warnings ?? [];
  const status = compiling
    ? { cls: 'busy', text: 'Building…' }
    : !compile
      ? { cls: '', text: 'Not built yet' }
      : errors.length
        ? { cls: 'bad', text: `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}` }
        : warnings.length
          ? { cls: 'warn', text: `Built, ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` }
          : { cls: 'good', text: `Built in ${(compile.durationMs / 1000).toFixed(1)} s` };

  return (
    <div className="app">
      <header className="topbar">
        <button
          className={`btn small icon ${sidebarOpen ? 'on' : ''}`}
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? 'Hide file list' : 'Show file list'}
          aria-label={sidebarOpen ? 'Hide file list' : 'Show file list'}
          aria-pressed={sidebarOpen}
        >
          <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
            <rect x="0.5" y="0.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
            <rect x="0.5" y="0.5" width="4.5" height="11" rx="2" fill="currentColor" opacity={sidebarOpen ? 0.55 : 0.15} />
          </svg>
        </button>
        <span className="brand">Paper Assistant</span>
        <span className="project">{name}</span>
        <span className="spacer" />
        <select
          className="theme-select"
          value={theme}
          onChange={(e) => {
            const id = e.target.value as ThemeId;
            setTheme(id);
            applyTheme(id);
          }}
          aria-label="Colour theme"
          title="Colour theme"
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="presets" role="group" aria-label="Pane layout">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset ${p.id === preset.id ? 'active' : ''}`}
              onClick={() => setPresetId(p.id)}
              title={`Layout: ${p.label}`}
              aria-label={`Layout: ${p.label}`}
              aria-pressed={p.id === preset.id}
            >
              {p.columns.map((col, i) => (
                <span key={i} className="mini-col">
                  {col.map((id) => (
                    <span key={id} className={`mini-cell ${id}`}>
                      {PANE_LETTER[id]}
                    </span>
                  ))}
                </span>
              ))}
            </button>
          ))}
        </div>
        {!connected && <span className="status bad">Disconnected from server</span>}
        <button className={`status ${status.cls}`} onClick={() => setShowLog((v) => !v)} title="Show build output">
          {status.text}
        </button>
        <button className="btn small" onClick={() => void api.compile()} disabled={compiling}>
          Rebuild
        </button>
      </header>

      <div className="body">
        {sidebarOpen && (
          <>
            <nav className="sidebar" style={{ width: sidebarWidth }}>
              <div className="sidebar-title">Files</div>
              {files.map((f) => (
                <button
                  key={f.path}
                  className={`file ${f.path === active ? 'active' : ''}`}
                  onClick={() => setActive(f.path)}
                  title={f.pending ? `${f.path} (unreviewed changes)` : f.path}
                >
                  <span className="file-name">{f.path}</span>
                  {f.path === main && <span className="tag">main</span>}
                  {f.pending && <span className="dot" aria-label="unreviewed changes" />}
                </button>
              ))}
              {files.length === 0 && <div className="empty small">No .tex files in this folder.</div>}
            </nav>
            <div className="handle" onPointerDown={dragSidebar} />
          </>
        )}

        <div className="grid" ref={gridRef} style={gridStyle}>
          <div className="cell editor-cell" style={place('editor')}>
            <Editor
              doc={doc}
              jump={jump}
              onSave={onSave}
              onBaseline={onBaseline}
              onShowInPdf={showInPdf}
              onSelection={setSelection}
            />
            {showLog && (
              <div className="log">
                <div className="pane-bar">
                  <span className="pane-title">Build output</span>
                  {compile && <span className="muted">{compile.engine}</span>}
                  <span className="spacer" />
                  {errors.length > 0 && (
                    <button className="btn small primary" onClick={fixErrors} disabled={busy}>
                      Fix with agent
                    </button>
                  )}
                  <button className="btn small" onClick={() => setShowLog(false)}>
                    Close
                  </button>
                </div>
                <div className="log-body">
                  {errors.map((e, i) => (
                    <button
                      key={`e${i}`}
                      className="issue bad"
                      disabled={!e.file || !e.line || !files.some((f) => f.path === e.file)}
                      onClick={() => e.file && e.line && goTo(e.file, e.line)}
                    >
                      <span className="issue-where">{e.file ? `${e.file}:${e.line}` : 'error'}</span>
                      {e.message}
                    </button>
                  ))}
                  {warnings.map((w, i) => (
                    <div key={`w${i}`} className="issue warn">
                      {w}
                    </div>
                  ))}
                  {compile && errors.length === 0 && warnings.length === 0 && (
                    <div className="issue">No errors or warnings.</div>
                  )}
                  {compile?.log && (
                    <details>
                      <summary>Full log</summary>
                      <pre>{compile.log}</pre>
                    </details>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="cell" style={place('pdf')}>
            <PdfView
              ref={pdfRef}
              version={compile?.hasPdf ? compile.pdfVersion : 0}
              threads={shownThreads}
              activeThread={activeThread}
              onReverse={onReverse}
              onAsk={onAsk}
              onThreadClick={activateThread}
              onCreate={createThread}
            />
          </div>
          <div className="cell" style={place('chat')}>
            <div className="pane">
              <div className="pane-bar">
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={tab === 'chat'} className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
                    Agent
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'comments'}
                    className={`tab ${tab === 'comments' ? 'active' : ''}`}
                    onClick={() => setTab('comments')}
                  >
                    Comments
                    {openThreads.length > 0 && <span className="count">{openThreads.length}</span>}
                  </button>
                </div>
                <select
                  className="agent-select"
                  value={agentName}
                  onChange={(e) => setAgentChoice(e.target.value)}
                  disabled={busy}
                  aria-label="Agent"
                  title="Which agent handles your messages and comments"
                >
                  {agents.map((a) => (
                    <option key={a.name} value={a.name} disabled={!a.available}>
                      {a.label}
                      {a.available ? '' : ' (not installed)'}
                    </option>
                  ))}
                </select>
                <span className="spacer" />
                {tab === 'chat' ? (
                  <button className="btn small" onClick={newChat} disabled={busy || messages.length === 0}>
                    New chat
                  </button>
                ) : (
                  <>
                    {threads.length > openThreads.length && (
                      <label className="check">
                        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                        Resolved
                      </label>
                    )}
                    {busy ? (
                      <button className="btn small" onClick={() => void api.stop()}>
                        Stop
                      </button>
                    ) : (
                      <button
                        className="btn small primary"
                        onClick={() => sendThreads(openThreads.map((t) => t.id))}
                        disabled={openThreads.length === 0}
                        title="Have the agent work through every open comment"
                      >
                        Send all
                      </button>
                    )}
                  </>
                )}
              </div>
              <Chat
                hidden={tab !== 'chat'}
                messages={messages}
                busy={busy}
                chips={chips}
                onRemoveChip={(id) => setPdfChips((cs) => cs.filter((c) => c.id !== id))}
                onSend={(text) => send(text, chips)}
                onStop={() => void api.stop()}
              />
              {tab === 'comments' && (
                <>
                  <Comments
                    threads={threads}
                    showResolved={showResolved}
                    activeId={activeThread}
                    busy={busy}
                    onActivate={activateThread}
                    onGoToSource={goTo}
                    onReply={(id, text) => void api.replyToThread(id, text).catch((e) => flash(e.message))}
                    onSend={sendThreads}
                    onResolve={(id, resolved) => void api.resolveThread(id, resolved).catch((e) => flash(e.message))}
                    onDelete={(id) => void api.deleteThread(id).catch((e) => flash(e.message))}
                  />
                  {busy && <div className="working bar">{agent?.label ?? 'Agent'} is working…</div>}
                </>
              )}
            </div>
          </div>
          {sizes.cols.slice(1).map((_, i) => (
            <div key={i} className="handle" style={{ gridColumn: 2 * i + 2, gridRow: '1 / -1' }} onPointerDown={dragCol(i)} />
          ))}
          {stackedCol >= 0 && (
            <div className="handle row" style={{ gridColumn: 2 * stackedCol + 1, gridRow: 2 }} onPointerDown={dragRow} />
          )}
        </div>
      </div>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function updateLast(messages: Message[], fn: (m: Message) => Message): Message[] {
  if (messages.length === 0) return messages;
  const copy = [...messages];
  copy[copy.length - 1] = fn(copy[copy.length - 1]);
  return copy;
}
