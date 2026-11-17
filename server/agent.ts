import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentEvent =
  | { kind: 'start'; agent: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'done'; error?: string };

export type AgentName = 'claude' | 'codex';

export interface AgentOptions {
  model?: string;
  effort?: string;
}

const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

/** Use the installed CLI's catalog rather than pinning model names that go stale. */
export function agentModels(name: AgentName): { id: string; label: string; efforts: string[] }[] {
  if (name === 'claude') return ['sonnet', 'opus', 'haiku', 'fable'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), efforts: EFFORTS.claude }));
  try {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    return cache.models.filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string').map((m: any) => ({
      id: m.slug,
      label: typeof m.display_name === 'string' ? m.display_name : m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((level: any) => level.effort).filter((e: unknown) => typeof e === 'string')
        : EFFORTS.codex,
    }));
  } catch {
    return []; // Custom model IDs still work before the CLI has cached its catalog.
  }
}

export function parseAgentOptions(name: AgentName, value: unknown): AgentOptions {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent settings');
  const { model, effort } = value as AgentOptions;
  if (model !== undefined && (typeof model !== 'string' || (model !== '' && !/^[a-zA-Z0-9][\w.:[\]/@+-]{0,199}$/.test(model)))) {
    throw new Error('Invalid model');
  }
  const supported = agentModels(name).find((m) => m.id === model)?.efforts ?? EFFORTS[name];
  if (effort !== undefined && (typeof effort !== 'string' || (effort !== '' && !supported.includes(effort)))) {
    throw new Error('Invalid effort for this model');
  }
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

const INSTRUCTIONS = `You are working inside Paper Assistant, a LaTeX editor. The user sees the LaTeX source, the compiled PDF and this chat side by side.

- The working directory is the user's LaTeX project. Edit the files directly; every edit appears in the user's editor as a diff they can accept or reject.
- The editor recompiles the PDF automatically after each change. Do not run LaTeX yourself. To check for compile errors, read the .log file next to the main .tex file after editing.
- Make focused edits. Do not reformat or rewrite text the user did not ask about.
- Keep chat replies short: say what you changed and where. The diff shows the details.
- The chat renders Markdown and typesets math. Write math as $...$ or $$...$$, and put LaTeX source you want shown literally in backticks.
- You can put your own comments on the PDF. Do this when the user asks for a review, for feedback or to point things out, or when a change needs their decision; do not use it to report edits you made. Write a JSON array to .paper-assistant/agent-notes.json with one object per comment: {"file": "<project-relative path of the source file>", "line": <first source line>, "endLine": <last source line, optional>, "quote": "<a few words copied exactly from the first line>", "text": "<the comment, Markdown allowed>", "mark": "highlight" | "box" | "circle"}. When your turn ends the editor marks where those source lines are typeset in the PDF, lists each comment under Comments for the user to reply to, and deletes the file. "highlight" (the default) shades the typeset lines; "box" and "circle" draw around them. You address the PDF through source lines only, and marks cover whole typeset lines, so give the shortest line range that covers what you mean. This file is only for new comments of your own; answer comments you were asked to address in the #<number> form.`;

interface Turn {
  sessionId: string | null;
  emit: (event: AgentEvent) => void;
  fail: (message: string) => void;
  cwd: string;
}

/** How to run one agent CLI headlessly and read its event stream. */
interface Backend {
  label: string;
  command: string;
  args: (sessionId: string | null, options: AgentOptions) => string[];
  /** Text placed before the user's first message, for CLIs without a system-prompt flag. */
  preamble?: string;
  onMessage: (msg: any, turn: Turn) => void;
}

const relative = (p: string, cwd: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
const installed = (cmd: string) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;

const BACKENDS: Record<AgentName, Backend> = {
  // Claude Code, restricted to reading, searching and editing files in the project.
  claude: {
    label: 'Claude Code',
    command: process.env.PAPER_ASSISTANT_CLAUDE ?? 'claude',
    args: (sessionId, options) => [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--append-system-prompt', INSTRUCTIONS,
      ...(sessionId ? ['--resume', sessionId] : []),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.effort ? ['--effort', options.effort] : []),
      '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    ],
    onMessage(msg, turn) {
      if (msg.session_id) turn.sessionId = msg.session_id;
      if (msg.parent_tool_use_id) return; // subagent chatter
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          turn.emit({ kind: 'text', text: ev.delta.text });
        } else if (ev?.type === 'message_stop') {
          turn.emit({ kind: 'text', text: '\n\n' });
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const input = block.input ?? {};
            const target = String(input.file_path ?? input.path ?? input.pattern ?? input.command ?? '');
            turn.emit({ kind: 'tool', name: block.name, detail: relative(target, turn.cwd) });
          }
        }
      } else if (msg.type === 'result' && msg.is_error) {
        turn.fail(typeof msg.result === 'string' && msg.result ? msg.result : `Agent error (${msg.subtype})`);
      }
    },
  },

  // Codex CLI. It works through shell commands, confined to the project folder by its own sandbox.
  codex: {
    label: 'Codex',
    command: process.env.PAPER_ASSISTANT_CODEX ?? 'codex',
    args: (sessionId, options) => [
      'exec',
      ...(sessionId ? ['resume'] : []),
      '--json',
      '--skip-git-repo-check',
      '-c', 'sandbox_mode="workspace-write"',
      ...(options.model ? ['--model', options.model] : []),
      ...(options.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []),
      ...(sessionId ? [sessionId] : []),
      '-',
    ],
    preamble: INSTRUCTIONS,
    onMessage(msg, turn) {
      if (msg.type === 'thread.started' && msg.thread_id) turn.sessionId = msg.thread_id;
      else if (msg.type === 'turn.failed' || msg.type === 'error') {
        turn.fail(String(msg.error?.message ?? msg.message ?? 'Codex reported an error'));
      } else if (msg.type === 'item.started' && msg.item?.type === 'command_execution') {
        const command = String(msg.item.command ?? '')
          .replace(/^\/bin\/(?:ba)?sh -lc\s+/, '')
          .replace(/^(["'])([\s\S]*)\1$/, '$2');
        turn.emit({ kind: 'tool', name: 'Run', detail: command.length > 160 ? `${command.slice(0, 159)}…` : command });
      } else if (msg.type === 'item.completed') {
        const item = msg.item ?? {};
        if (item.type === 'agent_message' && item.text) {
          turn.emit({ kind: 'text', text: `${String(item.text).trim()}\n\n` });
        } else if (item.type === 'file_change') {
          for (const change of item.changes ?? []) {
            turn.emit({ kind: 'tool', name: 'Edit', detail: relative(String(change.path ?? ''), turn.cwd) });
          }
        }
      }
    },
  },
};

/**
 * Runs agent CLIs in the project folder under the user's own logins. One chat
 * turn is one CLI process; each agent keeps its own session, resumed per turn.
 */
export class Agents {
  private child: ChildProcess | null = null;
  private sessions: Record<AgentName, string | null> = { claude: null, codex: null };
  private readonly cwd: string;
  private readonly emit: (event: AgentEvent) => void;
  private readonly claudeConfig: () => string | null;

  /** `claudeConfig` gives the config folder of the Claude Code login to run under, or null for the default one. */
  constructor(cwd: string, emit: (event: AgentEvent) => void, claudeConfig: () => string | null) {
    this.cwd = cwd;
    this.emit = emit;
    this.claudeConfig = claudeConfig;
  }

  get busy() {
    return this.child !== null;
  }

  has(name: string): name is AgentName {
    return Object.hasOwn(BACKENDS, name);
  }

  list() {
    return (Object.keys(BACKENDS) as AgentName[]).map((name) => ({
      name,
      label: BACKENDS[name].label,
      available: installed(BACKENDS[name].command),
      models: agentModels(name),
      efforts: EFFORTS[name],
    }));
  }

  label(name: AgentName) {
    return BACKENDS[name].label;
  }

  /** The CLIs' session ids for the conversation in progress. */
  sessionIds(): Record<string, string | null> {
    return { ...this.sessions };
  }

  /** Continue a saved conversation: the next turn of each agent resumes the session it had there. */
  restore(sessions: Record<string, string | null>) {
    this.stop();
    this.sessions = { claude: sessions.claude ?? null, codex: sessions.codex ?? null };
  }

  /** Forget all conversations and start fresh. */
  reset() {
    this.stop();
    this.sessions = { claude: null, codex: null };
  }

  stop() {
    this.child?.kill('SIGINT');
  }

  /** Starts a turn. `onFinish` receives everything the agent said once it is done. */
  send(name: AgentName, prompt: string, onFinish?: (text: string, error?: string) => void, options: AgentOptions = {}) {
    if (this.child) return;
    const backend = BACKENDS[name];
    const fresh = !this.sessions[name];

    const env = { ...process.env };
    if (name === 'claude') {
      // The default login is selected by the variable being absent, not by pointing it at ~/.claude.
      const config = this.claudeConfig();
      if (config) env.CLAUDE_CONFIG_DIR = config;
      else delete env.CLAUDE_CONFIG_DIR;
      if (options.effort) env.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
    }
    const child = spawn(backend.command, backend.args(this.sessions[name], options), {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.emit({ kind: 'start', agent: backend.label });

    let said = '';
    let stderr = '';
    let error: string | undefined;
    let finished = false;
    const finish = (err?: string) => {
      if (finished) return;
      finished = true;
      this.child = null;
      this.emit({ kind: 'done', error: err });
      onFinish?.(said.trim(), err);
    };

    const turn: Turn = {
      sessionId: this.sessions[name],
      cwd: this.cwd,
      emit: (event) => {
        if (event.kind === 'text') said += event.text;
        this.emit(event);
      },
      fail: (message) => (error = message),
    };

    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) =>
      finish(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${backend.label} is not installed (command "${backend.command}" not found). Install it and log in once from a terminal.`
          : err.message,
      ),
    );
    child.on('close', (code, signal) => {
      if (signal === 'SIGINT' || code === 130) finish(error ?? 'Stopped.');
      else finish(error ?? (code ? stderr.trim() || `${backend.label} exited with code ${code}` : undefined));
    });

    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      backend.onMessage(msg, turn);
      this.sessions[name] = turn.sessionId;
    });

    child.stdin!.on('error', () => {});
    child.stdin!.end(fresh && backend.preamble ? `${backend.preamble}\n\n---\n\n${prompt}` : prompt);
  }
}
