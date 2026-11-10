import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from './chats.ts';

/**
 * Reads the agent CLIs' own session stores, so conversations held in this folder
 * outside the app (e.g. Claude Code in a terminal) can be listed and continued.
 * These are the CLIs' private file formats: everything here is read-only and
 * tolerant, and a session that cannot be read is simply left out.
 */

export interface CliSession {
  agent: 'claude' | 'codex';
  /** The CLI's session id, which is what its resume option takes. */
  sessionId: string;
  updatedAt: string;
  /** Name of the enclosing folder the session was held in; empty for the paper folder itself. */
  folder: string;
  file: string;
  mtime: number;
}

const LABEL = { claude: 'Claude Code', codex: 'Codex' };

/**
 * The paper folder and the folders around it up to the top of its git repository.
 * Papers often sit inside a larger project, and sessions started from the project
 * folder are recorded against that folder rather than the paper's.
 */
function scope(root: string): string[] {
  const dirs = [root];
  for (let dir = root; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dirs;
    dirs.push(path.dirname(dir));
  }
  return [root]; // Not in a repository: looking further up would take in unrelated work.
}

/** The message as the user typed it, without what the app or the CLI wrapped around it. Empty for non-messages. */
function userText(raw: string): string {
  let text = raw;
  // First message of a Codex session started by this app: the instructions come first.
  if (text.startsWith('You are working inside Paper Assistant')) text = text.split('\n\n---\n\n').slice(1).join('\n\n---\n\n');
  text = text.replace(/^\s*<editor_context>[\s\S]*?<\/editor_context>\s*/, '').trim();
  // Slash commands, injected context and similar are not things the user said.
  if (/^(<|Caveat: )/.test(text)) return '';
  return text;
}

const texts = (content: unknown, type: string): string[] =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b?.type === type && typeof b.text === 'string').map((b) => b.text as string)
      : [];

function parseLines(file: string, maxBytes?: number): any[] {
  let data: string;
  if (maxBytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      data = buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } else {
    data = fs.readFileSync(file, 'utf8');
  }
  const out: any[] = [];
  for (const line of data.split('\n')) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // A blank line, or the last line of a partial read.
    }
  }
  return out;
}

// ---------- Claude Code: <config>/projects/<folder path with - for every other character>/<session>.jsonl ----------

const claudeDir = (config: string, root: string) => path.join(config, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));

function claudeMessages(lines: any[], root: string, firstOnly = false): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const d of lines) {
    if (d.isSidechain || d.isMeta || d.isCompactSummary) continue;
    if (d.type === 'user') {
      const text = texts(d.message?.content, 'text').map(userText).filter(Boolean).join('\n\n');
      if (!text) continue;
      out.push({ role: 'user', parts: [{ type: 'text', text }] });
      if (firstOnly) return out;
    } else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      let last = out[out.length - 1];
      if (!last || last.role !== 'assistant') out.push((last = { role: 'assistant', agent: LABEL.claude, parts: [] }));
      for (const block of d.message.content) {
        if (block.type === 'text' && block.text?.trim()) last.parts.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const target = String(input.file_path ?? input.path ?? input.pattern ?? input.command ?? '');
          last.parts.push({ type: 'tool', name: String(block.name), detail: target.startsWith(root + '/') ? target.slice(root.length + 1) : target });
        }
      }
    }
  }
  return out;
}

// ---------- Codex: <home>/sessions/<year>/<month>/<day>/rollout-<time>-<session>.jsonl, for every folder together ----------

const codexDir = () => path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
const codexId = (file: string) => /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(file)?.[1] ?? null;
/** Which folder each Codex session file belongs to; it never changes, so it is looked up once. */
const codexCwd = new Map<string, string | null>();

