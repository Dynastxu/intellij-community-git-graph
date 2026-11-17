/**
 * Page logic of the demo. This file is compiled to `demo/build/page.js` and
 * loaded as a classic script, so it must not import or export values.
 */

const graphHost = document.getElementById('list');
if (window.GitGraph === undefined) {
  if (graphHost !== null) {
    graphHost.textContent = 'The bundle demo/build/git-graph.js is missing. Run "npm run demo" in the project folder.';
  }
  throw new Error('git-graph.js is missing: run "npm run demo"');
}

const GitGraph = window.GitGraph;

const SAMPLE: { commits: CommitInput[]; refs: RefInput[] } = {
  commits: [
    { id: '4f3a2b9', parents: ['8c1e0d4', '2b7f6a1'], subject: "Merge branch 'feature/search'", timestamp: 1735689600000 },
    { id: '8c1e0d4', parents: ['c5d2e8f'], subject: 'Fix null pointer in SearchIndex', timestamp: 1735686000000 },
    { id: 'c5d2e8f', parents: ['1a9b7c3'], subject: 'Polish search results header', timestamp: 1735682400000 },
    { id: '2b7f6a1', parents: ['9e4d2c8'], subject: 'Add search suggestions', timestamp: 1735678800000 },
    { id: '9e4d2c8', parents: ['1a9b7c3'], subject: 'Extract query parser', timestamp: 1735675200000 },
    { id: '1a9b7c3', parents: ['7d3c0b5'], subject: 'Update README badges', timestamp: 1735671600000 },
    { id: '7d3c0b5', parents: ['b8e6a4d'], subject: 'Version 1.2.0', timestamp: 1735668000000 },
    { id: 'b8e6a4d', parents: ['3f5a9c2', 'e7b1d40'], subject: "Merge branch 'fix/login-timeout'", timestamp: 1735664400000 },
    { id: '3f5a9c2', parents: ['6c8e2f1'], subject: 'Add timeout retry test', timestamp: 1735660800000 },
    { id: 'e7b1d40', parents: ['6c8e2f1'], subject: 'Raise login timeout to 30s', timestamp: 1735657200000 },
    { id: '6c8e2f1', parents: ['d2a4f87'], subject: 'Tune HTTP client defaults', timestamp: 1735653600000 },
    { id: 'd2a4f87', parents: ['a6c3e1f'], subject: 'Version 1.1.0', timestamp: 1735650000000 },
    { id: 'a6c3e1f', parents: ['aa11bb2'], subject: 'Introduce config module', timestamp: 1735646400000 },
    { id: 'aa11bb2', parents: ['cc44ee5', 'dd22cc3'], subject: "Merge branch 'docs/rewrite'", timestamp: 1735642800000 },
    { id: 'cc44ee5', parents: ['0b9d7e4'], subject: 'Prepare the 1.1 release', timestamp: 1735639200000 },
    { id: 'dd22cc3', parents: ['ee33dd4'], subject: 'Rewrite installation guide', timestamp: 1735635600000 },
    { id: 'ee33dd4', parents: ['0b9d7e4'], subject: 'Fix docs link', timestamp: 1735632000000 },
    { id: '0b9d7e4', parents: [], subject: 'Initial commit', timestamp: 1735628400000 },
  ],
  refs: [
    { name: 'HEAD', commit: '4f3a2b9', kind: 'head' },
    { name: 'main', commit: '4f3a2b9', kind: 'local' },
    { name: 'feature/search', commit: '2b7f6a1', kind: 'local' },
    { name: 'origin/main', commit: '1a9b7c3', kind: 'remote' },
    { name: 'v1.2.0', commit: '7d3c0b5', kind: 'tag' },
    { name: 'v1.1.0', commit: 'd2a4f87', kind: 'tag' },
  ],
};

const PALETTE = ['#cf6b4a', '#4a8fcf', '#4a9c6b', '#9c6bcf', '#c9a227', '#cf4a86', '#4aa9b8', '#8c8f4a'];
const SVG_NS = 'http://www.w3.org/2000/svg';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element: #${id}`);
  return element as T;
}

