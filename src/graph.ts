/**
 * Internal graph model: the permanent commit DAG in the form of the IntelliJ
 * "linear graph" (rows are commits, edges point from children to parents),
 * plus the column layout (DFS over sorted heads).
 *
 * Ported from `platform/vcs-log/graph` of intellij-community (Apache-2.0):
 * `PermanentLinearGraphBuilder`, `PermanentLinearGraphImpl`, `GraphLayoutBuilder`,
 * `GraphLayoutImpl`, `SortedLinearGraph`, `DfsUtil`.
 */
import type { CommitInput, HeadInfo, RefInput } from './types';

/** Marker: the DFS walker found no next node and pops the stack. */
export const NODE_NOT_FOUND = -1;
/** Marker: the DFS walker must stop. */
export const EXIT = -10;

/** Type of an edge of the internal graph. */
export type InternalEdgeType = 'usual' | 'dotted' | 'not-loaded' | 'dotted-arrow';

/** An edge of the internal graph. Missing endpoints are `null`. */
export interface InternalEdge {
  readonly type: InternalEdgeType;
  /** Upper node index (`null` for an incoming dotted arrow). */
  readonly up: number | null;
  /** Lower node index (`null` for an outgoing arrow / a not loaded commit). */
  readonly down: number | null;
  /** Negative identifier of a not loaded commit. */
  readonly targetId?: number;
}

/** A graph over row indexes. */
export interface LinearGraphLike {
  readonly nodesCount: number;
  /** All edges of a node: incoming, outgoing, and special edges. */
  adjacent(node: number): InternalEdge[];
  /** Normal edges that point up (children). */
  upNodes(node: number): number[];
  /** Normal edges that point down (parents). */
  downNodes(node: number): number[];
}

/** Iterative DFS, same semantics as `DfsUtil.walk`. */
export function walk(start: number, next: (node: number) => number): void {
  const stack: number[] = [start];
  while (stack.length > 0) {
    const nextNode = next(stack[stack.length - 1]);
    if (nextNode === EXIT) return;
    if (nextNode === NODE_NOT_FOUND) {
      stack.pop();
    } else {
      stack.push(nextNode);
    }
  }
}

/** `java.lang.String.hashCode`, used by IntelliJ for ref colors. */
export function javaStringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Natural compare: case-insensitive, numeric runs compare by value. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

const REF_KIND_ORDER: Record<string, number> = {
  remote: 0,
  local: 1,
  tag: 2,
  head: 3,
  other: 4,
};

function isMainRef(name: string): boolean {
  return name === 'main' || name === 'master' || name === 'origin/main' || name === 'origin/master';
}

/**
 * Default head order, close to IntelliJ `GitRefManager`:
 * origin/main, other remote branches, main/master, local branches, tags, HEAD, others.
 */
export function defaultHeadComparator(a: HeadInfo, b: HeadInfo): number {
  const aRef = a.refs[0];
  const bRef = b.refs[0];
  const aKind = aRef?.kind ?? 'other';
  const bKind = bRef?.kind ?? 'other';
  if (aKind !== bKind) return (REF_KIND_ORDER[aKind] ?? 9) - (REF_KIND_ORDER[bKind] ?? 9);
  const aMain = aRef ? isMainRef(aRef.name) : false;
  const bMain = bRef ? isMainRef(bRef.name) : false;
  if (aMain !== bMain) return aMain ? -1 : 1;
  if (aRef && bRef && aRef.name !== bRef.name) return naturalCompare(aRef.name, bRef.name);
  return a.commitIndex - b.commitIndex;
}

interface PermanentData {
  readonly nodesCount: number;
  /** 1 when the node is the direct child of the next row. */
  readonly simple: Uint8Array;
  /** `nodeToEdgeIndex[i] .. nodeToEdgeIndex[i + 1]` is the edge block of node `i`. */
  readonly nodeToEdgeIndex: Int32Array;
  /** Edge targets; negative values are not loaded commits. */
  readonly longEdges: Int32Array;
}

