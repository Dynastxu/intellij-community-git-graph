import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import jsdom from 'jsdom';

const { JSDOM, VirtualConsole } = jsdom;

/** jsdom has no canvas backend; the demo must still render its rows. */
function stubCanvas(window, context = null) {
  window.HTMLCanvasElement.prototype.getContext = () => context;
}

/** Records the 2D calls of the graph painter. */
function recordingContext() {
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  return {
    calls,
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    setLineDash: record('setLineDash'),
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
  };
}

/** Loads packages/demo/index.html with the compiled scripts inlined, as a file:// page. */
async function loadDemo(context = null) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(String(error?.message ?? error)));
  virtualConsole.on('error', (error) => errors.push(String(error)));

  const bundle = readFileSync(resolve('packages/demo/build/git-graph.js'), 'utf8');
  const pageScript = readFileSync(resolve('packages/demo/build/page.js'), 'utf8');
  const html = readFileSync(resolve('packages/demo/index.html'), 'utf8')
    .replace('<script src="./build/git-graph.js"></script>', () => `<script>${bundle}</script>`)
    .replace('<script src="./build/page.js"></script>', () => `<script>${pageScript}</script>`);

  const dom = new JSDOM(html, {
    url: 'file:///packages/demo/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse: (window) => stubCanvas(window, context),
  });
  await new Promise((done) => setTimeout(done, 300));
  return { dom, errors };
}

/** Serves the page over HTTP and inlines the compiled scripts, with a stubbed API. */
async function loadHttpDemo(fetchStub) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(String(error?.message ?? error)));

  const bundle = readFileSync(resolve('packages/demo/build/git-graph.js'), 'utf8');
  const pageScript = readFileSync(resolve('packages/demo/build/page.js'), 'utf8');
  const html = readFileSync(resolve('packages/demo/index.html'), 'utf8')
    .replace('<script src="./build/git-graph.js"></script>', () => `<script>${bundle}</script>`)
    .replace('<script src="./build/page.js"></script>', () => `<script>${pageScript}</script>`);

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      stubCanvas(window);
      window.fetch = fetchStub;
    },
  });
  await new Promise((done) => setTimeout(done, 300));
  return { dom, errors };
}

const tick = () => new Promise((done) => setTimeout(done, 50));

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

function rows(dom) {
  return dom.window.document.querySelectorAll('#rows .log-row');
}

function subjects(dom) {
  return [...dom.window.document.querySelectorAll('#rows .log-subject .subject')].map((node) => node.textContent);
}

test('the demo page renders the graph rows', async () => {
  const { dom, errors } = await loadDemo();
  const document = dom.window.document;

  assert.deepEqual(errors, []);
  assert.equal(rows(dom).length, 18);
  assert.ok(document.getElementById('graphCanvas'));
  assert.match(document.getElementById('stats').textContent, /18 rows/);
  assert.match(document.getElementById('stats').textContent, /20 edges/);

  // Refs and subjects share the row text, and the text follows the graph of its row.
  assert.ok(subjects(dom).some((text) => text.includes("Merge branch 'feature/search'")));
  assert.ok(document.querySelector('#rows .log-subject .ref'), 'the HEAD row shows its ref');
  const indents = [...document.querySelectorAll('#rows .log-subject')].map((node) => node.style.paddingLeft);
  assert.ok(new Set(indents).size > 1, `row messages do not share one column: ${[...new Set(indents)].join(', ')}`);

  // The canvas is a fixed overlay, not a child of the scrolling rows.
  const list = document.getElementById('list');
  assert.equal(document.getElementById('graphCanvas').parentElement, list);
  assert.equal(document.getElementById('scroll').parentElement, list);
  dom.window.close();
});

test('the demo page paints nodes and straight half-edges on the canvas', async () => {
  const context = recordingContext();
  const { dom, errors } = await loadDemo(context);

  try {
    assert.deepEqual(errors, []);
    const calls = context.calls;
    assert.ok(calls.filter((call) => call[0] === 'arc').length >= 18, 'one dot per row');
    assert.ok(
      calls.some((call) => call[0] === 'stroke'),
      'edges are stroked',
    );

    // Row height 30: diagonal edges end at the neighbour row centre, rowHeight + rowCenter = 45.
    assert.ok(calls.some((call) => call[0] === 'lineTo' && Math.abs(call[2] - 45) < 0.01));
    // Node radius = 4 * rowHeight / 22.
    const arcs = calls.filter((call) => call[0] === 'arc');
    assert.ok(arcs.some((call) => Math.abs(call[3] - (4 * 30) / 22) < 0.1));
  } finally {
    dom.window.close();
  }
});

test('the demo page filters rows by text and branch', async () => {
  const { dom } = await loadDemo();
  const { window } = dom;
  const document = window.document;

  const text = document.getElementById('fText');
  text.value = 'login';
  text.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(rows(dom).length, 2);
  assert.match(document.getElementById('stats').textContent, /2 rows/);

  text.value = '';
  text.dispatchEvent(new window.Event('input', { bubbles: true }));
  const branch = document.getElementById('fBranch');
  branch.value = 'feature/search';
  branch.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(rows(dom).length > 2 && rows(dom).length < 18);

  dom.window.close();
});

