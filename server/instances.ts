import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The record of which papers are open in a running Paper Assistant, kept in
 * ~/.paper-assistant/running (one file per server). The command uses it to find
 * a server that was started in the background: to stop it, or to reuse it
 * instead of starting a second one on the same paper.
 */
export interface Instance {
  pid: number;
  port: number;
  root: string;
  started: string;
}

const home = path.join(os.homedir(), '.paper-assistant');
const dir = path.join(home, 'running');
const fileOf = (pid: number) => path.join(dir, `${pid}.json`);

/** Where a background server for this paper writes what it would have printed. */
export function logFile(root: string): string {
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  return path.join(logs, `${path.basename(root).replace(/[^\w.-]/g, '_')}-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)}.log`);
}

export function register(port: number, root: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileOf(process.pid), JSON.stringify({ pid: process.pid, port, root, started: new Date().toISOString() } satisfies Instance));
  } catch {
    // Without a record the server still works; it just cannot be found by `paper-assistant stop`.
  }
}

export function unregister() {
  try {
    fs.unlinkSync(fileOf(process.pid));
  } catch {
    // Never written, or already gone.
  }
}

export const urlOf = (inst: Instance) => `http://localhost:${inst.port}`;

/** Whether the server on record is really there: its port answers, and for the same paper. */
async function alive(inst: Instance): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/api/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json()).root === inst.root;
  } catch {
    return false;
  }
}

/** The servers now running. Records left behind by one that died are cleared away. */
export async function running(): Promise<Instance[]> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Instance[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        const inst = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Instance;
        if (await alive(inst)) out.push(inst);
        else fs.unlinkSync(path.join(dir, name));
      } catch {
        // Unreadable or removed meanwhile.
      }
    }),
  );
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/** Asks a server to stop, through its own API, and waits until it has. */
export async function stop(inst: Instance): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${inst.port}/api/quit`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    // Judged by whether it is still there.
  }
  for (let i = 0; i < 30; i++) {
    if (!(await alive(inst))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // No browser launcher; the URL is printed instead.
  }
}
