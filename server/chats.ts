import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from './agent.ts';

export type ChatPart = { type: 'text'; text: string } | { type: 'tool'; name: string; detail: string };

/** One chat bubble, in the shape the front end renders (Message in src/Chat.tsx). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  agent?: string;
  parts: ChatPart[];
  attached?: string[];
  error?: string;
}

export interface Chat {
  id: string;
  title: string;
  updatedAt: string;
  /** Each CLI's own session id for this conversation, which is what lets it be resumed later. */
  sessions: Record<string, string | null>;
  messages: ChatMessage[];
}

const MAX_CHATS = 50;

/**
 * Agent conversations, stored in the project under .paper-assistant/chats.json.
 * The agents' memory of a conversation lives in the CLIs' own session stores;
 * this keeps what was shown in the chat and the session ids needed to resume it.
 */
export class Chats {
  private chats: Chat[] = [];
  /** CLI sessions the user removed from the list. The CLI still has them; they are just not offered again. */
  private hidden: string[] = [];
  current: Chat;
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, '.paper-assistant', 'chats.json');
    let currentId: unknown = null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data.chats)) this.chats = data.chats;
      if (Array.isArray(data.hidden)) this.hidden = data.hidden;
      currentId = data.current;
    } catch {
      // No saved conversations yet.
    }
    this.current = this.chats.find((c) => c.id === currentId) ?? this.blank();
  }

  private blank(): Chat {
    return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', updatedAt: new Date().toISOString(), sessions: {}, messages: [] };
  }

  /** Writes the conversations to disk. An empty conversation is not worth keeping. */
  save() {
    const cur = this.current;
    if (cur.messages.length && !this.chats.includes(cur)) this.chats.push(cur);
    this.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.chats = this.chats.slice(0, MAX_CHATS);
    if (!this.chats.length && !this.hidden.length && !fs.existsSync(this.file)) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ current: cur.id, hidden: this.hidden, chats: this.chats }, null, 2));
  }

  list() {
    // `agents`: the agents that took part, i.e. the ones that can pick the conversation up again.
    return this.chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, agents: Object.keys(c.sessions).filter((a) => c.sessions[a]) }));
  }

  /** Starts a new, empty conversation; the previous one stays in the list. */
  start(): Chat {
    this.current = this.blank();
    this.save();
    return this.current;
  }

  open(id: string): Chat {
    const chat = this.chats.find((c) => c.id === id);
    if (!chat) throw new Error('No such conversation');
    this.current = chat;
    this.save();
    return chat;
  }

  /** Sessions already tied to a saved conversation, or removed from the list, so they are not listed (again). */
  knownSessions(): Set<string> {
    const ids = (c: Chat) => Object.values(c.sessions).filter((s): s is string => !!s);
    return new Set([...this.hidden, ...[...this.chats, this.current].flatMap(ids)]);
  }

  /** Stops offering a CLI session in the list. */
  hide(sessionId: string) {
    if (!this.hidden.includes(sessionId)) this.hidden.push(sessionId);
    this.save();
  }

  /** Takes over a session held in a CLI outside the app as a conversation of its own, and opens it. */
  adopt(agent: string, sessionId: string, title: string, updatedAt: string, messages: ChatMessage[]): Chat {
    const chat = { ...this.blank(), title, updatedAt, sessions: { [agent]: sessionId }, messages };
    this.chats.push(chat);
    this.current = chat;
    this.save();
    return chat;
  }

  remove(id: string) {
    // The CLIs keep their own record of the session; without this it would come straight back as one of theirs.
    for (const c of this.chats) if (c.id === id) this.hidden.push(...Object.values(c.sessions).filter((s): s is string => !!s));
    this.chats = this.chats.filter((c) => c.id !== id);
    if (this.current.id === id) this.current = this.blank();
    this.save();
  }

  addUser(text: string, attached: string[]) {
    const cur = this.current;
    if (!cur.title) cur.title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    cur.messages.push({ role: 'user', parts: [{ type: 'text', text }], ...(attached.length ? { attached } : {}) });
    cur.updatedAt = new Date().toISOString();
    this.save();
  }

  /** Builds the assistant's message from the event stream, the same way the front end does. */
  onEvent(ev: AgentEvent, sessions: Record<string, string | null>) {
    const cur = this.current;
    if (ev.kind === 'start') {
      cur.messages.push({ role: 'assistant', agent: ev.agent, parts: [] });
      return;
    }
    const last = cur.messages[cur.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (ev.kind === 'text') {
      const tail = last.parts[last.parts.length - 1];
      if (tail?.type === 'text') tail.text += ev.text;
      else if (ev.text.trim()) last.parts.push({ type: 'text', text: ev.text });
    } else if (ev.kind === 'tool') {
      last.parts.push({ type: 'tool', name: ev.name, detail: ev.detail });
    } else {
      if (ev.error) last.error = ev.error;
      cur.sessions = { ...sessions };
      cur.updatedAt = new Date().toISOString();
      this.save();
    }
  }
}
