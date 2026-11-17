/**
 * Local demo server: serves the page, lists folders, reads git histories, and
 * builds the browser bundle.
 *
 * The page cannot read `.git` on its own (git objects are compressed and packed,
 * and a folder picker hides absolute paths), so this server runs the local
 * `git` command.
 *
 *   node demo/build/server.js bundle            # build demo/build/git-graph.js
 *   node demo/build/server.js serve [--open]    # serve the page on 127.0.0.1
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

import type { CommitInput, RefInput } from '@dynastxu/intellij-community-git-graph';

const UNIT = '\u001f';
const DEFAULT_PORT = 4173;

const DEMO_DIR = resolve(__dirname, '..');
const PROJECT_DIR = resolve(DEMO_DIR, '..', '..');
const DIST_DIR = join(PROJECT_DIR, 'dist');
const BUNDLE_TARGET = join(__dirname, 'git-graph.js');

/** A `git` runner. Tests replace it with a stub. */
export type RunGit = (args: string[], options?: { cwd?: string }) => Promise<string>;

export interface GitHistory {
  root: string;
  commits: CommitInput[];
  refs: RefInput[];
  truncated: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: BrowseEntry[];
  roots: string[];
}

export interface DemoApi {
  browse(path: string): Promise<BrowseResult>;
  git(path: string, options: { limit?: number }): Promise<GitHistory>;
  /** Opens the system folder dialog and returns the selected path, or null when cancelled. */
  pick(): Promise<string | null>;
}

interface HttpError extends Error {
  status?: number;
}

function httpError(message: string, status: number): HttpError {
  const error: HttpError = new Error(message);
  error.status = status;
  return error;
}

/** Runs `git` and returns its stdout, or throws with stderr attached. */
export function defaultRunGit(args: string[], { cwd }: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.env.GIT_BINARY ?? 'git',
      args,
      { cwd, windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          (error as Error & { stderr?: string }).stderr = stderr;
          reject(error);
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

function lines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

function refKind(refname: string): RefInput['kind'] {
  if (refname.startsWith('refs/heads/')) return 'local';
  if (refname.startsWith('refs/remotes/')) return 'remote';
  if (refname.startsWith('refs/tags/')) return 'tag';
  return 'other';
}

/** Parses `git for-each-ref` output: refname, short name, object, peeled object. */
export function parseRefs(output: string): RefInput[] {
  const refs: RefInput[] = [];
  for (const line of lines(output)) {
    const [refname, short, objectname, peeled] = line.split(UNIT);
    if (refname === undefined || short === undefined || objectname === undefined) continue;
    refs.push({
      name: short,
      commit: peeled !== undefined && peeled.length > 0 ? peeled : objectname,
      kind: refKind(refname),
    });
  }
  return refs;
}

const RECORD = '\u001e';

/** Parses `git log --name-only --pretty=format:%x1e%H<US>%P<US>%ct<US>%an<US>%ae<US>%s`. */
export function parseCommits(output: string): CommitInput[] {
  const records = output.includes(RECORD) ? output.split(RECORD) : [output];
  const commits: CommitInput[] = [];
  const legacy = !output.includes(RECORD);
  for (const record of records) {
    const recordLines = record.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    const header = recordLines[0];
    if (header === undefined || header.length === 0) continue;
    if (legacy) {
      for (const line of recordLines) {
        const [oldId, oldParents = '', oldSeconds, oldSubject] = line.split(UNIT);
        if (oldId === undefined || oldId.length === 0) continue;
        commits.push({
          id: oldId,
          parents: oldParents.length > 0 ? oldParents.split(' ') : [],
          subject: oldSubject !== undefined && oldSubject.length > 0 ? oldSubject : undefined,
          timestamp: Number(oldSeconds) * 1000,
        });
      }
      continue;
    }
    const [id, parents = '', seconds, author, authorEmail, subject] = header.split(UNIT);
    if (id === undefined) continue;
    const files = recordLines.slice(1).filter((line) => line.length > 0);
    commits.push({
      id,
      parents: parents.length > 0 ? parents.split(' ') : [],
      subject: subject !== undefined && subject.length > 0 ? subject : undefined,
      author: author !== undefined && author.length > 0 ? author : undefined,
      authorEmail: authorEmail !== undefined && authorEmail.length > 0 ? authorEmail : undefined,
      timestamp: Number(seconds) * 1000,
      authorTime: Number(seconds) * 1000,
      files: files.length > 0 ? files : undefined,
    });
  }
  return commits;
}

/**
 * Reads commits and refs of the repository at `directory`.
 *
 * @param directory any path inside a git worktree
 */
export async function readGitHistory(
  directory: string,
  { limit = 1000, runGit = defaultRunGit }: { limit?: number; runGit?: RunGit } = {},
): Promise<GitHistory> {
  const target = directory.trim();
  if (target.length === 0) throw new Error('Select a repository folder');

  let root: string;
  try {
    root = (await runGit(['-C', target, 'rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`Not a git repository: ${target}${detail.length > 0 ? ` (${detail})` : ''}`, { cause: error });
  }
  if (root.length === 0) throw new Error(`Not a git repository: ${target}`);

  const max = Math.max(1, Math.min(5000, Math.trunc(limit) || 1000));
  const logOutput = await runGit([
    '-C',
    root,
    'log',
    '--date-order',
    '--no-color',
    `--max-count=${max + 1}`,
    '--exclude=refs/stash',
    '--exclude=refs/notes/*',
    '--all',
    `--pretty=format:${RECORD}%H${UNIT}%P${UNIT}%ct${UNIT}%an${UNIT}%ae${UNIT}%s`,
    '--name-only',
  ]);

  const all = parseCommits(logOutput);
  const truncated = all.length > max;
  const commits = truncated ? all.slice(0, max) : all;

  const refs = parseRefs(
    await runGit([
      '-C',
      root,
      'for-each-ref',
      `--format=%(refname)${UNIT}%(refname:short)${UNIT}%(objectname)${UNIT}%(*objectname)`,
    ]),
  );

  const headSha = await runGit(['-C', root, 'rev-parse', 'HEAD'])
    .then((value) => value.trim())
    .catch(() => '');
  if (headSha.length > 0) {
    refs.unshift({ name: 'HEAD', commit: headSha, kind: 'head' });
  }

  return { root, commits, refs, truncated };
}

function drives(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const result: string[] = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const path = `${letter}:\\`;
    if (existsSync(path)) result.push(path);
  }
  return result;
}

function isRepository(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/** Lists the subdirectories of `path`. An empty path starts at the home directory. */
export async function browseDirectory(path: string): Promise<BrowseResult> {
  const requested = path.trim().length > 0 ? resolve(path.trim()) : homedir();

  let info;
  try {
    info = await stat(requested);
  } catch {
    throw httpError(`Cannot read folder: ${requested}`, 400);
  }
  if (!info.isDirectory()) {
    throw httpError(`Not a folder: ${requested}`, 400);
  }

  const dirents = await readdir(requested, { withFileTypes: true });
  const entries = dirents
    .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.'))
    .map((dirent) => {
      const entryPath = join(requested, dirent.name);
      return { name: dirent.name, path: entryPath, isRepo: isRepository(entryPath) };
    })
    .sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));

  const parent = dirname(requested);
  return {
    path: requested,
    parent: parent === requested ? null : parent,
    isRepo: isRepository(requested),
    entries,
    roots: drives(),
  };
}

/** The local API of the demo. `git` and `pick` are injectable for tests. */
export function createDemoApi({
  git = readGitHistory,
  pick = pickFolder,
}: { git?: DemoApi['git']; pick?: DemoApi['pick'] } = {}): DemoApi {
  return {
    browse: browseDirectory,
    git: (path, options) => git(path, options),
    pick: () => pick(),
  };
}

/** Runs a native dialog command. A non-zero exit code means that the user cancelled. */
function runPicker(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        const selected = stdout.trim();
        resolvePromise(selected.length > 0 ? selected : null);
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(httpError(`Native folder dialog not found: ${command}`, 501));
        return;
      }
      // A non-zero exit code or a killed process means "cancelled".
      resolvePromise(null);
    });
  });
}

