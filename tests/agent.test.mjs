import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('agent model catalogs, validation and CLI overrides work for fresh and resumed turns', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-agent-options-'));
  const keys = ['PAPER_ASSISTANT_CLAUDE', 'PAPER_ASSISTANT_CODEX', 'CODEX_HOME'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const command = path.join(temp, 'fake agent');
    fs.writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  fs.appendFileSync('calls.jsonl', JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'codex-session'}));
  console.log(JSON.stringify({type: 'result', session_id: 'claude-session'}));
});
`, { mode: 0o755 });
    process.env.PAPER_ASSISTANT_CLAUDE = command;
    process.env.PAPER_ASSISTANT_CODEX = command;
    process.env.CODEX_HOME = temp;
    fs.writeFileSync(path.join(temp, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'test-model', display_name: 'Test model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'hidden-model', visibility: 'hide' },
    ] }));
    const { Agents, agentModels, parseAgentOptions } = await import(`../server/agent.ts?options-test=${Date.now()}`);
    assert.deepEqual(agentModels('codex'), [{ id: 'test-model', label: 'Test model', efforts: ['low', 'high'] }]);
    assert.deepEqual(parseAgentOptions('claude', undefined), {});
    assert.deepEqual(parseAgentOptions('codex', { model: '', effort: '' }), {});
    assert.throws(() => parseAgentOptions('codex', { model: 'test-model', effort: 'max' }), /Invalid effort/);
    assert.throws(() => parseAgentOptions('claude', { model: '--bad-flag' }), /Invalid model/);
    assert.throws(() => parseAgentOptions('claude', { effort: 'ultra' }), /Invalid effort/);
    assert.throws(() => parseAgentOptions('claude', { model: [] }), /Invalid model/);
    assert.deepEqual(parseAgentOptions('codex', { model: 'custom-model', effort: 'high' }), { model: 'custom-model', effort: 'high' });
    for (const name of ['claude', 'codex']) {
      const agents = new Agents(temp, () => {}, () => null);
      const send = (options) => new Promise((resolve, reject) => agents.send(name, 'User prompt', (_, error) => error ? reject(new Error(error)) : resolve(), options));
      await send({ model: 'first-model', effort: 'high' });
      await send({ model: 'second-model', effort: 'low' });
      await send({});
      const calls = fs.readFileSync(path.join(temp, 'calls.jsonl'), 'utf8').trim().split('\n').slice(-3).map(JSON.parse);
      assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'first-model');
      assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], 'second-model');
      assert.equal(calls[0].args.includes(name === 'claude' ? '--resume' : 'resume'), false);
      assert.equal(calls[1].args.includes(name === 'claude' ? '--resume' : 'resume'), true, JSON.stringify({ name, calls, sessions: agents.sessionIds() }));
      assert.equal(calls[1].args.includes(`${name}-session`), true);
      if (name === 'claude') {
        assert.equal(calls[0].args[calls[0].args.indexOf('--effort') + 1], 'high');
        assert.equal(calls[1].args[calls[1].args.indexOf('--effort') + 1], 'low');
        assert.equal(calls[2].args.includes('--effort'), false);
      } else {
        assert.ok(calls[0].args.includes('model_reasoning_effort="high"'));
        assert.ok(calls[1].args.includes('model_reasoning_effort="low"'));
        assert.ok(calls[0].prompt.includes('You are working inside Paper Assistant'));
        assert.equal(calls[1].prompt, 'User prompt');
        assert.equal(calls[2].args.some((arg) => arg.startsWith('model_reasoning_effort=')), false);
      }
      assert.equal(calls[2].args.includes('--model'), false);
    }
    fs.writeFileSync(path.join(temp, 'models_cache.json'), 'broken');
    assert.deepEqual(agentModels('codex'), []);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
