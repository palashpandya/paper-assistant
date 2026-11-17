#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn, spawnSync } from 'node:child_process';
import { Agents, parseAgentOptions } from './agent.ts';
import { Annotations, type NewThread } from './annotations.ts';
import { Chats } from './chats.ts';
import { cliSessions, cliTranscript, sessionTitle } from './cliHistory.ts';
import { Compiler } from './compiler.ts';
import { Settings, claudeAccounts } from './settings.ts';
import { Project, isAssetFile, isSkippedDir, isTextFile } from './project.ts';
import { forward, reverse } from './synctex.ts';
import { openBrowser, register, unregister } from './instances.ts';
import { projectSymbols, texInstalled } from './symbols.ts';

// ---------- command line ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// --help, --version and the stop and list commands are handled in cli.ts, which starts this file.
const positional = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--port');
const PORT = Number(option('--port') ?? process.env.PORT ?? 4317);
const HOST = '127.0.0.1';

let project: Project;
try {
  project = new Project(positional[0] ?? process.cwd());
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// ---------- live updates ----------

const clients = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
};
const broadcastFiles = () => broadcast({ type: 'files', files: project.files(), main: project.main });

const compiler = new Compiler(
  project.root,
  () => project.main,
  () => broadcast({ type: 'compile', status: 'compiling' }),
  (result) => {
    forgetGenerated();
    broadcast({ type: 'compile', status: 'done', result });
    // The text may have moved in the new PDF; annotations follow it.
    void broadcastAnnotations();
    // Handle file events that arrived mid-build, now that we know which files the build itself wrote.
    for (const [event, abs] of deferred.splice(0)) processFileEvent(event, abs);
    for (const fn of afterBuild.splice(0)) fn();
  },
);

/** Files LaTeX writes itself (e.g. REVTeX's <job>Notes.bib) are not sources: hide them and never rebuild for them. */
function forgetGenerated() {
  let changed = false;
  for (const abs of compiler.generated) {
    if (isTextFile(abs) && project.onDiskRemove(project.rel(abs))) changed = true;
  }
  if (changed) broadcastFiles();
}

let compileTimer: NodeJS.Timeout | null = null;
const scheduleCompile = () => {
  if (compileTimer) clearTimeout(compileTimer);
  compileTimer = setTimeout(() => {
    compileTimer = null;
    void compiler.compile();
  }, 400);
};
const afterBuild: (() => void)[] = [];

// The conversation is recorded here as well as shown in the browser, so it survives reloads and restarts.
const settings = new Settings(project.root);
const chats = new Chats(project.root, () => settings.claudeConfig);
const agents = new Agents(
  project.root,
  (event) => {
    chats.onEvent(event, agents.sessionIds());
    broadcast({ type: 'agent', event });
  },
  () => settings.claudeConfig,
);
agents.restore(chats.resumable(chats.current));

const annotations = new Annotations(project, () => compiler.pdfPath());
const broadcastAnnotations = async () => broadcast({ type: 'annotations', threads: await annotations.views() });

/**
 * Comments an agent left for the PDF during its turn. They are placed with SyncTeX,
 * so wait for the build of the agent's last edits before reading them.
 */
function collectAgentNotes(agent: string) {
  const collect = async () => {
    if (await annotations.collectAgentNotes(agent).catch(() => 0)) await broadcastAnnotations();
  };
  setTimeout(() => {
    if (compiler.busy || compileTimer) afterBuild.push(() => void collect());
    else void collect();
  }, 700);
}

// ---------- file watching ----------

const deferred: [string, string][] = [];

function onFileEvent(event: string, abs: string) {
  // While a build runs we cannot tell its own output from a real edit, so wait until it finishes.
  if (compiler.busy) {
    deferred.push([event, abs]);
    return;
  }
  processFileEvent(event, abs);
}

function processFileEvent(event: string, abs: string) {
  if (compiler.generated.has(abs) || abs === compiler.pdfPath() || /-converted-to\.pdf$/.test(abs)) return;
  const rel = project.rel(abs);
  if (isTextFile(abs)) {
    if (event === 'unlink') {
      if (project.onDiskRemove(rel)) {
        broadcastFiles();
        scheduleCompile();
      }
      return;
    }
    if (event !== 'add' && event !== 'change') return;
    const change = project.onDiskChange(rel);
    if (!change) return;
    if (change.external) {
      broadcast({ type: 'fileChanged', path: rel, content: change.content, baseline: change.baseline });
    }
    broadcastFiles();
    scheduleCompile();
  } else if (isAssetFile(abs) && (event === 'add' || event === 'change')) {
    // A figure changed.
    scheduleCompile();
  }
}

