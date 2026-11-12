import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { until, delay } from '../helpers.mjs';
import { browserApp } from './cdp.mjs';

const disk = (app) => fs.readFileSync(path.join(app.root, 'main.tex'), 'utf8');

test('unsaved typing survives an independent external edit and autosaves both', async () => {
  const app = await browserApp();
  try {
    await app.append('LOCAL TYPING\n');
    fs.writeFileSync(path.join(app.root, 'main.tex'), app.original.replace('Alpha paragraph.', 'REMOTE ALPHA.'));
    await until(() => disk(app).includes('LOCAL TYPING') && disk(app).includes('REMOTE ALPHA'), 'Local or remote edit was lost');
    assert.equal(disk(app).includes('<<<<<<<'), false);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('overlapping unsaved and external edits retain both versions with a visible conflict', async () => {
  const app = await browserApp();
  try {
    await app.append('LOCAL END\n');
    fs.writeFileSync(path.join(app.root, 'main.tex'), app.original + 'REMOTE END\n');
    await until(() => disk(app).includes('<<<<<<< Your edits'), 'No conflict markers were saved');
    assert.match(disk(app), /LOCAL END/);
    assert.match(disk(app), /REMOTE END/);
    assert.equal(await app.evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('Both versions')`), true);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('reconnect reloads the active document without switching files', async () => {
  const app = await browserApp();
  try {
    await app.evaluate('window.__sockets.at(-1).close()');
    await until(() => app.evaluate(`document.body.textContent.includes('Disconnected from server')`));
    fs.writeFileSync(path.join(app.root, 'main.tex'), app.original.replace('Alpha paragraph.', 'CHANGED WHILE DISCONNECTED.'));
    await until(() => app.evaluate(`document.querySelector('.cm-content').textContent.includes('CHANGED WHILE DISCONNECTED.')`), 'Reconnect did not refresh active document');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('typing during a save survives switching files', async () => {
  const app = await browserApp();
  try {
    let intercepted = false;
    app.on('Fetch.requestPaused', async (event) => {
      if (event.request.method === 'PUT' && !intercepted) {
        intercepted = true;
        await delay(600);
      }
      await app.send('Fetch.continueRequest', { requestId: event.requestId });
    });
    await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/file*', requestStage: 'Request' }] });
    await app.append('FIRST EDIT\n');
    await until(() => intercepted);
    await app.append('SECOND EDIT\n');
    await app.evaluate(`Array.from(document.querySelectorAll('.sidebar .file')).find(el => el.textContent.includes('other.tex')).click()`);
    await until(() => disk(app).includes('FIRST EDIT') && disk(app).includes('SECOND EDIT'), 'Switching files lost typing during an in-flight save');
    await until(() => app.evaluate(`document.querySelector('.cm-content').textContent.includes('Other file')`));
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('a stale save merges disk changes even when their WebSocket event was missed', async () => {
  const app = await browserApp();
  try {
    let conflicts = 0;
    await app.send('Network.enable');
    app.on('Network.responseReceived', ({ response }) => {
      if (response.url.includes('/api/file') && response.status === 409) conflicts++;
    });
    await app.evaluate('window.__sockets.at(-1).close()');
    await until(() => app.evaluate(`document.body.textContent.includes('Disconnected from server')`));
    await app.append('OFFLINE TYPING\n');
    fs.writeFileSync(path.join(app.root, 'main.tex'), app.original.replace('Beta paragraph.', 'MISSED REMOTE EDIT.'));
    await until(() => disk(app).includes('OFFLINE TYPING') && disk(app).includes('MISSED REMOTE EDIT'), 'Stale save did not merge disk changes');
    assert.ok(conflicts > 0, 'Expected the stale write to receive HTTP 409');
    assert.equal(disk(app).includes('<<<<<<<'), false);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('a failed save retains typing and can be retried', async () => {
  const app = await browserApp();
  try {
    let failed = false;
    app.on('Fetch.requestPaused', async (event) => {
      if (event.request.method === 'PUT' && !failed) {
        failed = true;
        await app.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' });
      } else await app.send('Fetch.continueRequest', { requestId: event.requestId });
    });
    await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/file*', requestStage: 'Request' }] });
    await app.append('RETRY THIS EDIT\n');
    await until(() => app.evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('Could not save')`), 'Save failure was not shown');
    assert.equal(disk(app).includes('RETRY THIS EDIT'), false);
    assert.equal(await app.evaluate(`document.querySelector('.cm-content').textContent.includes('RETRY THIS EDIT')`), true);
    await app.evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Retry save').click()`);
    await until(() => disk(app).includes('RETRY THIS EDIT'), 'Retry did not save the preserved edit');
    await until(() => app.evaluate(`!document.querySelector('[role="alert"]')?.textContent.includes('Could not save')`));
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('a delayed file read cannot replace a newer live update', async () => {
  const app = await browserApp();
  try {
    let paused;
    app.on('Fetch.requestPaused', (event) => {
      if (event.request.method === 'GET' && !paused) paused = event;
      else void app.send('Fetch.continueRequest', { requestId: event.requestId });
    });
    await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/file*', requestStage: 'Response' }] });
    await app.evaluate('window.__sockets.at(-1).close()');
    await until(() => paused, 'Reconnect did not request the active file');
    fs.writeFileSync(path.join(app.root, 'main.tex'), app.original.replace('Alpha paragraph.', 'NEWER LIVE UPDATE.'));
    await until(() => app.evaluate(`document.querySelector('.cm-content').textContent.includes('NEWER LIVE UPDATE.')`));
    await app.send('Fetch.continueRequest', { requestId: paused.requestId });
    await delay(200);
    assert.equal(await app.evaluate(`document.querySelector('.cm-content').textContent.includes('NEWER LIVE UPDATE.')`), true);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('reloading unchanged disk content preserves pending typing without marking it as an agent edit', async () => {
  const app = await browserApp();
  try {
    let paused;
    app.on('Fetch.requestPaused', (event) => {
      if (event.request.method === 'GET' && !paused) paused = event;
      else void app.send('Fetch.continueRequest', { requestId: event.requestId });
    });
    await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/file*', requestStage: 'Response' }] });
    await app.evaluate('window.__sockets.at(-1).close()');
    await until(() => paused);
    await app.append('MY OWN TYPING\n');
    await app.send('Fetch.continueRequest', { requestId: paused.requestId });
    await delay(150);
    assert.equal(await app.evaluate(`document.querySelector('.cm-content').textContent.includes('MY OWN TYPING')`), true);
    assert.equal(await app.evaluate(`!!document.querySelector('.review-label')`), false);
    await until(() => disk(app).includes('MY OWN TYPING'));
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
