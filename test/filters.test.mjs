import assert from 'node:assert/strict';
import test from 'node:test';

import { applyFilters, mergeRepositories } from '../dist/index.js';

const commits = [
  { id: 'm', parents: ['a', 'b'], subject: 'merge feature', author: 'Alice', authorEmail: 'alice@example.com', timestamp: 500, files: ['src/app.ts'] },
  { id: 'a', parents: ['c'], subject: 'add login', author: 'Bob', authorEmail: 'bob@example.com', timestamp: 400, files: ['src/login.ts'] },
  { id: 'b', parents: ['c'], subject: 'fix docs', author: 'Alice', authorEmail: 'alice@example.com', timestamp: 300, files: ['docs/readme.md'] },
  { id: 'c', parents: [], subject: 'initial', author: 'Bob', authorEmail: 'bob@example.com', timestamp: 100, files: ['src/app.ts'] },
];
const refs = [
  { name: 'main', commit: 'm', kind: 'local' },
  { name: 'feature', commit: 'b', kind: 'local' },
];
const input = { commits, refs };

function matched(filters) {
  const result = applyFilters(input, filters);
  return commits.filter((_, index) => result.matched[index]).map((commit) => commit.id);
}

test('text filter searches subject, id, and author', () => {
  assert.deepEqual(matched([{ kind: 'text', text: 'login' }]), ['a']);
  assert.deepEqual(matched([{ kind: 'text', text: 'Alice' }]), ['m', 'b']);
  assert.deepEqual(matched([{ kind: 'text', text: '^fix' , regex: true }]), ['b']);
  assert.deepEqual(matched([{ kind: 'text', text: 'LOGIN', matchCase: true }]), []);
});

test('hash filter matches prefixes', () => {
  assert.deepEqual(matched([{ kind: 'hash', hashes: ['m'] }]), ['m']);
  assert.deepEqual(matched([{ kind: 'hash', hashes: ['a', 'b'] }]), ['a', 'b']);
});

test('user and date filters', () => {
  assert.deepEqual(matched([{ kind: 'user', users: ['alice'] }]), ['m', 'b']);
  assert.deepEqual(matched([{ kind: 'user', users: ['bob@example.com'] }]), ['a', 'c']);
  assert.deepEqual(matched([{ kind: 'date', after: 200 }]), ['m', 'a', 'b']);
  assert.deepEqual(matched([{ kind: 'date', before: 300 }]), ['c']);
});

test('root filter uses the merged roots', () => {
  const merged = mergeRepositories([
    { root: '/one', commits: commits.slice(0, 3), refs: refs.slice(0, 1) },
    { root: '/two', commits: [commits[1], commits[2], commits[3]], refs: refs.slice(1) },
  ]);
  const result = applyFilters(merged, [{ kind: 'root', roots: ['/two'] }]);
  const ids = merged.commits.filter((_, index) => result.matched[index]).map((commit) => commit.id);
  assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
});

test('branch and revision filters restrict the visible heads', () => {
  const branch = applyFilters(input, [{ kind: 'branch', branches: ['feature'] }]);
  const branchIds = commits.filter((_, index) => branch.matched[index]).map((commit) => commit.id);
  assert.deepEqual(branchIds, ['b', 'c']);
  assert.deepEqual(branch.heads, ['b']);

  const revision = applyFilters(input, [{ kind: 'revision', commits: ['a'] }]);
  const revisionIds = commits.filter((_, index) => revision.matched[index]).map((commit) => commit.id);
  assert.deepEqual(revisionIds, ['a', 'c']);
});

test('range filter excludes the from-side ancestors', () => {
  const result = applyFilters(input, [{ kind: 'range', ranges: [{ from: 'a', to: 'm' }] }]);
  const ids = commits.filter((_, index) => result.matched[index]).map((commit) => commit.id);
  assert.deepEqual(ids, ['m', 'b']);
});

test('parent and structure filters', () => {
  assert.deepEqual(matched([{ kind: 'parent', merges: true }]), ['m']);
  assert.deepEqual(matched([{ kind: 'parent', merges: false }]), ['a', 'b', 'c']);
  assert.deepEqual(matched([{ kind: 'structure', paths: ['docs'] }]), ['b']);
  assert.deepEqual(matched([{ kind: 'structure', paths: ['*.md'] }]), ['b']);
});

test('different filters combine with AND', () => {
  assert.deepEqual(matched([
    { kind: 'user', users: ['alice'] },
    { kind: 'text', text: 'docs' },
  ]), ['b']);
});

test('mergeRepositories merges the same commit and keeps roots on refs', () => {
  const merged = mergeRepositories([
    { root: '/one', commits: [commits[0], commits[1]], refs: [{ name: 'main', commit: 'm' }] },
    { root: '/two', commits: [commits[2], commits[3]], refs: [{ name: 'feature', commit: 'b' }] },
  ]);
  assert.deepEqual(merged.roots, ['/one', '/two']);
  assert.equal(merged.refs[0].root, '/one');
  assert.equal(merged.refs[1].root, '/two');
  const ids = merged.commits.map((commit) => commit.id);
  assert.deepEqual(new Set(ids), new Set(['m', 'a', 'b', 'c']));
});
