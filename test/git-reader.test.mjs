import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { parseCommits, parseRefs, readGitHistory } from '../demo/build/server.js';

const fixture = (name) => readFileSync(resolve('test/fixtures', name), 'utf8');

function makeRunGit(calls = []) {
  return async (args) => {
    calls.push(args);
    if (args.includes('--show-toplevel')) return '/repo\n';
    if (args.includes('log')) return fixture('git-log.txt');
    if (args.includes('for-each-ref')) return fixture('git-refs.txt');
    if (args.includes('symbolic-ref')) return fixture('git-head-name.txt');
    if (args.includes('rev-parse') && args.includes('HEAD')) return fixture('git-head.txt');
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };
}

test('parseCommits reads hashes, parents, and millisecond timestamps', () => {
  const commits = parseCommits(fixture('git-log.txt'));

  assert.equal(commits.length, 4);
  assert.deepEqual(commits[0], {
    id: '90c3b73417b7a5ad9f7638b3c68672a20fd04aa2',
    parents: ['320456d9c8d244d7e20f64c5bff41ec3517bfd5b', '682c1f521a6676e49538ffbb688c74edcf798854'],
    subject: 'merge feature',
    timestamp: 1794903818000,
  });
  assert.deepEqual(commits[3].parents, []);
});

test('parseRefs maps ref kinds and peels annotated tags', () => {
  const refs = parseRefs(fixture('git-refs.txt'));

  assert.deepEqual(refs, [
    { name: 'feature', commit: '682c1f521a6676e49538ffbb688c74edcf798854', kind: 'local' },
    { name: 'master', commit: '90c3b73417b7a5ad9f7638b3c68672a20fd04aa2', kind: 'local' },
    { name: 'v1.0', commit: '320456d9c8d244d7e20f64c5bff41ec3517bfd5b', kind: 'tag' },
  ]);
});

test('readGitHistory adds HEAD and keeps the real git output order', async () => {
  const calls = [];
  const history = await readGitHistory('/repo', { runGit: makeRunGit(calls), limit: 100 });

  assert.equal(history.root, '/repo');
  assert.equal(history.truncated, false);
  assert.equal(history.commits.length, 4);
  assert.equal(history.commits[0].id, '90c3b73417b7a5ad9f7638b3c68672a20fd04aa2');

  assert.equal(history.refs[0].kind, 'head');
  assert.equal(history.refs[0].name, 'HEAD');
  assert.equal(history.refs[0].commit, '90c3b73417b7a5ad9f7638b3c68672a20fd04aa2');

  assert.deepEqual(
    history.refs.slice(1).map((ref) => `${ref.kind}:${ref.name}`),
    ['local:feature', 'local:master', 'tag:v1.0'],
  );

  const logArgs = calls.find((args) => args.includes('log'));
  assert.ok(logArgs.includes('--exclude=refs/stash'), 'stash is excluded');
  assert.ok(logArgs.includes('--exclude=refs/notes/*'), 'notes are excluded');
  assert.ok(logArgs.includes('--date-order'), 'rows keep the git date order');
});

test('readGitHistory reports truncation after the limit', async () => {
  const history = await readGitHistory('/repo', { runGit: makeRunGit(), limit: 2 });

  assert.equal(history.truncated, true);
  assert.equal(history.commits.length, 2);
});

test('readGitHistory rejects a folder that is not a repository', async () => {
  const runGit = async (args) => {
    if (args.includes('--show-toplevel')) {
      const error = new Error('git failed');
      error.stderr = 'fatal: not a git repository';
      throw error;
    }
    throw new Error('Unexpected call');
  };

  await assert.rejects(() => readGitHistory('/plain/folder', { runGit }), /Not a git repository/);
  await assert.rejects(() => readGitHistory('', { runGit }), /Select a repository folder/);
});
