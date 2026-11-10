export interface FileInfo {
  path: string;
  pending: boolean;
}

export interface CompileIssue {
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  hasPdf: boolean;
  pdfVersion: number;
  errors: CompileIssue[];
  warnings: string[];
  log: string;
  durationMs: number;
  engine: string;
}

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AgentEvent =
  | { kind: 'start'; agent: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'done'; error?: string };

/** PDF points from the top-left of the page. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ThreadMessage {
  author: 'user' | 'agent';
  agent?: string;
  text: string;
  at: string;
}

/** A comment or drawing on the PDF, with the conversation attached to it. */
export interface Thread {
  id: number;
  kind: 'comment' | 'drawing';
  /** Absent on older threads, which are the user's. */
  author?: 'user' | 'agent';
  page: number;
  rects: Rect[];
  /** Each stroke is a flat list x0, y0, x1, y1, ... */
  strokes: number[][];
  quote: string;
  image: string | null;
  anchor: { path: string; line: number; endLine: number } | null;
  messages: ThreadMessage[];
  resolved: boolean;
  resolvedBy?: 'user' | 'agent';
  createdAt: string;
  /** Where it sits in the current PDF; `stale` means the text it pointed at is gone. */
  view: { page: number; dx: number; dy: number; stale: boolean };
}

export interface NewThread {
  kind: 'comment' | 'drawing';
  page: number;
  rects?: Rect[];
  strokes?: number[][];
  quote?: string;
  text?: string;
  /** PNG data URL of the marked-up region. */
  image?: string;
}

export interface AgentInfo {
  name: string;
  label: string;
  available: boolean;
}

/** A saved agent conversation, as listed under History. */
export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  /** 'app' for conversations held here; otherwise the CLI whose own session this is, not opened in the app yet. */
  source: 'app' | 'claude' | 'codex';
  /** That CLI's display name. */
  label?: string;
  /** For a CLI session held in a folder around the paper's rather than in it: that folder's name. */
  folder?: string;
}

/** One chat bubble; the server stores conversations in this shape (ChatMessage in server/chats.ts). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  /** Which agent wrote an assistant message. */
  agent?: string;
  parts: ({ type: 'text'; text: string } | { type: 'tool'; name: string; detail: string })[];
  /** Labels of the context that was attached to a user message. */
  attached?: string[];
  error?: string;
}

export type ServerMsg =
  | { type: 'annotations'; threads: Thread[] }
  | { type: 'files'; files: FileInfo[]; main: string | null }
  | { type: 'compile'; status: 'compiling' }
  | { type: 'compile'; status: 'done'; result: CompileResult }
  | { type: 'fileChanged'; path: string; content: string; baseline: string }
  | { type: 'agent'; event: AgentEvent };

export interface AppState {
  root: string;
  name: string;
  files: FileInfo[];
  main: string | null;
  compiling: boolean;
  compile: CompileResult | null;
  agentBusy: boolean;
  agents: AgentInfo[];
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = (url: string, body?: unknown) =>
  call<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const q = (path: string) => `path=${encodeURIComponent(path)}`;

export const api = {
  state: () => call<AppState>('/api/state'),
  readFile: (path: string) => call<{ content: string; baseline: string }>(`/api/file?${q(path)}`),
  writeFile: (path: string, content: string) =>
    call<{ baseline: string }>(`/api/file?${q(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  setBaseline: (path: string, content: string) => post(`/api/baseline?${q(path)}`, { content }),
  compile: () => post('/api/compile'),
  forward: (path: string, line: number) =>
    call<{ box: PdfBox | null }>(`/api/synctex/forward?${q(path)}&line=${line}`),
  reverse: (page: number, x: number, y: number) =>
    call<{ hit: { path: string; line: number } | null }>(`/api/synctex/reverse?page=${page}&x=${x}&y=${y}`),
  /** `display` and `attached` are what the chat shows for this message; `prompt` is what the agent receives. */
  send: (agent: string, prompt: string, display: string, attached: string[]) =>
    post('/api/agent/send', { agent, prompt, display, attached }),
  sendThreads: (agent: string, threads: number[]) => post('/api/agent/send', { agent, threads }),
  threads: () => call<{ threads: Thread[] }>('/api/annotations'),
  createThread: (thread: NewThread) =>
    call<{ id: number }>('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(thread),
    }),
  replyToThread: (id: number, text: string) => post(`/api/annotations/${id}/messages`, { text }),
  resolveThread: (id: number, resolved: boolean) =>
    call<{ ok: boolean }>(`/api/annotations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved }),
    }),
  deleteThread: (id: number) => call<{ ok: boolean }>(`/api/annotations/${id}`, { method: 'DELETE' }),
  stop: () => post('/api/agent/stop'),
  reset: () => post('/api/agent/reset'),
  chat: () => call<{ id: string; messages: ChatMessage[] }>('/api/chat'),
  /** One page of the History list; `next` is the offset to ask for after it, or null at the end. */
  chats: (offset = 0, agent = 'all') =>
    call<{ current: string; chats: ChatSummary[]; next: number | null }>(
      `/api/chats?offset=${offset}&limit=20${agent === 'all' ? '' : `&agent=${encodeURIComponent(agent)}`}`,
    ),
  /** `agent` is the agent that conversation was held with. */
  openChat: (id: string) =>
    call<{ id: string; messages: ChatMessage[]; agent: string | null }>(`/api/chats/${encodeURIComponent(id)}/open`, { method: 'POST' }),
  deleteChat: (id: string) => call<{ ok: boolean }>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** Opens the live-update socket and keeps it open. Returns a function that closes it. */
export function connect(onMsg: (msg: ServerMsg) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus(false);
      if (!closed) timer = setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
