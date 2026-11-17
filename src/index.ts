/**
 * git commit graph layout library.
 *
 * Input: a topological commit history. Output: drawable rows, nodes, and edge
 * fragments. The caller resolves colors, stroke widths, and render order.
 *
 * The layout is a TypeScript port of the IntelliJ Community Edition VCS log
 * graph (`platform/vcs-log/graph`, Apache-2.0). See README.md for the mapping
 * between this library and the IntelliJ classes.
 */
import {
  buildLayout,
  defaultHeadComparator,
  groupRefsByCommit,
  PermanentGraph,
  SortedGraph,
  type LayoutData,
} from './graph';
import { filterGraph } from './filter';
import { buildPrintModel } from './print';
import { assertTopologicalOrder, identityOrder, intelliSort } from './sort';
import type {
  ColorResolver,
  CommitInput,
  GraphInput,
  GraphLayout,
  GraphOptions,
  GraphResult,
  HeadInfo,
  RefInput,
  SortContext,
} from './types';

export type * from './types';
export { javaStringHash, naturalCompare, defaultHeadComparator } from './graph';

/** Index of every commit id; the first occurrence wins. */
function indexCommits(commits: readonly CommitInput[]): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    if (!result.has(commits[i].id)) result.set(commits[i].id, i);
  }
  return result;
}

/**
 * Sorts commits topologically, newest first: a commit is placed after all of its
 * children, and commits with the same constraint are ordered by timestamp.
 *
 * The input may be in any order.
 */
export function sortTopologicallyByDate(commits: readonly CommitInput[]): CommitInput[] {
  const indexById = indexCommits(commits);
  const pendingChildren = new Int32Array(commits.length);

  for (let i = 0; i < commits.length; i++) {
    for (const parentId of commits[i].parents) {
      const parentIndex = indexById.get(parentId);
      if (parentIndex === undefined || parentIndex === i) continue;
      pendingChildren[parentIndex]++;
    }
  }

  // Max-heap by timestamp (newest first), then by input index.
  const heap: number[] = [];
  const less = (a: number, b: number): boolean =>
    commits[a].timestamp > commits[b].timestamp ||
    (commits[a].timestamp === commits[b].timestamp && a < b);

  const push = (value: number): void => {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!less(heap[index], heap[parent])) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };

  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (left < heap.length && less(heap[left], heap[best])) best = left;
        if (right < heap.length && less(heap[right], heap[best])) best = right;
        if (best === index) break;
        [heap[best], heap[index]] = [heap[index], heap[best]];
        index = best;
      }
    }
    return top;
  };

  for (let i = 0; i < commits.length; i++) {
    if (pendingChildren[i] === 0) push(i);
  }

  const result: CommitInput[] = [];
  while (heap.length > 0) {
    const index = pop();
    result.push(commits[index]);
    for (const parentId of commits[index].parents) {
      const parentIndex = indexById.get(parentId);
      if (parentIndex === undefined || parentIndex === index) continue;
      pendingChildren[parentIndex]--;
      if (pendingChildren[parentIndex] === 0) push(parentIndex);
    }
  }

  if (result.length !== commits.length) {
    throw new Error('The commit history contains a cycle: the parents are not acyclic');
  }
  return result;
}

