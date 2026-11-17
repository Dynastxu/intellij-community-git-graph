import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGraph,
  colorFromId,
  sortTopologicallyByDate,
} from '../dist/index.js';

/** A linear history: c3 -> c2 -> c1 -> c0. */
function linearHistory() {
  return {
    commits: [
      { id: 'c3', parents: ['c2'], timestamp: 3000 },
      { id: 'c2', parents: ['c1'], timestamp: 2000 },
      { id: 'c1', parents: ['c0'], timestamp: 1000 },
      { id: 'c0', parents: [], timestamp: 0 },
    ],
    refs: [{ name: 'main', commit: 'c3', kind: 'local' }],
  };
}

/** A merge: m -> (a, b), a -> c, b -> c. */
function mergeHistory() {
  return {
    commits: [
      { id: 'm', parents: ['a', 'b'], timestamp: 5000 },
      { id: 'a', parents: ['c'], timestamp: 4000 },
      { id: 'b', parents: ['c'], timestamp: 4000 },
      { id: 'c', parents: [], timestamp: 1000 },
    ],
    refs: [
      { name: 'main', commit: 'm', kind: 'local' },
      { name: 'feature', commit: 'b', kind: 'local' },
    ],
  };
}

function rowsOf(result) {
  return result.rows.map((row) => row.commit.id);
}

test('a linear history keeps every commit in one column', () => {
  const result = buildGraph(linearHistory(), { sort: 'intellisort' });

  assert.deepEqual(rowsOf(result), ['c3', 'c2', 'c1', 'c0']);
  assert.equal(result.rowCount, 4);
  assert.equal(result.width, 1);
  assert.equal(result.layout.width, 1);
  for (const row of result.rows) {
    assert.equal(row.node.position, 0);
    assert.equal(row.node.column, 1);
  }
  assert.equal(result.edges.length, 3);
  for (const edge of result.edges) {
    assert.equal(edge.style, 'solid');
    assert.ok(edge.from < edge.to);
  }
});

test('a merge keeps the topological order and the layout columns', () => {
  const result = buildGraph(mergeHistory(), { sort: 'intellisort' });

  assert.deepEqual(new Set(rowsOf(result)), new Set(['m', 'a', 'b', 'c']));
  assert.equal(result.rowCount, 4);

  const columns = new Map(result.rows.map((row) => [row.commit.id, row.node.column]));
  assert.equal(columns.get('m'), 1);
  assert.equal(columns.get('a'), 1);
  assert.equal(columns.get('b'), 2);
  assert.equal(columns.get('c'), 1);

  for (const edge of result.edges) {
    assert.ok(edge.from < edge.to, `edge ${edge.from} -> ${edge.to} points downwards`);
  }
  // IntelliSort places the incoming branch below the merge commit.
  assert.deepEqual(rowsOf(result), ['m', 'b', 'a', 'c']);
});

test('input order can be kept instead of IntelliSort', () => {
  const result = buildGraph(mergeHistory(), { sort: 'input' });
  assert.deepEqual(rowsOf(result), ['m', 'a', 'b', 'c']);
});