/**
 * Builds the compressed linear graph of IntelliJ: a commit whose only parent is
 * the next row is stored as a "simple node" without an explicit edge, and all
 * other edges are stored in a flat array.
 *
 * The input must be topologically sorted: every parent index is greater than the
 * child index. Parents that are absent from the input get a negative id.
 */
export function buildPermanentData(commits: readonly CommitInput[]): PermanentData {
  const nodesCount = commits.length;
  const indexById = new Map<string, number>();
  for (let i = 0; i < nodesCount; i++) {
    if (!indexById.has(commits[i].id)) indexById.set(commits[i].id, i);
  }

  // A resolved parent is the row of a loaded commit, or the id of a not loaded commit.
  const parents: (number | string)[][] = new Array(nodesCount);
  for (let i = 0; i < nodesCount; i++) {
    const resolved: (number | string)[] = [];
    const seen = new Set<string>();
    for (const parentId of commits[i].parents) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parentIndex = indexById.get(parentId);
      if (parentIndex === undefined) {
        resolved.push(parentId);
      } else {
        if (parentIndex <= i) {
          throw new Error(
            `Commits are not topologically sorted: parent '${parentId}' of '${commits[i].id}' is not below it`,
          );
        }
        resolved.push(parentIndex);
      }
    }
    parents[i] = resolved;
  }

  // Ids for parents that are not present in the input, assigned in processing order
  // like PermanentGraphImpl.NotLoadedCommitsIdsGenerator: -2, -3, ...

  const simple = new Uint8Array(nodesCount);
  let longEdgesCount = 0;
  for (let i = 0; i < nodesCount; i++) {
    const rowParents = parents[i];
    if (rowParents.length === 1 && rowParents[0] === i + 1) {
      simple[i] = 1;
    } else {
      longEdgesCount += rowParents.length;
    }
  }

  const nodeToEdgeIndex = new Int32Array(nodesCount + 1);
  const longEdges = new Int32Array(2 * longEdgesCount);
  // parent row (or not loaded parent id) -> rows of the children whose edge is not written yet
  const underdone = new Map<number | string, number[]>();

  // Parents of a commit after duplicate removal, aligned with the edge slots of the commit.
  const parentIds: string[][] = new Array(nodesCount);
  for (let i = 0; i < nodesCount; i++) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const parentId of commits[i].parents) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      ids.push(parentId);
    }
    parentIds[i] = ids;
  }

  const fixUnderdoneEdge = (up: number, down: number, downId: string) => {
    const ids = parentIds[up];
    const blockEnd = nodeToEdgeIndex[up + 1];
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== downId) continue;
      const offset = ids.length - i;
      const edgeIndex = blockEnd - offset;
      if (longEdges[edgeIndex] !== -1) {
        throw new Error(`Internal error: edge was set early (${up} -> ${down})`);
      }
      longEdges[edgeIndex] = down;
      return;
    }
    throw new Error(`Internal error: edge not found for ${up} -> ${down}`);
  };

  let edgeCursor = 0;
  for (let node = 0; node < nodesCount; node++) {
    const upNodes = underdone.get(node);
    if (upNodes !== undefined) {
      underdone.delete(node);
      for (const up of upNodes) {
        // The child block was already written; fix its placeholder and append the
        // mirrored down -> up entry to this node block.
        fixUnderdoneEdge(up, node, commits[node].id);
        longEdges[edgeCursor++] = up;
      }
    }

    if (!simple[node]) {
      for (const parent of parents[node]) {
        let pending = underdone.get(parent);
        if (pending === undefined) {
          pending = [];
          underdone.set(parent, pending);
        }
        pending.push(node);
        longEdges[edgeCursor++] = -1;
      }
    }
    nodeToEdgeIndex[node + 1] = edgeCursor;
  }

  // Resolve placeholders of missing parents, nearest consumer first.
  const missing = [...underdone.entries()].sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]));
  let notLoadedId = -2;
  for (const [, children] of missing) {
    const id = notLoadedId--;
    for (const up of children) {
      let fixed = false;
      for (let edgeIndex = nodeToEdgeIndex[up]; edgeIndex < nodeToEdgeIndex[up + 1]; edgeIndex++) {
        if (longEdges[edgeIndex] === -1) {
          longEdges[edgeIndex] = id;
          fixed = true;
          break;
        }
      }
      if (!fixed) throw new Error('Internal error: missing edge to a not loaded commit');
    }
  }

  return { nodesCount, simple, nodeToEdgeIndex, longEdges };
}