const ui = {
  sort: byId<HTMLSelectElement>('sort'),
  heads: byId<HTMLSelectElement>('heads'),
  hide: byId<HTMLInputElement>('hide'),
  colors: byId<HTMLSelectElement>('colors'),
  rowHeight: byId<HTMLInputElement>('rowHeight'),
  showRefs: byId<HTMLInputElement>('showRefs'),
  showHashes: byId<HTMLInputElement>('showHashes'),
  showArrows: byId<HTMLInputElement>('showArrows'),
  data: byId<HTMLTextAreaElement>('data'),
  apply: byId<HTMLButtonElement>('apply'),
  reset: byId<HTMLButtonElement>('reset'),
  copy: byId<HTMLButtonElement>('copy'),
  error: byId<HTMLParagraphElement>('error'),
  stats: byId<HTMLParagraphElement>('stats'),
  list: byId<HTMLDivElement>('list'),
  scroll: byId<HTMLDivElement>('scroll'),
  rows: byId<HTMLDivElement>('rows'),
  graphCanvas: byId<HTMLCanvasElement>('graphCanvas'),
  openFolder: byId<HTMLButtonElement>('openFolder'),
  source: byId<HTMLParagraphElement>('source'),
  folderModal: byId<HTMLDivElement>('folderModal'),
  folderCancel: byId<HTMLButtonElement>('folderCancel'),
  folderUp: byId<HTMLButtonElement>('folderUp'),
  folderPath: byId<HTMLInputElement>('folderPath'),
  folderGo: byId<HTMLButtonElement>('folderGo'),
  folderRoots: byId<HTMLDivElement>('folderRoots'),
  folderList: byId<HTMLUListElement>('folderList'),
  folderError: byId<HTMLParagraphElement>('folderError'),
  gitLimit: byId<HTMLInputElement>('gitLimit'),
  folderOpen: byId<HTMLButtonElement>('folderOpen'),
  folderPick: byId<HTMLButtonElement>('folderPick'),
};

interface PageState {
  commits: CommitInput[];
  refs: RefInput[];
}

interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: BrowseEntry[];
  roots: string[];
}

interface GitHistoryResult {
  root: string;
  commits: CommitInput[];
  refs: RefInput[];
  truncated: boolean;
}

let state: PageState = {
  commits: GitGraph.sortTopologicallyByDate(SAMPLE.commits),
  refs: SAMPLE.refs,
};
let model: GraphResult | null = null;

const apiAvailable = location.protocol !== 'file:';
const folder: { current: BrowseResult | null } = { current: null };

function colorForId(colorId: number): string {
  return GitGraph.colorFromId(colorId);
}

function colorResolver(): ColorResolver | undefined {
  if (ui.colors.value === 'mono') return () => '#8a8f98';
  if (ui.colors.value === 'branch') {
    return ({ column }: ColorContext) => PALETTE[(Math.max(1, column) - 1 + PALETTE.length) % PALETTE.length] as string;
  }
  return undefined;
}

function elementColor(element: GraphNodeElement | GraphEdgeElement): string {
  return element.color ?? colorForId(element.colorId);
}

function setSource(text: string): void {
  ui.source.textContent = text;
}

function buildModel(): number {
  const options: {
    showLongEdges: boolean;
    data: (commit: CommitInput) => string;
    sort?: SortMode;
    firstParent?: boolean;
    visibleCommits?: (commit: CommitInput) => boolean;
    visibleHeads?: string[];
    color?: ColorResolver;
  } = {
    showLongEdges: ui.showArrows.checked,
    data: (commit) => commit.id,
  };
  const sort = ui.sort.value;
  if (sort === 'first-parent') {
    options.firstParent = true;
  } else {
    options.sort = sort as SortMode;
  }
  const hide = ui.hide.value.trim();
  if (hide.length > 0) options.visibleCommits = (commit: CommitInput) => !commit.id.includes(hide);
  if (ui.heads.value !== 'all') options.visibleHeads = [ui.heads.value];
  const color = colorResolver();
  if (color !== undefined) options.color = color;

  const started = performance.now();
  model = GitGraph.buildGraph({ commits: state.commits, refs: state.refs }, options);
  return performance.now() - started;
}