test('a custom sort function controls the row order', () => {
  let calls = 0;
  const result = buildGraph(mergeHistory(), {
    sort: (context) => {
      calls++;
      assert.equal(context.commits.length, 4);
      assert.equal(context.parents.length, 4);
      return [0, 1, 2, 3];
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(rowsOf(result), ['m', 'a', 'b', 'c']);
});

test('a custom sort that breaks the topological order is rejected', () => {
  assert.throws(
    () => buildGraph(mergeHistory(), { sort: () => [3, 2, 1, 0] }),
    /not topological/,
  );
});

test('hiding a commit contracts it into a dashed edge', () => {
  const result = buildGraph(mergeHistory(), {
    sort: 'input',
    visibleCommits: (commit) => commit.id !== 'b',
  });

  assert.deepEqual(rowsOf(result), ['m', 'a', 'c']);
  const edges = result.edges.map((edge) => `${edge.from}-${edge.to}-${edge.style}`).sort();
  assert.ok(edges.includes('0-3-dashed'), `m -> c must be dashed, got ${edges}`);
  assert.ok(edges.includes('0-1-solid'), 'm -> a stays solid');
  assert.ok(!edges.some((edge) => edge.startsWith('2-')), 'no edge starts at the hidden commit');
});

test('visible heads hide everything that is not an ancestor', () => {
  const result = buildGraph(mergeHistory(), { visibleHeads: ['b'] });
  assert.deepEqual(rowsOf(result), ['b', 'c']);
});

test('first-parent mode keeps branch heads and hides merged edges', () => {
  const result = buildGraph(mergeHistory(), { firstParent: true });
  // IntelliJ keeps the heads of the visible branches, so the feature head stays.
  assert.deepEqual(rowsOf(result), ['m', 'a', 'b', 'c']);
  assert.deepEqual(
    result.edges.map((edge) => `${edge.from}-${edge.to}`).sort(),
    ['0-1', '1-3', '2-3'],
  );
});

test('a missing parent becomes a terminal arrow', () => {
  const result = buildGraph({
    commits: [{ id: 'x', parents: ['missing'], timestamp: 1 }],
  });
  assert.equal(result.rowCount, 1);
  const arrow = result.rows[0].elements.find((element) => element.kind === 'edge');
  assert.ok(arrow);
  assert.equal(arrow.to, -1);
  assert.equal(arrow.arrow, true);
  assert.equal(arrow.direction, 'down');
  // The stub sits in the commit column, directly below the dot.
  assert.equal(arrow.position, result.rows[0].node.position);
  assert.equal(arrow.row, result.rows[0].row);
});

test('a long edge is drawn near its endpoints only', () => {
  const commits = [{ id: 'head', parents: ['p1'], timestamp: 100 }];
  for (let i = 35; i >= 1; i--) {
    commits.push({
      id: `p${i}`,
      parents: i > 1 ? [`p${i - 1}`] : [],
      timestamp: 100 - (36 - i),
    });
  }
  const result = buildGraph({ commits }, { sort: 'input' });
  assert.equal(result.rowCount, 36);

  const topFragments = result.rows[0].elements.filter((element) => element.kind === 'edge');
  assert.ok(topFragments.some((fragment) => fragment.long && fragment.from === 0));

  const middleFragments = result.rows[15].elements.filter((element) => element.kind === 'edge');
  assert.ok(
    !middleFragments.some((fragment) => fragment.from === 0 && fragment.to === 35),
    'the middle of a long edge has no fragment',
  );
});

test('colors can be replaced by the caller', () => {
  const byString = buildGraph(mergeHistory(), { color: () => 'red' });
  for (const row of byString.rows) {
    assert.equal(row.node.color, 'red');
    for (const element of row.elements) {
      if (element.kind === 'edge') assert.equal(element.color, 'red');
    }
  }

  const byId = buildGraph(mergeHistory(), { color: () => 42 });
  for (const row of byId.rows) {
    assert.equal(row.node.colorId, 42);
  }
});

test('the default color id follows GraphColorManagerImpl', () => {
  const result = buildGraph(mergeHistory());
  const headNode = result.rows.find((row) => row.commit.id === 'm').node;
  const mergedNode = result.rows.find((row) => row.commit.id === 'b').node;
  // The head column takes the hash of the head ref.
  assert.equal(headNode.colorId, 'main'.split('').reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 0));
  // Every other column takes its layout index as the color id.
  assert.equal(mergedNode.column, 2);
  assert.equal(mergedNode.colorId, 2);
});

test('colorFromId returns a hex color', () => {
  assert.equal(colorFromId(0), '#000000');
  assert.match(colorFromId(7), /^#[0-9a-f]{6}$/);
  assert.notEqual(colorFromId(7), colorFromId(8));
});

test('sortTopologicallyByDate orders parents after children', () => {
  const commits = [
    { id: 'root', parents: [], timestamp: 1 },
    { id: 'b', parents: ['root'], timestamp: 5 },
    { id: 'a', parents: ['root'], timestamp: 3 },
    { id: 'head', parents: ['a', 'b'], timestamp: 9 },
  ];
  const sorted = sortTopologicallyByDate(commits);
  const position = new Map(sorted.map((commit, index) => [commit.id, index]));
  assert.ok(position.get('head') < position.get('a'));
  assert.ok(position.get('head') < position.get('b'));
  assert.ok(position.get('a') < position.get('root'));
  assert.ok(position.get('b') < position.get('root'));
  assert.equal(sorted[0].id, 'head');
});

test('a commit subject is kept for the renderer', () => {
  const result = buildGraph({
    commits: [{ id: 'a', parents: [], subject: 'Initial commit', timestamp: 1 }],
  });
  assert.equal(result.rows[0].commit.subject, 'Initial commit');
});

test('refs are grouped by commit index', () => {
  const result = buildGraph(mergeHistory());
  assert.equal(result.refsByCommit.get(0)[0].name, 'main');
  assert.equal(result.refsByCommit.get(2)[0].name, 'feature');
});

test('empty input produces an empty graph', () => {
  const result = buildGraph({ commits: [] });
  assert.equal(result.rowCount, 0);
  assert.equal(result.width, 0);
  assert.deepEqual(result.rows, []);
});

test('filtering every commit leaves an empty graph', () => {
  const result = buildGraph(mergeHistory(), { visibleCommits: () => false });
  assert.equal(result.rowCount, 0);
  assert.equal(result.width, 0);
  assert.deepEqual(result.edges, []);
});

test('a custom head comparator changes the column order', () => {
  const left = buildGraph(mergeHistory());
  const right = buildGraph(mergeHistory(), {
    headComparator: (a, b) => Number(a.refs[0]?.name === 'main') - Number(b.refs[0]?.name === 'main'),
  });
  const columnOf = (result, id) => result.rows.find((row) => row.commit.id === id).node.column;
  assert.equal(columnOf(left, 'm'), 1);
  assert.equal(columnOf(right, 'm'), 2);
});