/** The permanent linear graph. */
export class PermanentGraph implements LinearGraphLike {
  readonly nodesCount: number;
  private readonly data: PermanentData;

  constructor(commits: readonly CommitInput[]) {
    this.data = buildPermanentData(commits);
    this.nodesCount = this.data.nodesCount;
  }

  adjacent(node: number): InternalEdge[] {
    const { simple, nodeToEdgeIndex, longEdges } = this.data;
    const result: InternalEdge[] = [];
    if (node !== 0 && simple[node - 1]) {
      result.push({ type: 'usual', up: node - 1, down: node });
    }
    for (let i = nodeToEdgeIndex[node]; i < nodeToEdgeIndex[node + 1]; i++) {
      const adjacent = longEdges[i];
      if (adjacent < 0) {
        result.push({ type: 'not-loaded', up: node, down: null, targetId: adjacent });
        continue;
      }
      if (node > adjacent) result.push({ type: 'usual', up: adjacent, down: node });
      else result.push({ type: 'usual', up: node, down: adjacent });
    }
    if (simple[node]) result.push({ type: 'usual', up: node, down: node + 1 });
    return result;
  }

  upNodes(node: number): number[] {
    const { simple, nodeToEdgeIndex, longEdges } = this.data;
    const result: number[] = [];
    if (node !== 0 && simple[node - 1]) result.push(node - 1);
    for (let i = nodeToEdgeIndex[node]; i < nodeToEdgeIndex[node + 1]; i++) {
      const adjacent = longEdges[i];
      if (adjacent >= 0 && node > adjacent) result.push(adjacent);
    }
    return result;
  }

  downNodes(node: number): number[] {
    const { simple, nodeToEdgeIndex, longEdges } = this.data;
    const result: number[] = [];
    for (let i = nodeToEdgeIndex[node]; i < nodeToEdgeIndex[node + 1]; i++) {
      const adjacent = longEdges[i];
      if (adjacent >= 0 && node < adjacent) result.push(adjacent);
    }
    if (simple[node]) result.push(node + 1);
    return result;
  }

  /** Down nodes including not loaded commits (negative values). */
  parentNodes(node: number): number[] {
    const { simple, nodeToEdgeIndex, longEdges } = this.data;
    const result: number[] = [];
    for (let i = nodeToEdgeIndex[node]; i < nodeToEdgeIndex[node + 1]; i++) {
      const adjacent = longEdges[i];
      if (adjacent < 0 || node < adjacent) result.push(adjacent);
    }
    if (simple[node]) result.push(node + 1);
    return result;
  }

  /** `true` when the node is the direct child of the next row. */
  isSimple(node: number): boolean {
    return this.data.simple[node] === 1;
  }
}

/** Column layout of a permanent graph. */
export interface LayoutData {
  /** Column per node. */
  readonly column: Int32Array;
  /** Head nodes, left to right. */
  readonly heads: readonly number[];
  /** Owning head order per node. */
  readonly headOf: Int32Array;
}

function headsWithoutChildren(graph: LinearGraphLike): number[] {
  const heads: number[] = [];
  for (let i = 0; i < graph.nodesCount; i++) {
    if (graph.upNodes(i).length === 0) heads.push(i);
  }
  return heads;
}

/**
 * Assigns a column to every node: heads are laid out left to right, and a DFS
 * from each head keeps the descendants in the same column when possible.
 *
 * @param branchHeads nodes that are heads even when they have children
 * @param comparator orders the heads; negative means `a` is more important (more to the left)
 */
