import { useEffect, useRef, useState } from 'react';
import { Markdown, hasMath } from './Markdown';

export type Part = { type: 'text'; text: string } | { type: 'tool'; name: string; detail: string };

export interface Message {
  role: 'user' | 'assistant';
  /** Which agent wrote an assistant message. */
  agent?: string;
  parts: Part[];
  /** Labels of the context that was attached to a user message. */
  attached?: string[];
  error?: string;
}

export interface ContextChip {
  id: number;
  label: string;
  /** The text sent to the agent. */
  body: string;
  removable: boolean;
}

interface Props {
  messages: Message[];
  busy: boolean;
  chips: ContextChip[];
  onRemoveChip: (id: number) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  hidden: boolean;
}

const TOOL_VERBS: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edited',
  Write: 'Wrote',
  Glob: 'Searched files',
  Grep: 'Searched for',
};

export function Chat({ messages, busy, chips, onRemoveChip, onSend, onStop, hidden }: Props) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    stick.current = true;
    onSend(text);
    setDraft('');
  };

  return (
    <div className="chat-pane" style={hidden ? { display: 'none' } : undefined}>
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 && (
          <div className="empty">
            Ask the agent to edit the paper. It works on the same files you see, and its edits show up in the editor
            as changes you can accept or reject.
            <br />
            <br />
            Select text in the editor or the PDF to point it at a passage.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' && m.agent && <div className="msg-agent">{m.agent}</div>}
            {m.attached && m.attached.length > 0 && (
              <div className="chips">
                {m.attached.map((label, j) => (
                  <span key={j} className="chip">
                    {label}
                  </span>
                ))}
              </div>
            )}
            {m.parts.map((p, j) =>
              p.type === 'text' ? (
                <div key={j} className="msg-text">
                  <Markdown text={p.text.trim()} user={m.role === 'user'} />
                </div>
              ) : (
                <div key={j} className="msg-tool">
                  {TOOL_VERBS[p.name] ?? p.name} <code>{p.detail}</code>
                </div>
              ),
            )}
            {m.role === 'assistant' && busy && i === messages.length - 1 && <div className="working">Working…</div>}
            {m.error && <div className="msg-error">{m.error}</div>}
          </div>
        ))}
      </div>

      <div className="composer">
        {chips.length > 0 && (
          <div className="chips">
            {chips.map((c) => (
              <span key={c.id} className="chip" title={c.body}>
                {c.label}
                {c.removable && (
                  <button className="chip-x" onClick={() => onRemoveChip(c.id)} aria-label={`Remove ${c.label}`}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {hasMath(draft) && (
          <div className="preview" aria-label="Preview of your message">
            <Markdown text={draft} user />
          </div>
        )}
        <textarea
          value={draft}
          placeholder="Ask the agent to change the paper…"
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <span className="muted hint">Enter to send, Shift+Enter for a new line</span>
          <span className="spacer" />
          {busy ? (
            <button className="btn" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
