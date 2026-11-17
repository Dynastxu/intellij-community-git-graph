/**
 * Filtering and edge contraction.
 *
 * Ported from `platform/vcs-log/graph/impl/facade` of intellij-community
 * (Apache-2.0): `FilteredController`, `FirstParentController`,
 * `getReachableMatchingNodes`, and the collapse semantics of
 * `DottedFilterEdgesGenerator` (hidden commits become dashed fragments).
 *
 * The port is a pure function: it computes the visible rows and contracts the
 * hidden nodes, instead of mutating a graph controller.
 */
import type { InternalEdge, LinearGraphLike } from './graph';

function edgeKey(from: number, to: number): string {
  return `${from}:${to}`;
}

/** A graph over visible rows, with hidden commits contracted into dashed edges. */
export class VisibleLinearGraph implements LinearGraphLike {
  readonly nodesCount: number;
  private readonly down: readonly (readonly number[])[];
  private readonly up: readonly (readonly number[])[];
  private readonly special: readonly (readonly InternalEdge[])[];
  private readonly dashed: ReadonlySet<string>;

  constructor(
    down: readonly (readonly number[])[],
    special: readonly (readonly InternalEdge[])[],
    dashed: ReadonlySet<string>,
  ) {
    this.nodesCount = down.length;
    this.down = down;
    this.special = special;
    this.dashed = dashed;

    const up: number[][] = Array.from({ length: down.length }, () => []);
    for (let row = 0; row < down.length; row++) {
      for (const target of down[row]) {
        if (target >= 0) up[target].push(row);
      }
    }
    this.up = up;
  }

  adjacent(node: number): InternalEdge[] {
    const result: InternalEdge[] = [];
    for (const up of this.up[node]) result.push({ type: 'usual', up, down: node });
    for (const down of this.down[node]) {
      if (down >= 0) result.push({ type: 'usual', up: node, down });
    }
    for (const edge of this.special[node]) result.push(edge);
    return result;
  }

  upNodes(node: number): number[] {
    return [...this.up[node]];
  }

  downNodes(node: number): number[] {
    return this.down[node].filter((value) => value >= 0);
  }

  /** Not loaded or dashed-arrow terminal edges of a row. */
  specialEdges(node: number): readonly InternalEdge[] {
    return this.special[node];
  }

  /** `true` when the edge passed at least one hidden commit. */
  isDashed(from: number, to: number): boolean {
    return this.dashed.has(edgeKey(from, to));
  }

  /** All edges, in row order. */
  *edges(): Iterable<{ up: number; down: number; dashed: boolean }> {
    for (let row = 0; row < this.down.length; row++) {
      for (const target of this.down[row]) {
        if (target >= 0) yield { up: row, down: target, dashed: this.isDashed(row, target) };
      }
    }
  }
}

/** Options of the visible graph computation. */
export interface FilterOptions {
  /** Nodes to start the downward walk from. `null` means all nodes. */
  readonly startNodes: readonly number[] | null;
  /** Keep only the nodes that pass the predicate. */
  readonly predicate: (node: number) => boolean;
  /** Follow only the first parent of each commit. */
  readonly firstParent: boolean;
}

/** The visible graph and the mapping between visible rows and sorted nodes. */
export interface FilterResult {
  readonly graph: VisibleLinearGraph;
  /** Sorted node index -> visible row, or `-1`. */
  readonly rowOf: Int32Array;
  /** Visible row -> sorted node index. */
  readonly nodeOfRow: Int32Array;
}

/**
 * Computes the visible rows and contracts hidden commits.
 *
 * A visible commit keeps an edge to every visible ancestor that is reachable
 * through hidden commits. Such an edge becomes dashed. A hidden chain that ends
 * at a not loaded commit produces a dashed terminal arrow.
 */
export function filterGraph(graph: LinearGraphLike, options: FilterOptions): FilterResult {
  const nodesCount = graph.nodesCount;

  const allowedDown = (node: number): number[] => {
    const downs = graph.downNodes(node);
    return options.firstParent && downs.length > 1 ? [downs[0]] : downs;
  };

  // 1. Mark the visible nodes.
  const visible = new Uint8Array(nodesCount);
  if (options.startNodes === null) {
    for (let node = 0; node < nodesCount; node++) {
      if (options.predicate(node)) visible[node] = 1;
    }
  } else {
    const visited = new Uint8Array(nodesCount);
    const stack = [...options.startNodes].filter((node) => node >= 0 && node < nodesCount);
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (visited[node]) continue;
      visited[node] = 1;
      if (options.predicate(node)) visible[node] = 1;
      for (const down of allowedDown(node)) stack.push(down);
    }
  }

  // 2. Contract the hidden nodes into edges of the visible graph.
  const rowOf = new Int32Array(nodesCount).fill(-1);
  const nodeOfRow: number[] = [];
  for (let node = 0; node < nodesCount; node++) {
    if (visible[node]) {
      rowOf[node] = nodeOfRow.length;
      nodeOfRow.push(node);
    }
  }

  const rows = nodeOfRow.length;
  const down: number[][] = Array.from({ length: rows }, () => []);
  const special: InternalEdge[][] = Array.from({ length: rows }, () => []);
  const dashed = new Set<string>();
  const specialKeys = Array.from({ length: rows }, () => new Set<string>());

  const addSpecial = (row: number, edge: InternalEdge): void => {
    const key = `${edge.type}:${edge.targetId ?? 0}`;
    if (specialKeys[row].has(key)) return;
    specialKeys[row].add(key);
    special[row].push(edge);
  };

  const addDown = (row: number, target: number, viaHidden: boolean): void => {
    if (!down[row].includes(target)) down[row].push(target);
    if (viaHidden) dashed.add(edgeKey(row, target));
  };

  // Expands a hidden chain and adds one dashed edge per visible ancestor.
  const expandHidden = (row: number, start: number): void => {
    const visited = new Set<number>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (visited.has(node)) continue;
      visited.add(node);

      for (const target of allowedDown(node)) {
        if (visible[target]) addDown(row, rowOf[target], true);
        else stack.push(target);
      }
      for (const edge of graph.adjacent(node)) {
        if (edge.type === 'not-loaded' || edge.type === 'dotted-arrow') {
          addSpecial(row, { type: 'dotted-arrow', up: row, down: null, targetId: edge.targetId });
        }
      }
    }
  };

  for (let row = 0; row < rows; row++) {
    const node = nodeOfRow[row];
    const downs = allowedDown(node);
    for (const target of downs) {
      if (visible[target]) addDown(row, rowOf[target], false);
      else expandHidden(row, target);
    }
    // A commit whose only parents are not loaded keeps a terminal arrow.
    if (downs.length === 0) {
      for (const edge of graph.adjacent(node)) {
        if (edge.type === 'not-loaded') {
          addSpecial(row, { type: 'not-loaded', up: row, down: null, targetId: edge.targetId });
        }
      }
    }
  }

  return {
    graph: new VisibleLinearGraph(down, special, dashed),
    rowOf,
    nodeOfRow: Int32Array.from(nodeOfRow),
  };
}