function codexFiles(): { file: string; cwd: string }[] {
  let all: string[];
  try {
    all = (fs.readdirSync(codexDir(), { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(codexDir(), f));
  } catch {
    return [];
  }
  return all.flatMap((file) => {
    if (!codexCwd.has(file)) {
      let cwd: string | null = null;
      try {
        // The folder is near the start of the first line, which is too long to parse whole.
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(4096);
        const head = buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)).toString('utf8');
        fs.closeSync(fd);
        const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head);
        cwd = m ? (JSON.parse(m[1]) as string) : null;
      } catch {
        // Unreadable: not ours.
      }
      codexCwd.set(file, cwd);
    }
    const cwd = codexCwd.get(file);
    return cwd ? [{ file, cwd }] : [];
  });
}

function codexMessages(lines: any[], firstOnly = false): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const d of lines) {
    const p = d.payload;
    if (d.type !== 'response_item' || p?.type !== 'message') continue;
    if (p.role === 'user') {
      const text = texts(p.content, 'input_text').map(userText).filter(Boolean).join('\n\n');
      if (!text) continue;
      out.push({ role: 'user', parts: [{ type: 'text', text }] });
      if (firstOnly) return out;
    } else if (p.role === 'assistant') {
      const text = texts(p.content, 'output_text').join('\n\n').trim();
      if (!text) continue;
      const last = out[out.length - 1];
      if (last?.role === 'assistant') last.parts.push({ type: 'text', text });
      else out.push({ role: 'assistant', agent: LABEL.codex, parts: [{ type: 'text', text }] });
    }
  }
  return out;
}

// ---------- both ----------

/**
 * Sessions either CLI has on record for the paper folder and the folders around it, newest first.
 * `claudeConfig` is the config folder of the Claude Code login in use: each login has its own sessions.
 * Only the files' names and dates are read here; see `sessionTitle` for the rest.
 */
export function cliSessions(root: string, claudeConfig: string): CliSession[] {
  const dirs = scope(root);
  const found = new Map<string, CliSession>();
  const add = (agent: 'claude' | 'codex', sessionId: string | null, file: string, dir: string) => {
    try {
      if (!sessionId) return;
      const mtime = fs.statSync(file).mtimeMs;
      // A session continued from another folder is on record in both; the later copy is the fuller one.
      const other = found.get(sessionId);
      if (other && other.mtime >= mtime) return;
      found.set(sessionId, { agent, sessionId, file, mtime, updatedAt: new Date(mtime).toISOString(), folder: dir === root ? '' : path.basename(dir) });
    } catch {
      // Removed meanwhile.
    }
  };
  for (const dir of dirs) {
    try {
      const store = claudeDir(claudeConfig, dir);
      for (const f of fs.readdirSync(store)) if (f.endsWith('.jsonl')) add('claude', f.slice(0, -6), path.join(store, f), dir);
    } catch {
      // Claude Code has never been used in this folder.
    }
  }
  for (const { file, cwd } of codexFiles()) if (dirs.includes(cwd)) add('codex', codexId(file), file, cwd);
  return [...found.values()].sort((a, b) => b.mtime - a.mtime);
}

const titles = new Map<string, { mtime: number; title: string }>();

/** The first thing the user said in a session, or '' when nothing was said (such sessions are not worth listing). */
export function sessionTitle(s: CliSession): string {
  const known = titles.get(s.file);
  if (known && known.mtime === s.mtime) return known.title;
  let title = '';
  try {
    // The first message is near the top; session files can run to many megabytes.
    const lines = parseLines(s.file, 512 * 1024);
    const first = (s.agent === 'claude' ? claudeMessages(lines, '', true) : codexMessages(lines, true))[0];
    title = first?.parts[0]?.type === 'text' ? first.parts[0].text.replace(/\s+/g, ' ').slice(0, 80) : '';
  } catch {
    // Unreadable: left out.
  }
  titles.set(s.file, { mtime: s.mtime, title });
  return title;
}

/** What was said in a session, as chat messages. */
export function cliTranscript(root: string, s: CliSession): ChatMessage[] {
  const lines = parseLines(s.file);
  return s.agent === 'claude' ? claudeMessages(lines, root) : codexMessages(lines);
}
