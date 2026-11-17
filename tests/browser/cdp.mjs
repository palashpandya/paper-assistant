import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startApp, until, stopChild } from '../helpers.mjs';

export async function browserApp() {
  const app = await startApp();
  const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(app.temp, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let spawnError;
  chrome.on('error', (err) => { spawnError = err; });
  let ws;
  try {
    const portFile = path.join(app.temp, 'chrome', 'DevToolsActivePort');
    await until(() => {
      if (spawnError) throw spawnError;
      if (chrome.exitCode !== null) throw new Error('Chrome exited before starting');
      return fs.existsSync(portFile);
    }, 'Chrome did not start; set CHROME_BIN to a Chrome/Chromium executable');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await once(ws, 'open');
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome command timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id) {
        const promise = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(promise?.timer);
        if (msg.error) promise?.reject(new Error(JSON.stringify(msg.error)));
        else promise?.resolve(msg.result);
      } else for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
    });
    const on = (method, cb) => listeners.set(method, [...(listeners.get(method) ?? []), cb]);
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const errors = [];
    on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails.text));
    await send('Runtime.enable');
    await send('Page.enable');
    // Do not depend on Chrome's platform-specific headless window size. Native
    // pointer tests need the three-pane workspace to fit inside the viewport.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__sockets = [];
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) { super(...args); window.__sockets.push(this); }
      };
    ` });
    await send('Page.navigate', { url: app.url });
    await until(() => evaluate(`document.querySelector('.cm-content')?.textContent.includes('Alpha paragraph.')`), 'Editor did not load');
    const append = async (text) => {
      await evaluate(`document.querySelector('.cm-content').focus()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', modifiers: 2 });
      await send('Input.insertText', { text });
    };
    const close = async () => {
      ws.close();
      await stopChild(chrome);
      await app.close();
    };
    return { ...app, send, on, evaluate, append, errors, close };
  } catch (err) {
    ws?.close();
    if (!spawnError) await stopChild(chrome);
    await app.close();
    throw err;
  }
}