function pickWindowsFolder(): Promise<string | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Select a git repository'",
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
  ].join('; ');

  const systemRoot = process.env.SystemRoot;
  const powershell =
    systemRoot !== undefined
      ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
  return runPicker(existsSync(powershell) ? powershell : 'powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
}

function pickMacFolder(): Promise<string | null> {
  return runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a git repository")']);
}

async function pickLinuxFolder(): Promise<string | null> {
  const candidates: Array<[string, string[]]> = [
    ['zenity', ['--file-selection', '--directory', '--title=Select a git repository']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', 'Select a git repository']],
  ];
  for (const [command, args] of candidates) {
    try {
      return await runPicker(command, args);
    } catch (error) {
      if ((error as HttpError).status !== 501) throw error;
    }
  }
  throw httpError('No native folder dialog found. Install zenity or kdialog, or type a path.', 501);
}

/** Opens the system folder dialog. Returns null when the user cancels. */
export function pickFolder(): Promise<string | null> {
  if (process.platform === 'win32') return pickWindowsFolder();
  if (process.platform === 'darwin') return pickMacFolder();
  return pickLinuxFolder();
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** Serves the demo page and the local API. Pass `api: null` to disable the API. */
export function createDemoServer({
  root = DEMO_DIR,
  api = createDemoApi(),
}: { root?: string; api?: DemoApi | null } = {}): Server {
  const rootDir = resolve(root);

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: string | Buffer, contentType = 'text/plain; charset=utf-8'): void => {
      response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      response.end(body);
    };

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');

      if (url.pathname.startsWith('/api/')) {
        if (api === null) {
          send(404, JSON.stringify({ error: 'The API is disabled' }), 'application/json; charset=utf-8');
          return;
        }
        if (url.pathname === '/api/pick') {
          if (request.method !== 'POST') {
            send(405, JSON.stringify({ error: 'Use POST' }), 'application/json; charset=utf-8');
            return;
          }
          try {
            const path = await api.pick();
            send(200, JSON.stringify({ path }), 'application/json; charset=utf-8');
          } catch (error) {
            const status = (error as HttpError).status ?? 400;
            const message = error instanceof Error ? error.message : String(error);
            send(status, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
          }
          return;
        }
        if (request.method !== 'GET') {
          send(405, JSON.stringify({ error: 'Use GET' }), 'application/json; charset=utf-8');
          return;
        }
        try {
          let payload: unknown;
          if (url.pathname === '/api/browse') {
            payload = await api.browse(url.searchParams.get('path') ?? '');
          } else if (url.pathname === '/api/git') {
            payload = await api.git(url.searchParams.get('path') ?? '', {
              limit: Number(url.searchParams.get('limit') ?? '1000'),
            });
          } else {
            send(
              404,
              JSON.stringify({ error: `Unknown endpoint: ${url.pathname}` }),
              'application/json; charset=utf-8',
            );
            return;
          }
          send(200, JSON.stringify(payload), 'application/json; charset=utf-8');
        } catch (error) {
          const status = (error as HttpError).status ?? 400;
          const message = error instanceof Error ? error.message : String(error);
          send(status, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
        }
        return;
      }

      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = resolve(join(rootDir, normalize(pathname)));
      if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
        send(403, 'Forbidden');
        return;
      }

      const info = await stat(filePath);
      if (info.isDirectory()) {
        response.writeHead(302, { Location: `${url.pathname}/` });
        response.end();
        return;
      }

      const data = await readFile(filePath);
      send(200, data, MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    } catch {
      send(404, 'Not found');
    }
  });
}