test('the demo page reacts to the filter', async () => {
  const { dom } = await loadDemo();
  const { window } = dom;

  const hide = window.document.getElementById('hide');
  hide.value = '8c1e';
  hide.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(rows(dom).length, 17);
  assert.match(window.document.getElementById('stats').textContent, /17 rows/);
  dom.window.close();
});

test('the demo page applies a pasted history and reports bad JSON', async () => {
  const { dom } = await loadDemo();
  const { window } = dom;
  const document = window.document;
  const data = document.getElementById('data');

  data.value = '{ not json';
  document.getElementById('apply').click();
  assert.equal(document.getElementById('error').hidden, false);

  data.value = JSON.stringify({
    commits: [
      { id: 'b', parents: ['a'], subject: 'Second commit', timestamp: 2 },
      { id: 'a', parents: [], subject: 'First commit', timestamp: 1 },
    ],
    refs: [{ name: 'main', commit: 'b', kind: 'local' }],
  });
  document.getElementById('apply').click();

  assert.equal(document.getElementById('error').hidden, true);
  assert.equal(rows(dom).length, 2);
  assert.match(document.getElementById('source').textContent, /pasted JSON/);
  dom.window.close();
});

test('the demo page renders first-parent mode', async () => {
  const { dom } = await loadDemo();
  const { window } = dom;

  const sort = window.document.getElementById('sort');
  sort.value = 'first-parent';
  sort.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.equal(window.document.getElementById('error').hidden, true);
  assert.ok(rows(dom).length > 0);
  dom.window.close();
});

test('the folder picker explains that it needs the server when opened from file://', async () => {
  const { dom } = await loadDemo();
  const document = dom.window.document;

  document.getElementById('openFolder').click();
  await tick();

  const error = document.getElementById('folderError');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /pnpm run demo/);
  assert.equal(document.getElementById('folderModal').hidden, false);
  dom.window.close();
});

test('the folder picker browses folders and loads a repository', async () => {
  const fetchStub = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/browse')) {
      return jsonResponse({
        path: '/repo',
        parent: null,
        isRepo: false,
        entries: [
          { name: 'project', path: '/repo/project', isRepo: true },
          { name: 'plain', path: '/repo/plain', isRepo: false },
        ],
        roots: ['/'],
      });
    }
    if (value.startsWith('/api/git')) {
      assert.match(value, /limit=1000/);
      return jsonResponse({
        root: '/repo/project',
        commits: [
          { id: 'b', parents: ['a'], subject: 'Second', timestamp: 2 },
          { id: 'a', parents: [], subject: 'First', timestamp: 1 },
        ],
        refs: [{ name: 'main', commit: 'b', kind: 'local' }],
        truncated: false,
      });
    }
    return jsonResponse({ error: 'unknown endpoint' }, false, 404);
  };

  const { dom, errors } = await loadHttpDemo(fetchStub);
  const document = dom.window.document;

  assert.deepEqual(errors, []);
  document.getElementById('openFolder').click();
  await tick();

  const modal = document.getElementById('folderModal');
  assert.equal(modal.hidden, false);
  assert.equal(document.getElementById('folderPath').value, '/repo');
  const entries = [...document.querySelectorAll('#folderList li')];
  assert.equal(entries.length, 2);
  assert.ok(entries[0].querySelector('.repo'), 'a repository row has a git badge');

  entries[0].querySelector('.repo').click();
  await tick();

  assert.equal(modal.hidden, true);
  // The sample stays in the list; the opened repository is added to it.
  assert.equal(rows(dom).length, 20);
  assert.equal(document.querySelectorAll('#repos .repo-chip').length, 2);
  assert.match(document.getElementById('source').textContent, /\/repo\/project/);
  dom.window.close();
});

test('the folder picker uses the system folder dialog', async () => {
  const fetchStub = async (url, init) => {
    const value = String(url);
    if (value.startsWith('/api/pick')) {
      assert.equal(init?.method, 'POST');
      return jsonResponse({ path: '/picked/repo' });
    }
    if (value.startsWith('/api/browse')) {
      const request = new URL(value, 'http://127.0.0.1');
      return jsonResponse({
        path: request.searchParams.get('path') ?? '',
        parent: null,
        isRepo: false,
        entries: [],
        roots: ['/'],
      });
    }
    return jsonResponse({ error: 'unknown endpoint' }, false, 404);
  };

  const { dom } = await loadHttpDemo(fetchStub);
  const document = dom.window.document;

  document.getElementById('openFolder').click();
  await tick();
  document.getElementById('folderPick').click();
  await tick();

  assert.equal(document.getElementById('folderPath').value, '/picked/repo');
  assert.equal(document.getElementById('folderError').hidden, true);
  dom.window.close();
});
