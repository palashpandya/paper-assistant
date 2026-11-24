import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliSessions, sessionTitle, cliTranscript } from '../server/cliHistory.ts';

test('CLI history includes enclosing repository sessions and respects repository boundaries', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-history-'));
  // Ignore project markers outside the disposable fixture.
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (file) => ['.git', 'AGENTS.md', 'CLAUDE.md'].includes(path.basename(String(file))) && !String(file).startsWith(temp + path.sep) ? false : exists(file));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(temp, 'codex');
  const config = path.join(temp, 'claude');
  const repo = path.join(temp, 'repo');
  const paper = path.join(repo, 'papers', 'draft');
  fs.mkdirSync(paper, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  const sessions = (dir, number) => {
    const title = `Conversation ${number}`;
    const claude = path.join(config, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, `claude-${number}.jsonl`), JSON.stringify({ type: 'user', cwd: dir, message: { content: title } }) + '\n');
    const codex = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '23');
    fs.mkdirSync(codex, { recursive: true });
    const id = `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
    fs.writeFileSync(path.join(codex, `rollout-${id}.jsonl`), [
      { type: 'session_meta', payload: { cwd: dir, id } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    return [`claude-${number}`, id];
  };
  const ids = (root) => cliSessions(root, config).map((s) => s.sessionId).sort();
  try {
    const expected = [...sessions(repo, 1), ...sessions(path.dirname(paper), 2), ...sessions(paper, 3)].sort();
    sessions(temp, 4);
    sessions(path.join(temp, 'unrelated'), 5);
    assert.deepEqual(ids(paper), expected);
    for (const session of cliSessions(paper, config)) {
      assert.match(sessionTitle(session), /^Conversation [123]$/);
      assert.equal(cliTranscript(paper, session)[0].parts[0].text, sessionTitle(session));
    }
    // A worktree has a .git file rather than a directory.
    fs.rmSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /unused/worktree\n');
    assert.deepEqual(ids(paper), expected);
    // Launching through a symlink must find sessions recorded against the physical path.
    const alias = path.join(temp, 'paper-link');
    fs.symlinkSync(paper, alias, 'dir');
    assert.deepEqual(ids(alias), expected);
    const aliasSessions = sessions(alias, 6);
    assert.deepEqual(ids(alias), [...expected, ...aliasSessions].sort());
    for (const session of cliSessions(alias, config).filter((s) => aliasSessions.includes(s.sessionId))) {
      assert.equal(session.folder, '');
    }
    const repoAlias = path.join(temp, 'repo-link');
    fs.symlinkSync(repo, repoAlias, 'dir');
    assert.deepEqual(ids(path.join(repoAlias, 'papers', 'draft')), [...expected, aliasSessions[1]].sort());
    // Without a repository, only this folder's sessions belong in the list.
    fs.rmSync(path.join(repo, '.git'));
    assert.deepEqual(ids(paper), [...expected.filter((id) => id === 'claude-3' || id.endsWith('000000000003')), aliasSessions[1]].sort());
    // Agent instructions identify non-Git projects such as min-hsd.
    for (const marker of ['AGENTS.md', 'CLAUDE.md']) {
      fs.writeFileSync(path.join(repo, marker), 'Project instructions\n');
      assert.deepEqual(ids(paper), [...expected, aliasSessions[1]].sort());
      fs.rmSync(path.join(repo, marker));
    }
    // A nested instruction file is the fallback boundary; Git still takes precedence.
    fs.writeFileSync(path.join(path.dirname(paper), 'AGENTS.md'), 'Nested instructions\n');
    assert.deepEqual(ids(paper), [...expected.filter((id) => id !== 'claude-1' && !id.endsWith('000000000001')), aliasSessions[1]].sort());
    fs.mkdirSync(path.join(repo, '.git'));
    assert.deepEqual(ids(paper), [...expected, aliasSessions[1]].sort());
    fs.rmSync(path.join(repo, '.git'), { recursive: true });
    fs.rmSync(path.join(path.dirname(paper), 'AGENTS.md'));
    // Home-wide instructions must not bring unrelated projects into History.
    t.mock.method(os, 'homedir', () => temp);
    fs.writeFileSync(path.join(temp, 'AGENTS.md'), 'Global instructions\n');
    assert.deepEqual(ids(paper), [...expected.filter((id) => id === 'claude-3' || id.endsWith('000000000003')), aliasSessions[1]].sort());
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