chokidar
  .watch(project.root, {
    ignoreInitial: true,
    ignored: (p, stats) => {
      if (p === project.root) return false;
      if (isSkippedDir(path.basename(p))) return true;
      return !!stats?.isFile() && !isTextFile(p) && !isAssetFile(p);
    },
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  })
  .on('all', onFileEvent);

// ---------- HTTP API ----------

const app = express();
app.use(express.json({ limit: '20mb' }));

// Only this machine's browser may talk to the server (guards against cross-site requests and DNS rebinding).
const localName = (value: string | undefined) => {
  if (!value) return true;
  try {
    const host = new URL(value.includes('://') ? value : `http://${value}`).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
};
app.use((req, res, next) => {
  if (!localName(req.headers.host) || !localName(req.headers.origin)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
});

const relPath = (req: express.Request): string => {
  const p = req.query.path;
  if (typeof p !== 'string' || !p) throw new Error('Missing path');
  if (!isTextFile(p)) throw new Error('Not an editable file type');
  project.abs(p);
  return p;
};

app.get('/api/state', (_req, res) => {
  res.json({
    root: project.root,
    name: path.basename(project.root),
    files: project.files(),
    main: project.main,
    compiling: compiler.busy,
    compile: compiler.last,
    agentBusy: agents.busy,
    claudeAccounts: claudeAccounts(),
    claudeConfig: settings.claudeConfig,
    agents: agents.list(),
  });
});

// Closes the app: the server may have been started in the background, with no terminal to press Ctrl+C in.
app.post('/api/quit', (_req, res) => {
  res.json({ ok: true });
  broadcast({ type: 'quit' });
  setTimeout(shutdown, 150);
});

// What the editor's completion offers: the paper's own labels, citation keys, macros and files...
app.get('/api/symbols', (_req, res) => {
  res.json(projectSymbols(project));
});

// ...and the packages and classes of the TeX installation, which do not change while the app runs.
app.get('/api/tex-installed', async (_req, res) => {
  res.json(await texInstalled());
});

app.get('/api/file', (req, res) => {
  res.json(project.read(relPath(req)));
});

app.put('/api/file', (req, res) => {
  const rel = relPath(req);
  if (typeof req.body?.content !== 'string') throw new Error('Missing content');
  if (typeof req.body?.expected !== 'string') throw new Error('Missing expected content');
  const result = project.writeFromClient(rel, req.body.content, req.body.expected);
  if (!result.saved) {
    res.status(409).json(result);
    return;
  }
  broadcastFiles();
  scheduleCompile();
  res.json(result);
});

app.post('/api/baseline', (req, res) => {
  const rel = relPath(req);
  if (typeof req.body?.content !== 'string') throw new Error('Missing content');
  project.setBaseline(rel, req.body.content);
  broadcastFiles();
  res.json({ ok: true });
});

app.post('/api/compile', (_req, res) => {
  void compiler.compile();
  res.json({ ok: true });
});

app.get('/api/pdf', (_req, res) => {
  const pdf = compiler.pdfPath();
  if (!pdf || !fs.existsSync(pdf)) {
    res.status(404).json({ error: 'No PDF yet' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(pdf).pipe(res);
});

app.get('/api/synctex/forward', async (req, res) => {
  const pdf = compiler.pdfPath();
  const rel = relPath(req);
  const box = pdf ? await forward(pdf, project.abs(rel), Number(req.query.line)) : null;
  res.json({ box });
});

app.get('/api/synctex/reverse', async (req, res) => {
  const pdf = compiler.pdfPath();
  const hit = pdf
    ? await reverse(pdf, Number(req.query.page), Number(req.query.x), Number(req.query.y))
    : null;
  if (!hit || !hit.file.startsWith(project.root + path.sep)) {
    res.json({ hit: null });
    return;
  }
  res.json({ hit: { path: project.rel(hit.file), line: hit.line } });
});

// ----- comments and drawings on the PDF -----

const threadId = (req: express.Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new Error('Bad comment id');
  return id;
};

app.get('/api/annotations', async (_req, res) => {
  res.json({ threads: await annotations.views() });
});

app.post('/api/annotations', async (req, res) => {
  const body = req.body as NewThread;
  if (body?.kind !== 'comment' && body?.kind !== 'drawing') throw new Error('Bad annotation');
  if (!Number.isInteger(body.page) || body.page < 1) throw new Error('Bad page');
  const thread = await annotations.create(body);
  await broadcastAnnotations();
  res.json({ id: thread.id });
});

app.post('/api/annotations/:id/messages', async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Missing text');
  annotations.addMessage(threadId(req), { author: 'user', text: text.trim() });
  await broadcastAnnotations();
  res.json({ ok: true });
});

app.patch('/api/annotations/:id', async (req, res) => {
  annotations.setResolved(threadId(req), !!req.body?.resolved);
  await broadcastAnnotations();
  res.json({ ok: true });
});

app.delete('/api/annotations/:id', async (req, res) => {
  annotations.remove(threadId(req));
  await broadcastAnnotations();
  res.json({ ok: true });
});

app.get('/api/annotations/:id/image', (req, res) => {
  const file = annotations.imagePath(threadId(req));
  if (!file || !fs.existsSync(file)) {
    res.status(404).json({ error: 'No image' });
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  fs.createReadStream(file).pipe(res);
});

// ----- agent -----

app.post('/api/agent/send', (req, res) => {
  const name = req.body?.agent ?? 'claude';
  if (typeof name !== 'string' || !agents.has(name)) throw new Error('Unknown agent');
  const options = parseAgentOptions(name, req.body?.options);
  if (agents.busy) {
    res.status(409).json({ error: 'The agent is still working.' });
    return;
  }
  // Either a chat message, or a list of PDF comments to work through.
  const threads: number[] = Array.isArray(req.body?.threads) ? req.body.threads.map(Number) : [];
  if (threads.length) {
    const prompt = annotations.prompt(threads);
    chats.addUser(threads.length === 1 ? `Address comment #${threads[0]}.` : `Address comments ${threads.map((id) => `#${id}`).join(', ')}.`, []);
    agents.send(name, prompt, (reply) => {
      if (reply) annotations.applyReply(threads, reply, agents.label(name));
      void broadcastAnnotations();
      collectAgentNotes(agents.label(name));
    }, options);
  } else {
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Missing prompt');
    // `display` is the message as the user typed it; the prompt also carries the editor context.
    const display = typeof req.body?.display === 'string' && req.body.display.trim() ? req.body.display : prompt;
    const attached = Array.isArray(req.body?.attached) ? req.body.attached.filter((a: unknown) => typeof a === 'string') : [];
    chats.addUser(display, attached);
    agents.send(name, prompt, () => collectAgentNotes(agents.label(name)), options);
  }
  res.json({ ok: true });
});

app.post('/api/agent/stop', (_req, res) => {
  agents.stop();
  res.json({ ok: true });
});

app.post('/api/agent/reset', (_req, res) => {
  agents.reset();
  chats.start();
  res.json({ ok: true });
});

// Which Claude Code login the agent runs under and History reads from. A conversation belongs to the login it
// was held with, so changing it starts a new one.
app.put('/api/settings/claude-config', (req, res) => {
  if (agents.busy) {
    res.status(409).json({ error: 'The agent is still working.' });
    return;
  }
  const dir = req.body?.dir;
  if (dir !== null && typeof dir !== 'string') throw new Error('Bad login');
  if (dir !== settings.claudeConfig) {
    settings.setClaudeConfig(dir);
    agents.reset();
    chats.start();
  }
  res.json({ ok: true });
});

// ----- saved conversations -----

app.get('/api/chat', (_req, res) => {
  res.json({ id: chats.current.id, messages: chats.current.messages });
});

// Conversations saved by the app, plus sessions the CLIs have for this folder that the app has not opened yet
// (for example Claude Code run in a terminal here). Those get the id "cli:<agent>:<session id>".
// The list is served a page at a time (`offset`, `limit`; `next` is the offset of the following page or null),
// because a session's title has to be read out of its file and there can be hundreds of sessions.
// `agent` narrows it to one agent's conversations; one held with both agents counts for each.
app.get('/api/chats', (req, res) => {
  const known = chats.knownSessions();
  const only = typeof req.query.agent === 'string' && agents.has(req.query.agent) ? req.query.agent : null;
  const all = [
    ...chats
      .list()
      .filter((c) => !only || c.agents.includes(only))
      .map((c) => ({ updatedAt: c.updatedAt, saved: c, cli: null })),
    ...cliSessions(project.root, settings.claudeDir())
      .filter((s) => !known.has(s.sessionId) && (!only || s.agent === only))
      .map((s) => ({ updatedAt: s.updatedAt, saved: null, cli: s })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  let i = Math.max(0, Number(req.query.offset) || 0);
  const page = [];
  for (; i < all.length && page.length < limit; i++) {
    const { saved, cli, updatedAt } = all[i];
    if (saved) page.push({ id: saved.id, title: saved.title, updatedAt, source: 'app' });
    else if (cli) {
      const title = sessionTitle(cli);
      if (title) page.push({ id: `cli:${cli.agent}:${cli.sessionId}`, title, updatedAt, source: cli.agent, label: agents.label(cli.agent), folder: cli.folder });
    }
  }
  res.json({ current: chats.current.id, chats: page, next: i < all.length ? i : null });
});

app.post('/api/chats/:id/open', (req, res) => {
  if (agents.busy) {
    res.status(409).json({ error: 'The agent is still working.' });
    return;
  }
  const cli = /^cli:(claude|codex):(.+)$/.exec(req.params.id);
  let chat;
  if (cli) {
    const session = cliSessions(project.root, settings.claudeDir()).find((s) => s.agent === cli[1] && s.sessionId === cli[2]);
    if (!session) throw new Error('No such session');
    chat = chats.adopt(session.agent, session.sessionId, sessionTitle(session), session.updatedAt, cliTranscript(project.root, session));
  } else {
    chat = chats.open(req.params.id);
  }
  const sessions = chats.resumable(chat);
  agents.restore(sessions);
  res.json({ id: chat.id, messages: chat.messages, agent: Object.keys(sessions)[0] ?? null });
});

// Removes a conversation from the list. The CLIs' own session files are never touched.
app.delete('/api/chats/:id', (req, res) => {
  const cli = /^cli:(?:claude|codex):(.+)$/.exec(req.params.id);
  if (cli) {
    chats.hide(cli[1]);
    res.json({ ok: true });
    return;
  }
  if (agents.busy && req.params.id === chats.current.id) {
    res.status(409).json({ error: 'The agent is still working.' });
    return;
  }
  const wasCurrent = req.params.id === chats.current.id;
  chats.remove(req.params.id);
  if (wasCurrent) agents.reset();
  res.json({ ok: true });
});

// Built front end (after `npm run build`). In dev, Vite serves it and proxies /api here.
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: err.message });
});

// ---------- start ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !localName(req.headers.host) || !localName(req.headers.origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });
});

// If the port is taken (another paper is open), use the next free one.
let port = PORT;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) {
    server.listen(++port, HOST);
    return;
  }
  console.error(err.message);
  process.exit(1);
});

server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Paper Assistant: ${project.root}`);
  console.log(`Main file: ${project.main ?? '(none found)'}`);
  if (fs.existsSync(dist)) {
    console.log(`Open ${url}`);
    if (!flag('--no-open')) openBrowser(url);
  } else {
    console.log(`API on ${url} (run the Vite dev server for the UI)`);
  }
  register(port, project.root);
  // Say what is missing now, rather than at the first build or the first message to the agent.
  const onPath = (cmd: string) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
  if (!onPath('pdflatex')) console.warn('Warning: pdflatex was not found. Install a TeX distribution (TeX Live or MacTeX) to build the PDF.');
  else if (!onPath('synctex')) console.warn('Warning: synctex was not found. Jumping between source and PDF, and comments on the PDF, need it.');
  if (!agents.list().some((a) => a.available)) console.warn('Warning: neither claude nor codex was found. Install Claude Code or Codex and log in to use the agent.');
  void compiler.compile();
});
server.listen(port, HOST);

function shutdown() {
  agents.stop();
  unregister();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
