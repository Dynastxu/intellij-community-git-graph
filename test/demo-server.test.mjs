import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { createDemoServer, listen } from '../demo/build/server.js';

test('the demo server serves the page, the bundle, and only the demo directory', async () => {
  const server = createDemoServer({ root: resolve('demo') });
  const port = await listen(server, 0);

  try {
    const url = `http://127.0.0.1:${port}`;

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>IntelliJ commit graph/);
    assert.match(html, /src="\.\/build\/git-graph\.js"/);
    assert.match(html, /src="\.\/build\/page\.js"/);

    const bundle = await fetch(`${url}/build/git-graph.js`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type'), /javascript/);
    assert.match(await bundle.text(), /GitGraph/);

    const pageScript = await fetch(`${url}/build/page.js`);
    assert.equal(pageScript.status, 200);
    assert.match(await pageScript.text(), /buildGraph/);

    const missing = await fetch(`${url}/does-not-exist.txt`);
    assert.equal(missing.status, 404);

    const traversal = await fetch(`${url}/..%2fpackage.json`);
    assert.ok([403, 404].includes(traversal.status), `traversal status ${traversal.status}`);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the demo server exposes the browse and git API', async () => {
  const api = {
    browse: async (path) => ({ path: path || '/home', parent: null, isRepo: false, entries: [], roots: ['/'] }),
    git: async (path, options) => {
      if (path === '/not-a-repo') {
        throw Object.assign(new Error('Not a git repository: /not-a-repo'), { status: 400 });
      }
      return { root: path, commits: [], refs: [], truncated: false, limit: options.limit };
    },
    pick: async () => '/picked/folder',
  };

  const server = createDemoServer({ api });
  const port = await listen(server, 0);

  try {
    const url = `http://127.0.0.1:${port}`;

    const browse = await fetch(`${url}/api/browse?path=${encodeURIComponent('/tmp')}`);
    assert.equal(browse.status, 200);
    assert.equal((await browse.json()).path, '/tmp');

    const history = await fetch(`${url}/api/git?path=${encodeURIComponent('/repo')}&limit=50`);
    assert.equal(history.status, 200);
    assert.equal(history.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await history.json(), { root: '/repo', commits: [], refs: [], truncated: false, limit: 50 });

    const pick = await fetch(`${url}/api/pick`, { method: 'POST' });
    assert.equal(pick.status, 200);
    assert.deepEqual(await pick.json(), { path: '/picked/folder' });

    const pickGet = await fetch(`${url}/api/pick`);
    assert.equal(pickGet.status, 405);

    const failed = await fetch(`${url}/api/git?path=${encodeURIComponent('/not-a-repo')}`);
    assert.equal(failed.status, 400);
    assert.match((await failed.json()).error, /Not a git repository/);

    const unknown = await fetch(`${url}/api/nope`);
    assert.equal(unknown.status, 404);

    const post = await fetch(`${url}/api/browse`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the demo server maps a failing system dialog to 501', async () => {
  const api = {
    browse: async () => ({ path: '/', parent: null, isRepo: false, entries: [], roots: ['/'] }),
    git: async () => ({ root: '/', commits: [], refs: [], truncated: false }),
    pick: async () => {
      throw Object.assign(new Error('No native folder dialog found'), { status: 501 });
    },
  };

  const server = createDemoServer({ api });
  const port = await listen(server, 0);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/pick`, { method: 'POST' });
    assert.equal(response.status, 501);
    assert.match((await response.json()).error, /No native folder dialog/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