/** Listens on `port`, or on the next free ports. `port` 0 picks any free port. */
export function listen(server: Server, port: number, attempts = 10): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('error', onError);
      if (error.code === 'EADDRINUSE' && attempts > 1) {
        listen(server, port + 1, attempts - 1).then(resolvePromise, reject);
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      resolvePromise(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
}

/** Opens `url` in the default browser. Best effort; failures are ignored. */
export function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The caller prints the URL, so opening the browser is optional.
  }
}

/** Builds `demo/build/git-graph.js` from `dist` as a classic IIFE bundle. */
export async function buildBundle(): Promise<{ target: string; size: number; rows: number }> {
  const modules = ['index', 'types', 'graph', 'sort', 'filter', 'print', 'topo', 'merge', 'filters'];
  const bodies = await Promise.all(
    modules.map(async (name) => {
      const code = await readFile(join(DIST_DIR, `${name}.js`), 'utf8');
      return `  ${JSON.stringify(name)}: function (module, exports, require) {\n${code}\n  }`;
    }),
  );

  const bundle = `/* Generated by demo/server.ts from src. Do not edit. */
(function (global) {
  'use strict';
  var modules = {
${bodies.join(',\n')}
  };
  var cache = {};
  function require(name) {
    name = name.replace(/^\\.\\//, '').replace(/\\.js$/, '');
    if (cache[name]) return cache[name].exports;
    var module = { exports: {} };
    cache[name] = module;
    var factory = modules[name];
    if (!factory) throw new Error('Unknown module: ' + name);
    factory(module, module.exports, require);
    return module.exports;
  }
  global.GitGraph = require('index');
})(typeof window !== 'undefined' ? window : globalThis);
`;

  await writeFile(BUNDLE_TARGET, bundle);

  // Smoke test: the bundle must build a graph with a browser-like global.
  const sandbox: { GitGraph?: typeof import('@dynastxu/intellij-community-git-graph') } = {};
  new Function('window', 'globalThis', bundle)(sandbox, sandbox);
  const graph = sandbox.GitGraph?.buildGraph({
    commits: [
      { id: 'b', parents: ['a'], timestamp: 2 },
      { id: 'a', parents: [], timestamp: 1 },
    ],
  });
  if (graph === undefined || graph.rowCount !== 2) throw new Error('The demo bundle does not work');
  return { target: BUNDLE_TARGET, size: bundle.length, rows: graph.rowCount };
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] === 'bundle' ? 'bundle' : 'serve';

  if (command === 'bundle') {
    const result = await buildBundle();
    console.log(`wrote ${result.target} (${(result.size / 1024).toFixed(1)} KiB, ${result.rows} test rows)`);
    return;
  }

  const open = argv.includes('--open');
  const portIndex = argv.indexOf('--port');
  const requestedPort = portIndex >= 0 ? Number(argv[portIndex + 1]) : Number(process.env.PORT ?? DEFAULT_PORT);

  const server = createDemoServer();
  let port: number;
  try {
    port = await listen(server, Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT, 10);
  } catch (error) {
    console.error(`Cannot start the demo server: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log(`  Git graph demo: ${url}`);
  console.log(`  Serving:        ${DEMO_DIR}`);
  console.log('');
  console.log('  Use "Open a git folder..." in the page to read a repository.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  if (open) openBrowser(url);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
