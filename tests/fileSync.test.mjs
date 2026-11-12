import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeContents, CONFLICT_START } from '../src/fileSync.ts';

test('takes disk updates when there is no local typing', () => {
  assert.equal(mergeContents('old', 'old', 'new'), 'new');
});
test('retains unsaved typing when disk is unchanged or both agree', () => {
  assert.equal(mergeContents('old', 'typed', 'old'), 'typed');
  assert.equal(mergeContents('old', 'typed', 'typed'), 'typed');
});
test('merges independent edits, including multiple changes and offset shifts', () => {
  assert.equal(mergeContents('alpha\nbeta\ngamma\n', 'alpha typed\nbeta\ngamma typed\n', 'alpha\nBETA\ngamma\n'),
    'alpha typed\nBETA\ngamma typed\n');
  assert.equal(mergeContents('abc def ghi', 'abc LOCAL def ghi', 'abc def REMOTE ghi'), 'abc LOCAL def REMOTE ghi');
});
test('deduplicates identical shared changes', () => {
  assert.equal(mergeContents('aaa bbb ccc', 'AAA bbb CCC', 'AAA BBB ccc'), 'AAA BBB CCC');
});
test('preserves both complete versions when edits overlap', () => {
  const result = mergeContents('Original', 'Local typing', 'Agent edit');
  assert.equal(result, `${CONFLICT_START}\nLocal typing\n=======\nAgent edit\n>>>>>>> Disk changes\n`);
});
test('retains competing insertions and deletions as conflicts', () => {
  assert.match(mergeContents('abc', 'aXbc', 'aYbc'), /^<<<<<<< /);
  assert.match(mergeContents('abc def', 'abc', 'abc DEF'), /^<<<<<<< /);
});
