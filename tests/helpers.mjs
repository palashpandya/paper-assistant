import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../', import.meta.url));
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, message = 'Condition timed out', timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(message);
}
export async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await closed; } finally { clearTimeout(timer); }
}
export async function startApp() {
  const temp = fs.mkdtempSync('/tmp/paper-app-test-');
  const root = path.join(temp, 'paper');
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(temp, 'home'));
  const original = '\\documentclass{article}\n\\begin{document}\nAlpha paragraph.\nBeta paragraph.\n\\end{document}\n';
  fs.writeFileSync(path.join(root, 'main.tex'), original);
  fs.writeFileSync(path.join(root, 'other.tex'), 'Other file\n');
  // Keep app state and account discovery inside the disposable fixture.
  const preload = path.join(temp, 'home.mjs');
  fs.writeFileSync(preload, `import os from 'node:os'; os.homedir = () => ${JSON.stringify(path.join(temp, 'home'))};`);
  fs.writeFileSync(path.join(bin, 'latexmk'), `#!${process.execPath}
const fs = require('node:fs');
const count = Number(fs.existsSync('build-count') ? fs.readFileSync('build-count', 'utf8') : 0) + 1;
fs.writeFileSync('build-count', String(count));
fs.writeFileSync('mainNotes.bib', 'generated ' + count);
fs.writeFileSync('main.fls', 'OUTPUT mainNotes.bib\\n');
(async () => {
  while (fs.existsSync('hold-build') && !fs.existsSync('release-build')) await new Promise(r => setTimeout(r, 20));
})();
`, { mode: 0o755 });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, ['--import', preload, 'server/index.ts', root, '--port', String(port), '--no-open'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const api = async (route, init) => {
    const res = await fetch(url + route, init);
    return { status: res.status, body: await res.json() };
  };
  const close = async () => {
    await stopChild(child);
    fs.rmSync(temp, { recursive: true, force: true });
  };
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(output);
      try { return (await api('/api/state')).body.compile !== null; } catch { return false; }
    }, 'App did not start');
  } catch (err) { await close(); throw err; }
  return { temp, root, url, child, api, close, original };
}
export const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