interface GraphMetrics {
  rowCenter: number;
  lane: number;
  elementCenter: number;
  lineThickness: number;
  circleRadius: number;
}

// Adapted from GitNut packages/commons/src/graph/paint.ts (Apache-2.0), which ports
// IntelliJ's SimpleGraphCellPainter: row cell metrics, straight half-edges, arrow heads.
function graphMetrics(rowHeight: number): GraphMetrics {
  const lane = (16 * rowHeight) / 22;
  return {
    rowCenter: Math.round(rowHeight / 2),
    lane,
    elementCenter: lane / 2,
    lineThickness: Math.max(1, (1.5 * rowHeight) / 22),
    circleRadius: (4 * rowHeight) / 22,
  };
}

/** Rightmost element slot of a row, like LaidOutGraph.maxPosition. */
function maxPosition(row: GraphRow): number {
  let max = 0;
  for (const element of row.elements) {
    max = Math.max(max, element.position, element.kind === 'edge' ? element.otherPosition : 0);
  }
  return max;
}

function paintArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  ax: number,
  ay: number,
  rowHeight: number,
): void {
  const angle = Math.atan2(y1 - ay, x1 - ax);
  const length = 0.3 * rowHeight;
  ctx.beginPath();
  for (const sign of [1, -1]) {
    const a = angle + sign * 0.795;
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + Math.cos(a) * length, ay + Math.sin(a) * length);
  }
  ctx.stroke();
}

/** SimpleGraphCellPainter.paintEdge: straight half-edges inside the row cell. */
function paintEdge(
  ctx: CanvasRenderingContext2D,
  element: GraphEdgeElement,
  m: GraphMetrics,
  rowHeight: number,
): void {
  const down = element.direction === 'down';
  const x1 = m.lane * element.position + m.elementCenter;
  const y1 = m.rowCenter;
  ctx.strokeStyle = elementColor(element);
  ctx.lineWidth = m.lineThickness;
  ctx.setLineDash(element.style === 'dashed' ? [4, 3] : []);

  let x2: number;
  let y2: number;
  let arrowX: number;
  let arrowY: number;
  if (element.position === element.otherPosition) {
    const gap = element.arrow ? m.circleRadius / 2 + 1 : 0;
    x2 = x1;
    y2 = down ? rowHeight - gap : gap;
    arrowX = x2;
    arrowY = y2;
  } else {
    // Diagonal edges are drawn to the neighbour row centre; the row clip keeps one half.
    x2 = m.lane * element.otherPosition + m.elementCenter;
    y2 = down ? rowHeight + m.rowCenter : m.rowCenter - rowHeight;
    arrowX = (x1 + x2) / 2;
    arrowY = (y1 + y2) / 2;
  }

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  if (element.arrow) {
    ctx.setLineDash([]);
    paintArrow(ctx, x1, y1, arrowX, arrowY, rowHeight);
  }
}

/** SimpleGraphCellPainter.paintCircle and HeadNodePainter. */
function paintNode(ctx: CanvasRenderingContext2D, element: GraphNodeElement, m: GraphMetrics): void {
  const x = m.lane * element.position + m.elementCenter;
  const y = m.rowCenter;
  const color = elementColor(element);
  const circle = (radius: number): void => {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  };

  ctx.fillStyle = color;
  if (!element.isHead) {
    circle(m.circleRadius);
    return;
  }
  circle(m.circleRadius + 2);
  ctx.fillStyle = '#ffffff';
  circle(m.circleRadius);
  ctx.fillStyle = color;
  circle(Math.max(1.5, m.circleRadius - 2));
}

