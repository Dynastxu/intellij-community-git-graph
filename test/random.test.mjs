import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGraph } from '../dist/index.js';

/** Deterministic pseudo random generator, so failures reproduce. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random topological history: parents always have a greater index. */
function randomHistory(seed, size) {
  const random = mulberry32(seed);
  const commits = [];
  for (let i = 0; i < size; i++) {
    const parents = [];
    const parentCount = i === size - 1 ? 0 : random() < 0.25 ? 2 : 1;
    for (let p = 0; p < parentCount; p++) {
      const parent = i + 1 + Math.floor(random() * Math.min(6, size - i - 1));
      if (parent > i && !parents.includes(`c${parent}`)) parents.push(`c${parent}`);
    }
    commits.push({ id: `c${i}`, parents, timestamp: (size - i) * 1000 });
  }
  const refs = [];
  for (const index of [0, Math.floor(size / 2), size - 1]) {
    refs.push({ name: `branch-${index}`, commit: `c${index}`, kind: 'local' });
  }
  return { commits, refs };
}

function checkInvariants(result, { expectedRows } = {}) {
  assert.equal(result.rowCount, result.rows.length);
  if (expectedRows !== undefined) assert.equal(result.rowCount, expectedRows);

  const seen = new Set();
  for (const row of result.rows) {
    assert.ok(!seen.has(row.commit.id), `duplicate commit ${row.commit.id}`);
    seen.add(row.commit.id);
    assert.equal(row.node.row, row.row);
    assert.equal(row.node.commitIndex, row.commitIndex);
    assert.ok(row.node.position >= 0 && row.node.position < Math.max(1, result.width));
    assert.equal(row.elements[row.elements.length - 1], row.node, 'the node is drawn last');
  }

  for (const row of result.rows) {
    for (const element of row.elements) {
      if (element.kind !== 'edge') continue;
      assert.equal(element.row, row.row);
      assert.ok(element.position >= 0 && element.position < Math.max(1, result.width));
      assert.ok(element.otherPosition >= 0);
      assert.ok(element.from >= 0);
      if (element.to >= 0) {
        assert.ok(element.from < element.to, `edge ${element.from} -> ${element.to} points up`);
        assert.ok(element.otherRow >= 0 && element.otherRow < result.rowCount);
      } else {
        assert.equal(element.arrow, true);
        assert.ok(element.otherRow >= 0);
      }
      if (element.direction === 'down') {
        assert.equal(element.otherRow, row.row + 1);
      } else {
        assert.equal(element.otherRow, row.row - 1);
      }
    }
  }

  for (const edge of result.edges) {
    assert.ok(edge.from < edge.to);
    assert.ok(['solid', 'dashed'].includes(edge.style));
  }
}

test('random histories keep the graph invariants (IntelliSort)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const history = randomHistory(seed, 40 + seed);
    const result = buildGraph(history);
    checkInvariants(result, { expectedRows: history.commits.length });
  }
});

test('random histories keep the graph invariants (input order)', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const history = randomHistory(seed * 7, 30 + seed);
    const result = buildGraph(history, { sort: 'input' });
    checkInvariants(result, { expectedRows: history.commits.length });
  }
});

test('random histories keep the graph invariants when commits are filtered', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const history = randomHistory(seed * 13, 30 + seed);
    const visible = new Set();
    history.commits.forEach((commit, index) => {
      if (index % 3 !== 0) visible.add(commit.id);
    });
    const result = buildGraph(history, {
      visibleCommits: (commit) => visible.has(commit.id),
    });
    checkInvariants(result, { expectedRows: visible.size });
  }
});

test('random histories keep the graph invariants in first-parent mode', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const history = randomHistory(seed * 17, 30 + seed);
    const result = buildGraph(history, { firstParent: true });
    checkInvariants(result);
    // Every commit has at most one visible parent.
    const downCount = new Map();
    for (const edge of result.edges) {
      downCount.set(edge.from, (downCount.get(edge.from) ?? 0) + 1);
    }
    for (const count of downCount.values()) assert.ok(count <= 1);
  }
});

test('the layout is deterministic', () => {
  const history = randomHistory(42, 60);
  const first = buildGraph(history);
  const second = buildGraph(history);
  assert.deepEqual(
    first.rows.map((row) => row.commit.id),
    second.rows.map((row) => row.commit.id),
  );
  assert.deepEqual(
    first.rows.map((row) => row.node.column),
    second.rows.map((row) => row.node.column),
  );
});

test('custom colors and data reach nodes and edges', () => {
  const history = randomHistory(3, 25);
  const result = buildGraph(history, {
    color: (context) => (context.kind === 'node' ? 'blue' : 'gray'),
    data: (commit) => commit.id.toUpperCase(),
  });
  for (const row of result.rows) {
    assert.equal(row.node.color, 'blue');
    assert.equal(row.node.data, row.commit.id.toUpperCase());
    for (const element of row.elements) {
      if (element.kind === 'edge') assert.equal(element.color, 'gray');
    }
  }
});
