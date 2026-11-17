import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserApp } from './cdp.mjs';
import { json, until } from '../helpers.mjs';

test('model and effort persist per agent and apply to chat and comments', async () => {
  const app = await browserApp();
  try {
    const state = (await app.api('/api/state')).body;
    state.agents = ['claude', 'codex'].map((name) => ({ name, label: name, available: true,
      models: [{ id: `${name}-model`, label: `${name} model`, efforts: ['low', 'high'] }], efforts: ['low', 'high', 'max'] }));
    const requests = [];
    app.on('Fetch.requestPaused', async (event) => {
      const isState = event.request.url.endsWith('/api/state');
      if (!isState) requests.push(JSON.parse(event.request.postData));
      await app.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(isState ? state : { ok: true })).toString('base64') });
    });
    await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/state' }, { urlPattern: '*/api/agent/send' }] });
    const reload = async () => {
      await app.send('Page.reload');
      await until(() => app.evaluate(`document.querySelector('#agent-models option')?.value === document.querySelector('[aria-label="Agent"]')?.value + '-model'`));
    };
    await reload();
    const select = async (label, value) => app.evaluate(`(() => {
      const el = document.querySelector('[aria-label="${label}"]');
      Object.getOwnPropertyDescriptor(${label === 'Model' ? 'HTMLInputElement' : 'HTMLSelectElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('${label === 'Model' ? 'input' : 'change'}', { bubbles: true }));
    })()`);
    await select('Agent', 'claude');
    await select('Model', 'claude-model');
    await select('Effort', 'high');
    assert.deepEqual(await app.evaluate(`Array.from(document.querySelector('[aria-label="Effort"]').options).map(o => o.value)`), ['', 'low', 'high']);
    await select('Agent', 'codex');
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Model"]').value`), '');
    await select('Model', 'custom-codex');
    await select('Effort', 'max');
    await select('Agent', 'claude');
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Model"]').value`), 'claude-model');
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Effort"]').value`), 'high');
    await reload();
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Effort"]').value`), 'high');
    await app.evaluate(`document.querySelector('.composer textarea').focus()`);
    await app.send('Input.insertText', { text: 'Use these settings' });
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await until(() => requests.length === 1);
    assert.equal(requests[0].agent, 'claude');
    assert.deepEqual(requests[0].options, { model: 'claude-model', effort: 'high' });
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Model"]').disabled && document.querySelector('[aria-label="Effort"]').disabled`), true);
    await app.api('/api/annotations', json('POST', { kind: 'comment', page: 1, text: 'Check this', rects: [{ x: 10, y: 10, w: 30, h: 10 }] }));
    await reload();
    await select('Agent', 'codex');
    await app.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(t => t.textContent.includes('Comments')).click()`);
    await until(() => app.evaluate(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Send all' && !b.disabled)`));
    await app.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Send all').click()`);
    await until(() => requests.length === 2);
    assert.deepEqual(requests[1].options, { model: 'custom-codex', effort: 'max' });
    assert.equal(requests[1].agent, 'codex');
    assert.equal(requests[1].threads.length, 1);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