function paintRow(ctx: CanvasRenderingContext2D, row: GraphRow, m: GraphMetrics, rowHeight: number): void {
  for (const element of row.elements) {
    if (element.kind === 'node') paintNode(ctx, element, m);
    else paintEdge(ctx, element, m, rowHeight);
  }
}

let graphWidth = 0;

function visibleRange(rowHeight: number): { first: number; last: number } {
  if (model === null) return { first: 0, last: 0 };
  const viewport = ui.scroll.clientHeight || 600;
  const first = Math.max(0, Math.floor(ui.scroll.scrollTop / rowHeight));
  const last = Math.min(model.rowCount, Math.ceil((ui.scroll.scrollTop + viewport) / rowHeight) + 1);
  return { first, last };
}

/** Graph column width from the visible rows, like gitnut: lanes * lane + 6, capped. */
function computeGraphWidth(rowHeight: number): number {
  if (model === null) return 0;
  const { first, last } = visibleRange(rowHeight);
  const lane = graphMetrics(rowHeight).lane;
  let lanes = 1;
  for (let row = first; row < last; row++) {
    lanes = Math.max(lanes, maxPosition(model.rows[row]) + 1);
  }
  return Math.min(lanes * lane + 6, 600);
}

function paintCanvas(): void {
  if (model === null) return;
  const canvas = ui.graphCanvas;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return; // jsdom has no 2D context

  const rowHeight = Number(ui.rowHeight.value);
  const viewport = Math.max(1, ui.scroll.clientHeight || 600);
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, graphWidth);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${viewport}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(viewport * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, viewport);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const m = graphMetrics(rowHeight);
  const { first, last } = visibleRange(rowHeight);
  for (let row = first; row < last; row++) {
    const data = model.rows[row];
    if (data === undefined) continue;
    ctx.save();
    ctx.translate(0, row * rowHeight - ui.scroll.scrollTop);
    ctx.beginPath();
    ctx.rect(0, 0, cssWidth, rowHeight);
    ctx.clip();
    paintRow(ctx, data, m, rowHeight);
    ctx.restore();
  }
}

function renderRows(): void {
  if (model === null) return;
  const rowHeight = Number(ui.rowHeight.value);
  const lane = graphMetrics(rowHeight).lane;
  const showRefs = ui.showRefs.checked;
  const showHashes = ui.showHashes.checked;

  const fragment = document.createDocumentFragment();
  for (const row of model.rows) {
    const div = document.createElement('div');
    div.className = 'log-row';
    div.style.top = `${row.row * rowHeight}px`;
    div.style.height = `${rowHeight}px`;

    const subject = document.createElement('div');
    subject.className = 'log-subject';
    // gitnut: the message follows the graph of its own row.
    subject.style.paddingLeft = `${(maxPosition(row) + 1) * lane + 8}px`;
    if (showRefs) {
      for (const ref of row.node.refs) {
        const pill = document.createElement('span');
        pill.className = 'ref';
        pill.style.color = elementColor(row.node);
        pill.textContent = ref.name;
        subject.appendChild(pill);
      }
    }
    const text = document.createElement('span');
    text.className = 'subject';
    text.textContent = row.commit.subject ?? '';
    subject.appendChild(text);
    div.appendChild(subject);

    if (showHashes) {
      const hash = document.createElement('span');
      hash.className = 'log-hash';
      hash.textContent = row.commit.id;
      div.appendChild(hash);
    }
    fragment.appendChild(div);
  }

  ui.rows.style.height = `${model.rowCount * rowHeight}px`;
  ui.rows.replaceChildren(fragment);
}

function renderLog(ms: number): void {
  if (model === null) return;
  const rowHeight = Number(ui.rowHeight.value);
  graphWidth = computeGraphWidth(rowHeight);
  renderRows();
  paintCanvas();

  const columnsCount = model.layout.width;
  ui.stats.innerHTML =
    `<b>${model.rowCount}</b> rows · <b>${model.edges.length}</b> edges · ` +
    `<b>${columnsCount}</b> columns · <b>${state.commits.length}</b> commits · ` +
    `build <b>${ms.toFixed(1)}</b> ms`;
}