export function buildLayout(
  graph: LinearGraphLike,
  branchHeads: readonly number[],
  comparator: (a: number, b: number) => number,
): LayoutData {
  const allHeads = new Set<number>(branchHeads);
  for (const head of headsWithoutChildren(graph)) allHeads.add(head);

  const sortedHeads = [...allHeads].sort(comparator);
  const column = new Int32Array(graph.nodesCount);
  const importantHeads: number[] = [];

  let currentColumn = 1;
  for (const head of sortedHeads) {
    if (column[head] !== 0) continue;
    importantHeads.push(head);

    walk(head, (node) => {
      const firstVisit = column[node] === 0;
      if (firstVisit) column[node] = currentColumn;

      const child = graph.downNodes(node).find((down) => column[down] === 0);
      if (child === undefined) {
        if (firstVisit) currentColumn++;
        return NODE_NOT_FOUND;
      }
      return child;
    });
  }

  const headOf = new Int32Array(graph.nodesCount);
  const headColumns = importantHeads.map((head) => column[head]);
  for (let node = 0; node < graph.nodesCount; node++) {
    // index of the rightmost head whose column is <= the column of the node
    let low = 0;
    let high = headColumns.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (headColumns[mid] <= column[node]) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    headOf[node] = found;
  }

  return { column, heads: importantHeads, headOf };
}

/** A linear graph whose rows are reordered by a `sortedToUsual` permutation. */
export class SortedGraph implements LinearGraphLike {
  readonly nodesCount: number;
  private readonly base: LinearGraphLike;
  private readonly sortedToUsual: Int32Array;
  private readonly usualToSorted: Int32Array;

  constructor(base: LinearGraphLike, sortedToUsual: Int32Array) {
    this.base = base;
    this.sortedToUsual = sortedToUsual;
    this.nodesCount = sortedToUsual.length;
    this.usualToSorted = new Int32Array(base.nodesCount);
    for (let sorted = 0; sorted < sortedToUsual.length; sorted++) {
      this.usualToSorted[sortedToUsual[sorted]] = sorted;
    }
  }

  usualIndex(sorted: number): number {
    return this.sortedToUsual[sorted];
  }

  sortedIndex(usual: number): number {
    return this.usualToSorted[usual];
  }

  private translate(value: number | null): number | null {
    if (value === null) return null;
    return value < 0 ? value : this.usualToSorted[value];
  }

  adjacent(node: number): InternalEdge[] {
    return this.base.adjacent(this.sortedToUsual[node]).map((edge) => ({
      type: edge.type,
      up: this.translate(edge.up),
      down: this.translate(edge.down),
      targetId: edge.targetId,
    }));
  }

  upNodes(node: number): number[] {
    return this.base.upNodes(this.sortedToUsual[node]).map((value) => this.usualToSorted[value]);
  }

  downNodes(node: number): number[] {
    return this.base.downNodes(this.sortedToUsual[node]).map((value) => this.usualToSorted[value]);
  }
}

/** Computes the refs that point to every commit. */
export function groupRefsByCommit(commits: readonly CommitInput[], refs: readonly RefInput[]): Map<number, RefInput[]> {
  const indexById = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    if (!indexById.has(commits[i].id)) indexById.set(commits[i].id, i);
  }
  const result = new Map<number, RefInput[]>();
  for (const ref of refs) {
    const index = indexById.get(ref.commit);
    if (index === undefined) continue;
    let list = result.get(index);
    if (list === undefined) {
      list = [];
      result.set(index, list);
    }
    list.push(ref);
  }
  return result;
}

/**
 * Checks that an order keeps every edge pointing downwards.
 * Returns the first reversed edge, or `null`.
 */
export function findReversedEdge(
  graph: LinearGraphLike,
  sortedToUsual: Int32Array,
): { up: number; down: number } | null {
  const usualToSorted = new Int32Array(graph.nodesCount);
  for (let sorted = 0; sorted < sortedToUsual.length; sorted++) {
    usualToSorted[sortedToUsual[sorted]] = sorted;
  }
  for (let usual = 0; usual < graph.nodesCount; usual++) {
    const sortedUp = usualToSorted[usual];
    for (const down of graph.downNodes(usual)) {
      const sortedDown = usualToSorted[down];
      if (sortedDown <= sortedUp) return { up: sortedUp, down: sortedDown };
    }
  }
  return null;
}
