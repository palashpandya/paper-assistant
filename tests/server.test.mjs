import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { startApp, until, delay, json } from './helpers.mjs';

test('HTTP saves reject stale writes and enforce filesystem and origin boundaries', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.api('/api/state')).body.main, 'main.tex');
    const beforeChat = (await app.api('/api/chat')).body;
    assert.equal((await app.api('/api/agent/send', json('POST', { agent: 'claude', prompt: 'Invalid settings', options: { effort: 'invalid' } }))).status, 400);
    assert.equal((await app.api('/api/agent/send', json('POST', { agent: 'codex', prompt: 'Invalid settings', options: { model: '--bad-flag' } }))).status, 400);
    assert.deepEqual((await app.api('/api/chat')).body, beforeChat);
    assert.equal((await app.api('/api/file?path=main.tex', json('PUT', { content: 'Missing expectation' }))).status, 400);
    fs.writeFileSync(path.join(app.root, 'main.tex'), 'External update');
    const stale = await app.api('/api/file?path=main.tex', json('PUT', { content: 'Stale', expected: app.original }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.content, 'External update');
    assert.equal(fs.readFileSync(path.join(app.root, 'main.tex'), 'utf8'), 'External update');
    const saved = await app.api('/api/file?path=main.tex', json('PUT', { content: 'Merged', expected: 'External update' }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.saved, true);
    fs.writeFileSync(path.join(app.temp, 'secret.tex'), 'Secret');
    fs.symlinkSync(path.join(app.temp, 'secret.tex'), path.join(app.root, 'link.tex'));
    assert.equal((await app.api('/api/file?path=link.tex')).status, 400);
    assert.equal((await app.api('/api/file?path=link.tex', json('PUT', { content: 'Overwrite', expected: 'Secret' }))).status, 400);
    assert.equal((await app.api('/api/state', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(app.url + '/api/state', { headers: { Host: 'untrusted.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
  } finally { await app.close(); }
});

test('mid-build changes are broadcast and rebuilt, while generated .bib files do not loop', async () => {
  const app = await startApp();
  const ws = new WebSocket(app.url.replace('http', 'ws') + '/ws');
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data)));
  try {
    await once(ws, 'open');
    const count = () => Number(fs.readFileSync(path.join(app.root, 'build-count'), 'utf8'));
    const before = count();
    fs.writeFileSync(path.join(app.root, 'hold-build'), '');
    await app.api('/api/compile', json('POST', {}));
    await until(() => count() === before + 1);
    const updated = app.original.replace('Alpha paragraph.', 'Agent changed alpha.');
    fs.writeFileSync(path.join(app.root, 'main.tex'), updated);
    // Let chokidar deliver its stable-file event while the build is held.
    await delay(250);
    assert.equal(messages.some((m) => m.type === 'fileChanged'), false);
    fs.writeFileSync(path.join(app.root, 'release-build'), '');
    await until(() => messages.some((m) => m.type === 'fileChanged' && m.content === updated), 'Deferred edit was never broadcast');
    await until(() => count() === before + 2, 'Deferred edit did not trigger a rebuild');
    await until(async () => !(await app.api('/api/state')).body.compiling);
    await delay(700);
    assert.equal(count(), before + 2, 'Generated bibliography triggered a rebuild loop');
    const state = (await app.api('/api/state')).body;
    assert.equal(state.files.some((f) => f.path === 'mainNotes.bib'), false);
    assert.equal(state.files.find((f) => f.path === 'main.tex').pending, true);
  } finally { ws.close(); await app.close(); }
});