function render(): void {
  try {
    const ms = buildModel();
    renderLog(ms);
    ui.error.hidden = true;
  } catch (error) {
    ui.error.textContent = String(error instanceof Error ? error.message : error);
    ui.error.hidden = false;
  }
}

// ---- folder picker ---------------------------------------------------------

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (!apiAvailable) {
    throw new Error('Folder browsing needs the local demo server. Run "npm run demo" and open the printed URL.');
  }
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

function setFolderError(message: string): void {
  ui.folderError.textContent = message;
  ui.folderError.hidden = message.length === 0;
}

function closeFolderDialog(): void {
  ui.folderModal.hidden = true;
}

function openFolderDialog(): void {
  ui.folderModal.hidden = false;
  setFolderError('');
  if (!apiAvailable) {
    setFolderError('Folder browsing needs the local demo server. Run "npm run demo" and open the printed URL.');
    ui.folderList.replaceChildren();
    ui.folderPath.value = '';
    return;
  }
  void browseFolder(folder.current === null ? '' : folder.current.path);
}

async function browseFolder(path: string): Promise<void> {
  setFolderError('');
  ui.folderOpen.disabled = true;
  try {
    const data = await apiJson<BrowseResult>(`/api/browse?path=${encodeURIComponent(path)}`);
    folder.current = data;
    ui.folderPath.value = data.path;
    ui.folderUp.disabled = data.parent === null;

    ui.folderRoots.replaceChildren(...data.roots.map((root) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = root;
      button.addEventListener('click', () => { void browseFolder(root); });
      return button;
    }));

    const rows = data.entries.map((entry) => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
      row.append(name);

      if (entry.isRepo) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'repo';
        badge.textContent = 'git';
        badge.title = 'Open this repository';
        badge.addEventListener('click', (event) => {
          event.stopPropagation();
          void openRepository(entry.path);
        });
        row.append(badge);
      }

      const enter = document.createElement('span');
      enter.className = 'enter';
      enter.textContent = '›';
      row.append(enter);
      row.addEventListener('click', () => { void browseFolder(entry.path); });
      return row;
    });

    if (rows.length === 0) {
      const row = document.createElement('li');
      row.textContent = 'No subfolders';
      row.style.cursor = 'default';
      ui.folderList.replaceChildren(row);
    } else {
      ui.folderList.replaceChildren(...rows);
    }

    ui.folderOpen.disabled = false;
    ui.folderOpen.textContent = data.isRepo ? 'Open this repository' : 'Open current folder';
  } catch (error) {
    setFolderError(error instanceof Error ? error.message : String(error));
  }
}

async function openRepository(path: string): Promise<void> {
  setFolderError('');
  ui.folderOpen.disabled = true;
  try {
    const limit = Number(ui.gitLimit.value) || 1000;
    const data = await apiJson<GitHistoryResult>(`/api/git?path=${encodeURIComponent(path)}&limit=${limit}`);
    state = { commits: data.commits, refs: data.refs };
    fillHeads();
    fillData();
    render();
    setSource(`Source: ${data.root}${data.truncated ? ` (first ${data.commits.length} commits)` : ''}`);
    closeFolderDialog();
  } catch (error) {
    setFolderError(error instanceof Error ? error.message : String(error));
  } finally {
    ui.folderOpen.disabled = false;
  }
}

async function pickSystemFolder(): Promise<void> {
  setFolderError('');
  const label = ui.folderPick.textContent;
  ui.folderPick.disabled = true;
  ui.folderPick.textContent = 'Waiting for the system dialog…';
  try {
    const result = await apiJson<{ path: string | null }>('/api/pick', { method: 'POST' });
    if (result.path !== null) await browseFolder(result.path);
  } catch (error) {
    setFolderError(error instanceof Error ? error.message : String(error));
  } finally {
    ui.folderPick.disabled = false;
    ui.folderPick.textContent = label;
  }
}

