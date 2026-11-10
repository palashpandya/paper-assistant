import { useEffect, useRef, useState } from 'react';
import type { Thread } from './api';
import { Markdown } from './Markdown';

interface Props {
  threads: Thread[];
  showResolved: boolean;
  activeId: number | null;
  busy: boolean;
  onActivate: (id: number) => void;
  onGoToSource: (path: string, line: number) => void;
  onReply: (id: number, text: string) => void;
  onSend: (ids: number[]) => void;
  onResolve: (id: number, resolved: boolean) => void;
  onDelete: (id: number) => void;
}

const basename = (p: string) => p.split('/').pop()!;

export function Comments({ threads, showResolved, activeId, busy, onActivate, onGoToSource, onReply, onSend, onResolve, onDelete }: Props) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const visible = threads.filter((t) => showResolved || !t.resolved);

  // Bring the thread that was clicked in the PDF into view.
  useEffect(() => {
    if (activeId !== null) {
      listRef.current?.querySelector(`[data-thread="${activeId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeId]);

  const reply = (id: number, send: boolean) => {
    const text = (drafts[id] ?? '').trim();
    if (text) onReply(id, text);
    setDrafts((d) => ({ ...d, [id]: '' }));
    if (send) onSend([id]);
  };

  return (
    <div className="comments" ref={listRef}>
      {visible.length === 0 && (
        <div className="empty">
          {threads.length === 0 ? (
            <>
              No comments yet.
              <br />
              <br />
              Select text in the PDF and choose Comment, or use Draw to mark up a page. Comments stay with the paper,
              and the agent can work through them. You can also ask the agent to review the paper and leave comments
              of its own.
            </>
          ) : (
            'All comments are resolved.'
          )}
        </div>
      )}
      {visible.map((t) => {
        const waiting = t.messages.length > 0 && t.messages[t.messages.length - 1].author === 'user';
        return (
          <div
            key={t.id}
            data-thread={t.id}
            className={`thread-card ${t.id === activeId ? 'active' : ''} ${t.resolved ? 'resolved' : ''}`}
            onClick={() => onActivate(t.id)}
          >
            <div className="thread-head">
              <span className="thread-num">{t.id}</span>
              {t.rects.length + t.strokes.length > 0 ? (
                <span className="muted">p.{t.view.page}</span>
              ) : (
                <span className="muted" title="These source lines could not be located in the PDF">not in PDF</span>
              )}
              {t.anchor && (
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onGoToSource(t.anchor!.path, t.anchor!.line);
                  }}
                  title="Go to this place in the source"
                >
                  {basename(t.anchor.path)}:{t.anchor.line}
                </button>
              )}
              <span className="spacer" />
              {t.resolved && <span className="badge good">Resolved{t.resolvedBy === 'agent' ? ' by agent' : ''}</span>}
              {!t.resolved && t.view.stale && (
                <span className="badge warn" title="The text this pointed at has changed, so its position in the PDF may be off">
                  Moved
                </span>
              )}
            </div>

            {(t.kind === 'comment' || t.author === 'agent') && t.quote && (
              <div className={`thread-quote ${t.author === 'agent' ? 'source' : ''}`}>{t.quote}</div>
            )}
            {t.kind === 'drawing' && t.image && <img className="thread-image" src={`/api/annotations/${t.id}/image`} alt={`Drawing on page ${t.page}`} />}

            {t.messages.map((m, i) => (
              <div key={i} className={`thread-msg ${m.author}`}>
                <div className="thread-author">{m.author === 'user' ? 'You' : (m.agent ?? 'Agent')}</div>
                <Markdown text={m.text} user={m.author === 'user'} />
              </div>
            ))}

            <div className="thread-actions" onClick={(e) => e.stopPropagation()}>
              {!t.resolved && (
                <>
                  <textarea
                    rows={1}
                    value={drafts[t.id] ?? ''}
                    placeholder="Reply…"
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        reply(t.id, false);
                      }
                    }}
                  />
                  <div className="thread-buttons">
                    <button
                      className={`btn small ${waiting || (drafts[t.id] ?? '').trim() ? 'primary' : ''}`}
                      onClick={() => reply(t.id, true)}
                      disabled={busy}
                      title="Have the agent deal with this comment"
                    >
                      Send to agent
                    </button>
                    <button className="btn small ok" onClick={() => onResolve(t.id, true)}>
                      Resolve
                    </button>
                    <span className="spacer" />
                    <button className="btn small quiet" onClick={() => onDelete(t.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
              {t.resolved && (
                <div className="thread-buttons">
                  <button className="btn small" onClick={() => onResolve(t.id, false)}>
                    Reopen
                  </button>
                  <span className="spacer" />
                  <button className="btn small quiet" onClick={() => onDelete(t.id)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
