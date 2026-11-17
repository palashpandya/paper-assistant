import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logFile, openBrowser, running, stop, urlOf } from './instances.ts';

/**
 * The `paper-assistant` command. By default it starts the server (index.ts) as a
 * background process and returns, so the terminal stays free; `stop` and `list`
 * find such servers again through the record in instances.ts.
 */

const argv = process.argv.slice(2);
const flag = (...names: string[]) => names.some((n) => argv.includes(n));
// This file runs as .ts in development and as compiled .js when installed.
const server = new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url);

const USAGE = `Usage: paper-assistant [folder] [options]     open a paper (default: the current folder)
       paper-assistant stop [folder|--all]    close it
       paper-assistant list                   show the papers that are open

The app runs in the background: the command returns once it is up.
Close it with "paper-assistant stop" or the Quit button in the app.

  --port <number>   Port to listen on (default: 4317, or the next free one)
  --no-open         Do not open the browser
  --foreground      Stay attached to this terminal; Ctrl+C closes the app
  --version         Print the version`;

const positional = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--port');
const command = positional[0] === 'stop' || positional[0] === 'list' ? positional.shift() : null;
const root = path.resolve(positional[0] ?? process.cwd());

async function main(): Promise<void> {
  if (flag('--help', '-h')) {
    console.log(USAGE);
    return;
  }
  if (flag('--version', '-v')) {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return;
  }

  if (command === 'list') {
    const all = await running();
    if (!all.length) console.log('No papers are open.');
    for (const inst of all) console.log(`${urlOf(inst)}  ${inst.root}`);
    return;
  }

  if (command === 'stop') {
    const all = await running();
    const targets = flag('--all') ? all : all.filter((i) => i.root === root);
    if (!targets.length) {
      console.log(flag('--all') ? 'No papers are open.' : `Paper Assistant is not running on ${root}.`);
      if (!flag('--all') && all.length) console.log(`Open elsewhere:\n${all.map((i) => `  ${i.root}`).join('\n')}\nGive the folder, or use --all.`);
      return;
    }
    for (const inst of targets) {
      const ok = await stop(inst);
      console.log(ok ? `Stopped ${inst.root}` : `Could not stop ${inst.root} (process ${inst.pid})`);
      if (!ok) process.exitCode = 1;
    }
    return;
  }

  if (flag('--foreground', '-f')) {
    await import(server.href);
    return;
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exitCode = 1;
    return;
  }

  // One server per paper: a second start just shows the one that is running.
  const existing = (await running()).find((i) => i.root === root);
  if (existing) {
    console.log(`Paper Assistant is already running on ${root}\nOpen ${urlOf(existing)}`);
    if (!flag('--no-open')) openBrowser(urlOf(existing));
    return;
  }

  const log = logFile(root);
  const out = fs.openSync(log, 'w');
  const child = spawn(process.execPath, [fileURLToPath(server), ...argv], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  fs.closeSync(out);
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? 1));
  child.on('error', () => (exited = 1));

  // Up once it has put itself on record, which it does when it is listening.
  const printed = () => fs.readFileSync(log, 'utf8').trimEnd();
  for (let i = 0; i < 150 && exited === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await running()).some((inst) => inst.pid === child.pid)) {
      console.log(printed());
      console.log('\nRunning in the background. To close it: paper-assistant stop, or Quit in the app.');
      child.unref();
      return;
    }
  }
  if (exited !== null) {
    console.error(printed() || 'Paper Assistant could not start.');
    process.exitCode = exited || 1;
  } else {
    console.error(`Paper Assistant is taking long to start. Its output is in ${log}`);
    child.unref();
    process.exitCode = 1;
  }
}

await main();
// The foreground server keeps the process alive by itself; nothing else should.
if (!flag('--foreground', '-f') || command || flag('--help', '-h', '--version', '-v')) process.exit();
