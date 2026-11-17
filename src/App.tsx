import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connect, type AgentInfo, type AgentOptions, type ChatSummary, type ClaudeAccount, type CompileResult, type FileInfo, type NewThread, type ServerMsg, type Thread } from './api';
import { Comments } from './Comments';
import { Chat, type ContextChip, type Message } from './Chat';
import { Editor, type EditorDoc, type EditorSelection } from './Editor';
import { PdfView, type PdfHandle, type PdfSelection } from './PdfView';
import { THEMES, applyTheme, savedTheme, type ThemeId } from './themes';
import { openChannel, openPdfTab, type TabChannel, type TabMsg } from './tabChannel';
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
  /** The app was closed (Quit here, or `paper-assistant stop`): nothing more will come from the server. */
  const [stopped, setStopped] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [tab, setTab] = useState<'chat' | 'comments'>('chat');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentChoice, setAgentChoice] = useState(() => load('agent', 'claude'));
  const [agentSettings, setAgentSettings] = useState<Record<string, AgentOptions>>(() => load('agent.settings', {}));
  const [presetId, setPresetId] = useState(() => load('layout.preset', PRESETS[0].id));
  const [allSizes, setAllSizes] = useState<Record<string, Sizes>>(() => load('layout.sizes', {}));
  const [sidebarOpen, setSidebarOpen] = useState(() => load('sidebar.open', true));
  const [sidebarWidth, setSidebarWidth] = useState(() => load('sidebar.width', 190));
  // True while the PDF is shown in its own tab instead of in this window.
  const [detached, setDetached] = useState(false);
  // Saved conversations, while the History list is open.
  const [history, setHistory] = useState<{ current: string; chats: ChatSummary[]; next: number | null } | null>(null);
  const loadingHistory = useRef(false);
  // Claude Code logins on this machine, and the one this paper uses.
  const [accounts, setAccounts] = useState<{ list: ClaudeAccount[]; current: string | null }>({ list: [], current: null });
  // Which agent's conversations the History list shows: 'all' or an agent's name.
  const [historyFilter, setHistoryFilter] = useState(() => load('history.filter', 'all'));
  const historyFilterRef = useRef(historyFilter);
  historyFilterRef.current = historyFilter;

  const pdfRef = useRef<PdfHandle>(null);
  const channel = useRef<TabChannel | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const version = useRef(0);
  const [reloadFile, setReloadFile] = useState(0);
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
    setAccounts({ list: st.claudeAccounts, current: st.claudeConfig });
    setActive((a) => st.files.some((f) => f.path === a) ? a : st.main ?? st.files[0]?.path ?? null);
    setReloadFile((n) => n + 1);
    setThreads((await api.threads()).threads);
    setBusy(st.agentBusy);
    // The server keeps the conversation, so a reload or a restart picks it up where it was.
    setMessages((await api.chat()).messages);
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
      } else if (msg.type === 'quit') {
        setStopped(true);
        channel.current?.post({ type: 'close' });
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
      if (up) {
        setStopped(false); // Started again: carry on in this tab.
        void refresh().catch(() => {});
      }
    });
  }, [refresh]);

  // Load the active file.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const requestedVersion = version.current;
    api.readFile(active).then(
      (f) => !cancelled && requestedVersion === version.current && setDoc({ path: active, ...f, version: ++version.current }),
      (err) => !cancelled && flash(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [active, flash, reloadFile]);

  const onSave = useCallback(
    (path: string, content: string, expected: string) => api.writeFile(path, content, expected),
    [],
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
      if (!box) flash('Could not find that line in the PDF.');
      else if (detached) channel.current?.post({ type: 'highlight', box });
      else pdfRef.current?.highlight(box);
    },
    [flash, detached],
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
  const agentOptions = agentSettings[agentName] ?? {};
  const efforts = agent?.models.find((m) => m.id === agentOptions.model)?.efforts ?? agent?.efforts ?? [];
  const updateAgentOptions = (options: AgentOptions) => {
    setAgentSettings((settings) => ({ ...settings, [agentName]: options }));
  };
  useEffect(() => save('agent', agentChoice), [agentChoice]);
  useEffect(() => save('agent.settings', agentSettings), [agentSettings]);

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
      api.send(agentName, prompt, text, attached.map((c) => c.label), agentOptions).catch((e) => {
        setBusy(false);
        flash(e.message);
      });
    },
    [selection, flash, agentName, agentOptions],
  );

  // ---------- comments and drawings ----------

  const sendThreads = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      const text = ids.length === 1 ? `Address comment #${ids[0]}.` : `Address comments ${ids.map((id) => `#${id}`).join(', ')}.`;
      setMessages((ms) => [...ms, { role: 'user', parts: [{ type: 'text', text }] }]);
      setBusy(true);
      api.sendThreads(agentName, ids, agentOptions).catch((e) => {
        setBusy(false);
        flash(e.message);
      });
    },
    [agentName, flash, agentOptions],
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

  const activateThread = useCallback(
    (id: number) => {
      setTab('comments');
      setActiveThread(id);
      if (detached) channel.current?.post({ type: 'showThread', id });
      else pdfRef.current?.showThread(id);
    },
    [detached],
  );

  // ---------- PDF in a separate tab ----------

  // The PDF tab does its own rendering and SyncTeX lookups; what it sends here is what the editor and agent panes need.
  const onTabMsg = useRef<(msg: TabMsg) => void>(() => {});
  onTabMsg.current = (msg) => {
    if (msg.type === 'goto') goTo(msg.path, msg.line);
    else if (msg.type === 'ask') {
      setPdfChips((cs) => [...cs, { id: ++chipId.current, label: msg.label, body: msg.body, removable: true }]);
    } else if (msg.type === 'thread') {
      setTab('comments');
      setActiveThread(msg.id);
    } else if (msg.type === 'created') {
      setTab('comments');
      setActiveThread(msg.id);
      if (msg.send) sendThreads([msg.id]);
    }
  };

  useEffect(() => {
    let leaving: ReturnType<typeof setTimeout> | undefined;
    const ch = openChannel((msg) => {
      if (msg.type === 'hello') {
        clearTimeout(leaving);
        setDetached(true);
      } else if (msg.type === 'bye') {
        // A reload of the PDF tab says bye and then hello; wait before taking the PDF back.
        clearTimeout(leaving);
        leaving = setTimeout(() => setDetached(false), 1500);
      } else onTabMsg.current(msg);
    });
    channel.current = ch;
    ch?.post({ type: 'ping' }); // Finds a PDF tab left open from before this window loaded.
    return () => {
      clearTimeout(leaving);
      ch?.close();
    };
  }, []);

  useEffect(() => {
    if (detached) channel.current?.post({ type: 'view', activeThread, showResolved });
  }, [detached, activeThread, showResolved]);

  const detachPdf = useCallback(() => {
    if (!channel.current || !openPdfTab()) flash('The browser blocked the new tab.');
  }, [flash]);

  const quit = () => {
    if (busy && !window.confirm('The agent is still working. Quit and stop it?')) return;
    // Leave a moment for the last keystrokes to be saved.
    setTimeout(() => void api.quit().catch(() => {}), 400);
  };

  const dockPdf = () => {
    channel.current?.post({ type: 'close' });
    setDetached(false);
  };

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
    setHistory(null);
  };

  /** Run Claude Code under another login. Its conversations are separate, so this starts a new chat. */
  const chooseAccount = (dir: string | null) => {
    setHistory(null);
    api.setClaudeConfig(dir).then(
      () => {
        setPdfChips([]);
        void refresh();
      },
      (e) => flash(e.message),
    );
  };

  const toggleHistory = () => {
    if (history) setHistory(null);
    else void api.chats(0, historyFilter).then(setHistory, (e) => flash(e.message));
  };

  const filterHistory = (filter: string) => {
    setHistoryFilter(filter);
    save('history.filter', filter);
    api.chats(0, filter).then(
      (page) => {
        if (historyFilterRef.current !== filter) return; // Changed again meanwhile.
        setHistory((h) => h && page);
        historyRef.current?.scrollTo(0, 0);
      },
      (e) => flash(e.message),
    );
  };

  /** The list is long in a folder with a lot of past sessions, so further pages load as it is scrolled. */
  const historyRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyOpen = history !== null;

  useEffect(() => {
    if (!historyOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node &&
          !historyRef.current?.contains(event.target) &&
          !historyButtonRef.current?.contains(event.target)) {
        setHistory(null);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistory(null);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [historyOpen]);

  const moreHistory = () => {
    const el = historyRef.current;
    if (!el || !history || history.next === null || loadingHistory.current) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 80) return;
    loadingHistory.current = true;
    const filter = historyFilter;
    api
      .chats(history.next, filter)
      .then((page) =>
        setHistory((h) =>
          // A page that was asked for before the filter changed belongs to another list.
          h && historyFilterRef.current === filter
            ? { ...page, chats: [...h.chats, ...page.chats.filter((c) => !h.chats.some((o) => o.id === c.id))] }
            : h,
        ),
      )
      .catch((err) => flash(err.message))
      .finally(() => (loadingHistory.current = false));
  };

  // A page can come back too short to scroll (sessions with nothing in them are skipped); then fetch on.
  useEffect(moreHistory, [history]);

  /** Switch to a saved conversation; the agent's next turn resumes its session from then. */
  const openChat = (id: string) => {
    setHistory(null);
    api.openChat(id).then(
      (chat) => {
        setMessages(chat.messages);
        setPdfChips([]);
        // Only the agent it was held with remembers it.
        if (chat.agent) setAgentChoice(chat.agent);
      },
      (e) => flash(e.message),
    );
  };

  const deleteChat = (id: string) => {
    api.deleteChat(id).then(
      () => {
        if (id === history?.current) setMessages([]);
        setHistory((h) => h && { ...h, chats: h.chats.filter((c) => c.id !== id) });
      },
      (e) => flash(e.message),
    );
  };

  // ---------- layout ----------

  const chosen = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  // With the PDF in its own tab, the same arrangement is used without the PDF pane, with its own saved sizes.
  const preset = detached
    ? {
        ...chosen,
        id: `${chosen.id}/no-pdf`,
        columns: chosen.columns.map((col) => col.filter((id) => id !== 'pdf')).filter((col) => col.length > 0),
      }
    : chosen;
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
    if (col < 0) return { display: 'none' }; // The PDF pane while it is in its own tab; it stays mounted.
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
      {stopped && (
        <div className="stopped">
          <div className="stopped-box">
            <strong>Paper Assistant has been closed.</strong>
            <p>
              Your paper is saved. To open it again, run <code>paper-assistant</code> in its folder; this tab will pick up where it was. Otherwise you
              can close the tab.
            </p>
          </div>
        </div>
      )}
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
        {accounts.list.length > 1 && (
          <select
            className="theme-select account"
            value={accounts.current ?? ''}
            onChange={(e) => chooseAccount(e.target.value || null)}
            disabled={busy}
            aria-label="Claude Code login"
            title="Which Claude Code login the agent runs under. Each login has its own conversation history."
          >
            {accounts.list.map((a) => (
              <option key={a.dir ?? ''} value={a.dir ?? ''}>
                Claude: {a.email ?? a.folder}
                {a.email ? ` (${a.folder})` : ''}
              </option>
            ))}
          </select>
        )}
        <div className="presets" role="group" aria-label="Pane layout">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset ${p.id === chosen.id ? 'active' : ''}`}
              onClick={() => setPresetId(p.id)}
              title={`Layout: ${p.label}`}
              aria-label={`Layout: ${p.label}`}
              aria-pressed={p.id === chosen.id}
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
        {detached && (
          <button className="btn small" onClick={dockPdf} title="Close the PDF tab and show the PDF in this window again">
            Dock PDF
          </button>
        )}
        {!connected && !stopped && <span className="status bad">Disconnected from server</span>}
        <button className={`status ${status.cls}`} onClick={() => setShowLog((v) => !v)} title="Show build output">
          {status.text}
        </button>
        <button className="btn small" onClick={() => void api.compile()} disabled={compiling}>
          Rebuild
        </button>
        <button className="btn small" onClick={quit} title="Close Paper Assistant. Start it again with the paper-assistant command.">
          Quit
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
              version={compile?.hasPdf && !detached ? compile.pdfVersion : 0}
              threads={shownThreads}
              activeThread={activeThread}
              onReverse={onReverse}
              onAsk={onAsk}
              onThreadClick={activateThread}
              onCreate={createThread}
              onDetach={detachPdf}
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
                  <>
                    <button
                      ref={historyButtonRef}
                      className={`btn small icon ${history ? 'active' : ''}`}
                      onClick={toggleHistory}
                      aria-expanded={!!history}
                      title="History: continue an earlier conversation"
                      aria-label="History: continue an earlier conversation"
                    >
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                        <circle cx="6.5" cy="6.5" r="5.2" />
                        <path d="M6.5 3.6v3.1l2 1.3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      className="btn small icon"
                      onClick={newChat}
                      disabled={busy || messages.length === 0}
                      title="New chat (this one is kept under History)"
                      aria-label="New chat"
                    >
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                        <path d="M6.5 2.5v8M2.5 6.5h8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </>
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
              <div className="agent-settings">
                <label>
                  Model
                  <input
                    aria-label="Model"
                    list="agent-models"
                    placeholder="Default model"
                    value={agentOptions.model ?? ''}
                    onChange={(e) => updateAgentOptions({ model: e.target.value, effort: '' })}
                    disabled={busy}
                    title="Choose a model or enter a model ID. Leave empty to use the agent's default."
                  />
                  <datalist id="agent-models">
                    {agent?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </datalist>
                </label>
                <label>
                  Effort
                  <select
                    aria-label="Effort"
                    value={agentOptions.effort ?? ''}
                    onChange={(e) => updateAgentOptions({ ...agentOptions, effort: e.target.value })}
                    disabled={busy}
                    title="Reasoning effort for the next message or comment request"
                  >
                    <option value="">Default effort</option>
                    {efforts.map((effort) => <option key={effort} value={effort}>{effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1)}</option>)}
                  </select>
                </label>
              </div>
              {history && tab === 'chat' && (
                <div className="history" ref={historyRef} onScroll={moreHistory}>
                  <div className="history-filter" role="group" aria-label="Show conversations with">
                    {[{ name: 'all', label: 'All' }, ...agents].map((a) => (
                      <button
                        key={a.name}
                        className={`btn small ${historyFilter === a.name ? 'active' : ''}`}
                        onClick={() => filterHistory(a.name)}
                        aria-pressed={historyFilter === a.name}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                  {history.chats.length === 0 && (
                    <div className="empty small">
                      {historyFilter === 'all' ? 'No earlier conversations.' : 'No earlier conversations with this agent.'}
                    </div>
                  )}
                  {history.chats.map((c) => (
                    <div key={c.id} className={`history-row ${c.id === history.current ? 'current' : ''}`}>
                      <button
                        className="history-open"
                        onClick={() => openChat(c.id)}
                        disabled={busy}
                        title={busy ? 'Wait for the agent to finish' : 'Continue this conversation'}
                      >
                        <span className="history-title">{c.title || 'Untitled'}</span>
                        <span className="muted">
                          {new Date(c.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                          {c.id === history.current ? ' · open now' : ''}
                          {c.source !== 'app' ? ` · ${c.label}${c.folder ? ` in ${c.folder}/` : ''}` : ''}
                        </span>
                      </button>
                      <button
                        className="btn small quiet"
                        onClick={() => deleteChat(c.id)}
                        disabled={busy && c.id === history.current}
                        title="Remove from this list"
                        aria-label={`Remove conversation from the list: ${c.title || 'Untitled'}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {history.next !== null && <div className="empty small">Scroll for earlier conversations…</div>}
                </div>
              )}
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
