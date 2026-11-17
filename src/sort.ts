/**
 * Row ordering: IntelliSort (the "Bek" algorithm) and helpers.
 *
 * Ported from `platform/vcs-log/graph/impl/facade/sort` of intellij-community
 * (Apache-2.0): `BekBranch`, `BekBranchCreator`, `BekBranchMerger`,
 * `BekEdgeRestrictions`, `SortIndexMap`, `SortChecker`.
 */
import { findReversedEdge, type LayoutData, type LinearGraphLike, NODE_NOT_FOUND, walk } from './graph';

const MAX_BLOCK_SIZE = 20;
/** Three days in milliseconds, the same constant as IntelliJ. */
const MAX_DELTA_TIME = 60 * 60 * 24 * 3 * 1000;
/** Four hours in milliseconds. */
const SMALL_DELTA_TIME = 60 * 60 * 4 * 1000;

/** Binary min-heap of numbers, ordered by a comparator. */
class IntHeap {
  private readonly items: number[] = [];
  private readonly compare: (a: number, b: number) => number;

  constructor(compare: (a: number, b: number) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  push(value: number): void {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[parent], items[index]) <= 0) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items.pop() as number;
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.compare(items[left], items[smallest]) < 0) smallest = left;
        if (right < items.length && this.compare(items[right], items[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

/** Up node -> down nodes, and down node -> up nodes, of the edge restrictions. */
class BekEdgeRestrictions {
  private readonly upToDown = new Map<number, Set<number>>();
  private readonly downToUp = new Map<number, Set<number>>();

  add(up: number, down: number): void {
    let downs = this.upToDown.get(up);
    if (downs === undefined) {
      downs = new Set();
      this.upToDown.set(up, downs);
    }
    downs.add(down);

    let ups = this.downToUp.get(down);
    if (ups === undefined) {
      ups = new Set();
      this.downToUp.set(down, ups);
    }
    ups.add(up);
  }

  /** Removes the restrictions that point to `down` and reports the released up nodes. */
  remove(down: number, released: (up: number) => void): void {
    const ups = this.downToUp.get(down);
    if (ups === undefined) return;
    for (const up of ups) {
      const downs = this.upToDown.get(up);
      if (downs === undefined) continue;
      downs.delete(down);
      if (downs.size === 0) {
        this.upToDown.delete(up);
        released(up);
      }
    }
    this.downToUp.delete(down);
  }

  has(up: number): boolean {
    return this.upToDown.has(up);
  }
}

/** A branch of the graph: a run of nodes in the layout order. */
class BekBranch {
  private readonly graph: LinearGraphLike;
  private readonly nodes: readonly number[];
  private noInsertSize: number;
  private prepared: readonly number[] | null = null;

  constructor(graph: LinearGraphLike, nodes: readonly number[]) {
    this.graph = graph;
    this.nodes = nodes;
    this.noInsertSize = nodes.length;
  }

  get nodeIndexes(): readonly number[] {
    return this.nodes;
  }

  get currentNode(): number {
    return this.nodes[this.noInsertSize - 1];
  }

  isDone(): boolean {
    return this.noInsertSize === 0;
  }

  /**
   * Cuts the not yet placed tail of the branch at a merge commit, at a gap, at a
   * long time gap, or at the block size limit.
   */
  updatePrepareForInsertPart(timestamp: (node: number) => number, restrictions: BekEdgeRestrictions): void {
    const currentNode = this.nodes[this.noInsertSize - 1];
    if (restrictions.has(currentNode)) return;

    let prevIndex: number;
    for (prevIndex = this.noInsertSize - 1; prevIndex > 0; prevIndex--) {
      const upNode = this.nodes[prevIndex - 1];
      const downNode = this.nodes[prevIndex];

      // for correct topological order
      if (restrictions.has(upNode)) break;

      const downNodes = this.graph.downNodes(upNode);
      const containsDownNode = downNodes.includes(downNode);

      // upNode is a merge commit
      if (downNodes.length > 1 && containsDownNode) continue;

      // division
      if (!containsDownNode) break;

      const delta = Math.abs(timestamp(upNode) - timestamp(downNode));

      // long time between commits
      if (delta > MAX_DELTA_TIME) break;

      // if block is so long
      if (prevIndex < this.noInsertSize - MAX_BLOCK_SIZE && delta > SMALL_DELTA_TIME) break;
    }

    this.prepared = this.nodes.slice(prevIndex, this.noInsertSize);
  }

  getPrepared(): readonly number[] | null {
    return this.prepared;
  }

  finishPrepared(): void {
    if (this.prepared === null) throw new Error('Internal error: no prepared part');
    this.noInsertSize -= this.prepared.length;
    this.prepared = null;
  }
}

interface BranchCreation {
  readonly branches: BekBranch[];
  readonly restrictions: BekEdgeRestrictions;
}

/** Splits the graph into branches, recording the edges that cross a branch boundary. */
function createBranches(graph: LinearGraphLike, layout: LayoutData): BranchCreation {
  const done = new Uint8Array(graph.nodesCount);
  const restrictions = new BekEdgeRestrictions();
  const branches: BekBranch[] = [];

  const createBranch = (head: number): readonly number[] => {
    done[head] = 1;
    const nodes: number[] = [head];
    const startLayout = layout.column[head];

    walk(head, (current) => {
      const currentLayout = layout.column[current];
      const downNodes = graph.downNodes(current);
      for (let i = downNodes.length - 1; i >= 0; i--) {
        const down = downNodes[i];
        if (done[down]) {
          if (layout.column[down] < startLayout) restrictions.add(current, down);
        } else if (currentLayout <= layout.column[down]) {
          let hasUndoneUpNodes = false;
          for (const up of graph.upNodes(down)) {
            if (!done[up] && layout.column[up] <= layout.column[down]) {
              hasUndoneUpNodes = true;
              break;
            }
          }
          if (!hasUndoneUpNodes) {
            done[down] = 1;
            nodes.push(down);
            return down;
          }
        }
      }
      return NODE_NOT_FOUND;
    });

    return nodes;
  };

  for (const head of layout.heads) {
    if (done[head]) continue;
    branches.push(new BekBranch(graph, createBranch(head)));
  }
  return { branches, restrictions };
}

/**
 * Merges the branches into one topological order, from the bottom to the top.
 * Each step places the prepared part with the smallest top timestamp.
 */
function mergeBranches(
  branches: readonly BekBranch[],
  restrictions: BekEdgeRestrictions,
  timestamp: (node: number) => number,
  nodesCount: number,
): Int32Array {
  const nodeToBranch = new Int32Array(nodesCount);
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
    for (const node of branches[branchIndex].nodeIndexes) nodeToBranch[node] = branchIndex;
  }

  const queuedTimestamps = new Float64Array(branches.length);
  const queue = new IntHeap((a, b) => {
    const byTimestamp = queuedTimestamps[a] - queuedTimestamps[b];
    return byTimestamp !== 0 ? byTimestamp : a - b;
  });

  const result = new Int32Array(nodesCount);
  let resultStart = nodesCount;
  const released: number[] = [];

  const prepareAndEnqueue = (branchIndex: number): void => {
    const branch = branches[branchIndex];
    if (branch.isDone() || branch.getPrepared() !== null) return;
    branch.updatePrepareForInsertPart(timestamp, restrictions);
    const part = branch.getPrepared();
    if (part === null) return;
    queuedTimestamps[branchIndex] = timestamp(part[0]);
    queue.push(branchIndex);
  };

  const step = (): void => {
    const branchIndex = queue.pop();
    const branch = branches[branchIndex];
    const part = branch.getPrepared();
    if (part === null) throw new Error('Internal error: no prepared part');

    released.length = 0;
    resultStart -= part.length;
    for (let i = 0; i < part.length; i++) {
      const inserted = part[i];
      result[resultStart + i] = inserted;
      restrictions.remove(inserted, (up) => released.push(up));
    }
    branch.finishPrepared();

    for (const node of released) {
      const branchOfNode = nodeToBranch[node];
      const releasedBranch = branches[branchOfNode];
      if (!releasedBranch.isDone() && releasedBranch.currentNode === node) {
        prepareAndEnqueue(branchOfNode);
      }
    }
    prepareAndEnqueue(branchIndex);
  };

  for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) prepareAndEnqueue(branchIndex);
  while (queue.size > 0) step();

  if (resultStart !== 0) throw new Error(`Internal error: unplaced nodes: ${resultStart}`);
  return result;
}

/**
 * IntelliSort: incoming commits of a merge commit go directly below it.
 *
 * @returns the usual node index of every sorted row, top to bottom
 */
export function intelliSort(graph: LinearGraphLike, layout: LayoutData, timestamp: (node: number) => number): Int32Array {
  const { branches, restrictions } = createBranches(graph, layout);
  const result = mergeBranches(branches, restrictions, timestamp, graph.nodesCount);

  const reversed = findReversedEdge(graph, result);
  if (reversed !== null) {
    throw new Error(`Internal error: IntelliSort produced a reversed edge ${reversed.up} -> ${reversed.down}`);
  }
  return result;
}

/** The identity order. */
export function identityOrder(nodesCount: number): Int32Array {
  const result = new Int32Array(nodesCount);
  for (let i = 0; i < nodesCount; i++) result[i] = i;
  return result;
}

/** Checks a candidate order and throws when an edge points upwards. */
export function assertTopologicalOrder(graph: LinearGraphLike, sortedToUsual: Int32Array): void {
  const reversed = findReversedEdge(graph, sortedToUsual);
  if (reversed !== null) {
    throw new Error(
      `The order is not topological: edge ${reversed.up} -> ${reversed.down} points upwards`,
    );
  }
}
