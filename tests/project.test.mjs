import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { Project } from '../server/project.ts';

describe('project files', () => {
let temp;
let root;
let project;
beforeEach(() => {
  temp = fs.mkdtempSync('/tmp/paper-project-test-');
  root = path.join(temp, 'paper');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\nOriginal\n');
  project = new Project(root);
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

test('discovers the main document and saves reviewed browser edits', () => {
  assert.equal(project.main, 'main.tex');
  const original = project.read('main.tex').content;
  assert.deepEqual(project.writeFromClient('main.tex', 'New', original), { saved: true, baseline: 'New' });
  assert.equal(project.files()[0].pending, false);
  assert.equal(project.onDiskChange('main.tex'), null);
});

test('rejects stale saves even before the watcher sees an external edit', () => {
  const original = project.read('main.tex').content;
  fs.writeFileSync(path.join(root, 'main.tex'), 'Agent edit');
  assert.deepEqual(project.writeFromClient('main.tex', 'Stale browser edit', original), {
    saved: false, content: 'Agent edit', baseline: original,
  });
  assert.equal(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), 'Agent edit');
});

test('keeps the reviewed baseline when saving over external edits', () => {
  const original = project.read('main.tex').content;
  fs.writeFileSync(path.join(root, 'main.tex'), 'Agent edit');
  assert.deepEqual(project.writeFromClient('main.tex', 'Merged edit', 'Agent edit'), { saved: true, baseline: original });
  assert.equal(project.files()[0].pending, true);
});

test('rejects lexical traversal and links to outside files and directories', () => {
  const outside = path.join(temp, 'outside.tex');
  fs.writeFileSync(outside, 'Do not change');
  fs.symlinkSync(outside, path.join(root, 'link.tex'));
  fs.symlinkSync(temp, path.join(root, 'outside'));
  for (const rel of ['../outside.tex', outside, 'link.tex', 'outside/new/deep.tex']) {
    assert.throws(() => project.abs(rel), /escapes project/);
  }
  assert.throws(() => project.read('link.tex'), /escapes project/);
  assert.throws(() => project.writeFromClient('link.tex', 'Overwrite', 'Do not change'), /escapes project/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Do not change');
  assert.equal(fs.existsSync(path.join(temp, 'new')), false);
});

test('rejects dangling symlinks but allows internal links and new subdirectories', () => {
  fs.symlinkSync(path.join(temp, 'missing.tex'), path.join(root, 'dangling.tex'));
  assert.throws(() => project.abs('dangling.tex'));
  fs.symlinkSync(path.join(root, 'main.tex'), path.join(root, 'internal.tex'));
  assert.equal(project.read('internal.tex').content, project.read('main.tex').content);
  assert.equal(project.writeFromClient('sub/new.tex', 'Created', '').saved, true);
});

test('supports opening the project through a symlink', () => {
  const alias = path.join(temp, 'alias');
  fs.symlinkSync(root, alias);
  assert.equal(new Project(alias).read('main.tex').content, project.read('main.tex').content);
});

});