// ---- controls --------------------------------------------------------------

function fillHeads(): void {
  const previous = ui.heads.value;
  const options = ['<option value="all">All refs</option>'];
  const seen = new Set<string>();
  for (const ref of state.refs) {
    if (seen.has(ref.commit)) continue;
    seen.add(ref.commit);
    const label = state.refs.filter((item) => item.commit === ref.commit).map((item) => item.name).join(', ');
    options.push(`<option value="${ref.commit}">${label}</option>`);
  }
  ui.heads.innerHTML = options.join('');
  ui.heads.value = seen.has(previous) ? previous : 'all';
}

function fillData(): void {
  ui.data.value = JSON.stringify({ commits: state.commits, refs: state.refs }, null, 2);
}

for (const control of [
  ui.sort, ui.heads, ui.hide, ui.colors, ui.rowHeight,
  ui.showRefs, ui.showHashes, ui.showArrows,
]) {
  control.addEventListener('input', render);
  control.addEventListener('change', render);
}
for (const control of [ui.rowHeight]) {
  const output = document.querySelector(`output[for="${control.id}"]`);
  control.addEventListener('input', () => {
    if (output !== null) output.textContent = control.value;
  });
}

ui.apply.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(ui.data.value) as { commits?: unknown; refs?: unknown };
    if (!Array.isArray(parsed.commits)) throw new Error('Expected an object with a commits array');
    state = {
      commits: GitGraph.sortTopologicallyByDate(parsed.commits as CommitInput[]),
      refs: Array.isArray(parsed.refs) ? (parsed.refs as RefInput[]) : [],
    };
    fillHeads();
    fillData();
    render();
    setSource('Source: pasted JSON');
  } catch (error) {
    ui.error.textContent = String(error instanceof Error ? error.message : error);
    ui.error.hidden = false;
  }
});

ui.reset.addEventListener('click', () => {
  state = { commits: GitGraph.sortTopologicallyByDate(SAMPLE.commits), refs: SAMPLE.refs };
  fillHeads();
  fillData();
  render();
  setSource('Source: built-in sample');
});

ui.copy.addEventListener('click', async () => {
  if (model === null) return;
  const text = JSON.stringify(model, (_key: string, value: unknown): unknown => {
    if (value instanceof Int32Array) return Array.from(value);
    if (value instanceof Map) return Array.from(value.entries());
    return value;
  }, 2);
  try {
    await navigator.clipboard.writeText(text);
    ui.copy.textContent = 'Copied';
  } catch {
    ui.copy.textContent = 'Copy failed';
  }
  setTimeout(() => { ui.copy.textContent = 'Copy drawable JSON'; }, 1200);
});

ui.openFolder.addEventListener('click', openFolderDialog);
ui.folderCancel.addEventListener('click', closeFolderDialog);
ui.folderModal.addEventListener('click', (event) => {
  if (event.target === ui.folderModal) closeFolderDialog();
});
ui.folderUp.addEventListener('click', () => {
  if (folder.current !== null && folder.current.parent !== null) void browseFolder(folder.current.parent);
});
ui.folderGo.addEventListener('click', () => { void browseFolder(ui.folderPath.value); });
ui.folderPath.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void browseFolder(ui.folderPath.value);
  }
});
ui.folderOpen.addEventListener('click', () => {
  void openRepository(folder.current === null ? ui.folderPath.value : folder.current.path);
});
ui.folderPick.addEventListener('click', () => { void pickSystemFolder(); });
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !ui.folderModal.hidden) closeFolderDialog();
});

ui.scroll.addEventListener('scroll', () => {
  if (model === null) return;
  const width = computeGraphWidth(Number(ui.rowHeight.value));
  if (Math.abs(width - graphWidth) > 0.5) {
    graphWidth = width;
  }
  paintCanvas();
});

window.addEventListener('resize', () => {
  if (model === null) return;
  graphWidth = computeGraphWidth(Number(ui.rowHeight.value));
  paintCanvas();
});

fillHeads();
fillData();
render();
