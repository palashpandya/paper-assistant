import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connect, type CompileResult, type NewThread, type ServerMsg, type Thread } from './api';
import { PdfView, type PdfHandle, type PdfSelection } from './PdfView';
import { openChannel, type TabChannel } from './tabChannel';
import { savedTheme } from './themes';

const basename = (p: string) => p.split('/').pop()!;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The PDF pane on its own, for a second tab or window. The main window keeps the editor and the agent. */
export function PdfTab() {
  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const pdfRef = useRef<PdfHandle>(null);
  const channel = useRef<TabChannel | null>(null);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  }, []);

  useEffect(() => {
    const refresh = async () => {
      const st = await api.state();
      document.title = `${st.name} · PDF`;
      setCompile(st.compile);
      setThreads((await api.threads()).threads);
    };
    const onMsg = (msg: ServerMsg) => {
      if (msg.type === 'compile' && msg.status === 'done') setCompile(msg.result);
      else if (msg.type === 'annotations') setThreads(msg.threads);
    };
    return connect(onMsg, (up) => {
      if (up) void refresh().catch(() => {});
    });
  }, []);

  useEffect(() => {
    const ch = openChannel((msg) => {
      if (msg.type === 'ping') ch?.post({ type: 'hello' });
      else if (msg.type === 'close') window.close();
      else if (msg.type === 'highlight') pdfRef.current?.highlight(msg.box);
      else if (msg.type === 'showThread') pdfRef.current?.showThread(msg.id);
      else if (msg.type === 'view') {
        setActiveThread(msg.activeThread);
        setShowResolved(msg.showResolved);
      }
    });
    channel.current = ch;
    ch?.post({ type: 'hello' });
    const bye = () => ch?.post({ type: 'bye' });
    // A page restored from the back/forward cache has to announce itself again.
    const back = (e: PageTransitionEvent) => e.persisted && ch?.post({ type: 'hello' });
    window.addEventListener('pagehide', bye);
    window.addEventListener('pageshow', back);
    return () => {
      window.removeEventListener('pagehide', bye);
      window.removeEventListener('pageshow', back);
      bye();
      ch?.close();
    };
  }, []);

  // Follow theme changes made in the main window.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'paper-assistant.theme') document.documentElement.dataset.theme = savedTheme();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const onReverse = useCallback(
    async (page: number, x: number, y: number) => {
      const { hit } = await api.reverse(page, x, y);
      if (hit) channel.current?.post({ type: 'goto', path: hit.path, line: hit.line });
      else flash('Could not find the source for that spot.');
    },
    [flash],
  );

  const onAsk = useCallback(
    async (sel: PdfSelection) => {
      const { hit } = await api.reverse(sel.page, sel.x, sel.y).catch(() => ({ hit: null }));
      const where = hit ? `${hit.path} line ${hit.line}` : 'source location unknown';
      channel.current?.post({
        type: 'ask',
        label: `PDF p.${sel.page}${hit ? ` · ${basename(hit.path)}:${hit.line}` : ''} · “${clip(sel.text, 28)}”`,
        body: `Passage selected in the PDF (page ${sel.page}, ${where}): "${sel.text}"`,
      });
      flash('Added to your next message in the main window.');
    },
    [flash],
  );

  const onCreate = useCallback(
    async (thread: NewThread, send: boolean) => {
      try {
        const { id } = await api.createThread(thread);
        setActiveThread(id);
        channel.current?.post({ type: 'created', id, send });
      } catch (e) {
        flash(`Could not save the comment: ${(e as Error).message}`);
        throw e;
      }
    },
    [flash],
  );

  const onThreadClick = useCallback((id: number) => {
    setActiveThread(id);
    channel.current?.post({ type: 'thread', id });
  }, []);

  return (
    <div className="app">
      <PdfView
        ref={pdfRef}
        version={compile?.hasPdf ? compile.pdfVersion : 0}
        threads={showResolved ? threads : threads.filter((t) => !t.resolved)}
        activeThread={activeThread}
        onReverse={onReverse}
        onAsk={onAsk}
        onThreadClick={onThreadClick}
        onCreate={onCreate}
      />
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}