/** Color of a color id, using the IntelliJ `DefaultColorGenerator` formula. */
export function colorFromId(colorId: number): string {
  if (colorId === 0) return '#000000';
  const rangeFix = (n: number): number => (Math.abs(n % 100) + 70) / 255;
  const [hue, ,] = rgbToHsb(rangeFix(colorId * 200 + 30), rangeFix(colorId * 130 + 50), rangeFix(colorId * 90 + 100));
  const [r, g, b] = hsbToRgb(hue, 0.4, 0.65);
  const hex = (value: number): string => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function rgbToHsb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsbToRgb(hue: number, saturation: number, brightness: number): [number, number, number] {
  const c = brightness * saturation;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = brightness - c;
  let rgb: [number, number, number];
  if (hue < 1 / 6) rgb = [c, x, 0];
  else if (hue < 2 / 6) rgb = [x, c, 0];
  else if (hue < 3 / 6) rgb = [0, c, x];
  else if (hue < 4 / 6) rgb = [0, x, c];
  else if (hue < 5 / 6) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/**
 * Builds the drawable graph of a commit history.
 *
 * The input commits must be topologically sorted; use {@link sortTopologicallyByDate}
 * when they are not.
 */
export function buildGraph(input: GraphInput, options: GraphOptions = {}): GraphResult {
  const commits = input.commits;
  const refs = input.refs ?? [];
  const refsByCommit = groupRefsByCommit(commits, refs);
  const indexById = indexCommits(commits);

  const emptyLayout: GraphLayout = {
    column: new Int32Array(0),
    heads: [],
    headOrder: new Int32Array(0),
    width: 0,
  };
  if (commits.length === 0) {
    return { rows: [], edges: [], layout: emptyLayout, rowCount: 0, width: 0, refsByCommit };
  }

  const permanent = new PermanentGraph(commits);

  // ---- heads and layout ---------------------------------------------------

  const branchHeads: number[] = [];
  const seenHeads = new Set<number>();
  for (const ref of refs) {
    if (ref.kind === 'tag') continue;
    const index = indexById.get(ref.commit);
    if (index === undefined || seenHeads.has(index)) continue;
    seenHeads.add(index);
    branchHeads.push(index);
  }

  const headInfoOf = (commitIndex: number, order: number): HeadInfo => ({
    commitIndex,
    commit: commits[commitIndex],
    column: 0,
    refs: refsByCommit.get(commitIndex) ?? [],
    order,
  });

  const headComparator = options.headComparator ?? defaultHeadComparator;

  const layout: LayoutData = buildLayout(permanent, branchHeads, (a, b) => {
    const infoA = headInfoOf(a, 0);
    const infoB = headInfoOf(b, 0);
    return headComparator(infoA, infoB) || a - b;
  });

  const heads: HeadInfo[] = layout.heads.map((commitIndex, order) => ({
    commitIndex,
    commit: commits[commitIndex],
    column: layout.column[commitIndex],
    refs: refsByCommit.get(commitIndex) ?? [],
    order,
  }));

  // ---- row order ----------------------------------------------------------

  const firstParent = options.firstParent === true;
  const sortMode = options.sort ?? 'input';

  let sortedToUsual: Int32Array;
  if (typeof sortMode === 'function') {
    const parents: number[][] = Array.from({ length: commits.length }, (_, index) => permanent.parentNodes(index));
    const context: SortContext = {
      commits,
      column: layout.column,
      heads: layout.heads,
      parents,
      timestamps: Float64Array.from(commits, (commit) => commit.timestamp),
      sortedIndex: (commitIndex) => commitIndex,
    };
    const order = sortMode(context);
    sortedToUsual = Int32Array.from(order);
    if (sortedToUsual.length !== commits.length) {
      throw new Error(`The custom sort returned ${sortedToUsual.length} rows, expected ${commits.length}`);
    }
  } else if (sortMode === 'intellisort') {
    sortedToUsual = intelliSort(permanent, layout, (node) => commits[node].timestamp);
  } else {
    sortedToUsual = identityOrder(commits.length);
  }

  assertTopologicalOrder(permanent, sortedToUsual);
  const sorted = new SortedGraph(permanent, sortedToUsual);

  // ---- filtering ----------------------------------------------------------

  const firstParentFilter = firstParent || sortMode === 'first-parent';

  let startNodes: number[] | null = null;
  if (options.visibleHeads !== undefined) {
    startNodes = [];
    for (const id of options.visibleHeads) {
      const usual = indexById.get(id);
      if (usual === undefined) continue;
      startNodes.push(sorted.sortedIndex(usual));
    }
  } else if (firstParentFilter) {
    startNodes = [];
    for (let node = 0; node < sorted.nodesCount; node++) {
      if (sorted.upNodes(node).length === 0) startNodes.push(node);
    }
    for (const usual of branchHeads) startNodes.push(sorted.sortedIndex(usual));
  }

  const predicate = (sortedNode: number): boolean => {
    const usual = sortedToUsual[sortedNode];
    const commit = commits[usual];
    return options.visibleCommits === undefined || options.visibleCommits(commit, usual);
  };

  const visible = filterGraph(sorted, { startNodes, predicate, firstParent: firstParentFilter });

  const commitOfRow = new Int32Array(visible.graph.nodesCount);
  for (let row = 0; row < commitOfRow.length; row++) {
    commitOfRow[row] = sortedToUsual[visible.nodeOfRow[row]];
  }

  // ---- print elements -----------------------------------------------------

  const print = buildPrintModel({
    commits,
    refsByCommit,
    layout,
    heads,
    commitOfRow,
    headOrderOfCommit: layout.headOf,
    visible,
    showLongEdges: options.showLongEdges ?? false,
    color: options.color,
    data: options.data,
  });

  let layoutWidth = 0;
  for (let index = 0; index < layout.column.length; index++) {
    if (layout.column[index] > layoutWidth) layoutWidth = layout.column[index];
  }

  return {
    rows: print.rows,
    edges: print.edges,
    layout: {
      column: layout.column,
      heads,
      headOrder: layout.headOf,
      width: layoutWidth,
    },
    rowCount: print.rows.length,
    width: print.width,
    refsByCommit,
  };
}
