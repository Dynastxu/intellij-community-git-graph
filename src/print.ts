/**
 * Print elements: the drawable rows of the visible graph.
 *
 * Ported from `platform/vcs-log/graph/impl/print` of intellij-community
 * (Apache-2.0): `PrintElementGeneratorImpl`, `EdgesInRowGenerator`,
 * `GraphElementComparatorByLayoutIndex`, `EdgePrintElementImpl`,
 * `TerminalEdgePrintElement`, and the color rules of `GraphColorGetterByHead`
 * with `GraphColorManagerImpl`.
 */
import type { LayoutData, InternalEdge } from './graph';
import { javaStringHash } from './graph';
import type { FilterResult } from './filter';
import type {
  ColorResolver,
  CommitInput,
  GraphEdge,
  GraphEdgeElement,
  GraphNodeElement,
  GraphRow,
  HeadInfo,
  RefInput,
} from './types';

/** Options of the print model. */
export interface PrintInput {
  readonly commits: readonly CommitInput[];
  readonly refsByCommit: ReadonlyMap<number, readonly RefInput[]>;
  readonly layout: LayoutData;
  /** Heads of the layout, left to right, with their refs. */
  readonly heads: readonly HeadInfo[];
  /** Visible row -> usual commit index (`filter.nodeOfRow` mapped through the sort). */
  readonly commitOfRow: Int32Array;
  /** Usual commit index -> layout head order. */
  readonly headOrderOfCommit: Int32Array;
  readonly visible: FilterResult;
  /** Show long edges in full instead of arrows near their ends. */
  readonly showLongEdges: boolean;
  readonly color?: ColorResolver;
  readonly data?: (commit: CommitInput, commitIndex: number) => unknown;
}

/** The print model. */
export interface PrintModel {
  readonly rows: GraphRow[];
  readonly edges: GraphEdge[];
  readonly width: number;
}

interface NormalEdge {
  readonly up: number;
  readonly down: number;
  readonly dashed: boolean;
}

type Item =
  | { readonly kind: 'node'; readonly row: number }
  | { readonly kind: 'edge'; readonly up: number; readonly down: number }
  | { readonly kind: 'special'; readonly row: number; readonly edge: InternalEdge };

export function buildPrintModel(input: PrintInput): PrintModel {
  const { layout, commits, refsByCommit, commitOfRow, visible } = input;
  const graph = visible.graph;
  const rowsCount = graph.nodesCount;

  // The same constants as PrintElementGeneratorImpl.
  const VERY_LONG_EDGE_SIZE = 1000;
  const LONG_EDGE_SIZE = 30;
  const VERY_LONG_EDGE_PART_SIZE = 250;
  const LONG_EDGE_PART_SIZE = 1;

  const longEdgeSize = input.showLongEdges ? VERY_LONG_EDGE_SIZE : LONG_EDGE_SIZE;
  const partSize = input.showLongEdges ? VERY_LONG_EDGE_PART_SIZE : LONG_EDGE_PART_SIZE;
  const edgeWithArrowSize = input.showLongEdges ? VERY_LONG_EDGE_SIZE : Number.POSITIVE_INFINITY;

  const columnOfRow = (row: number): number => layout.column[commitOfRow[row]];

  const normalEdges: NormalEdge[] = [];
  for (const edge of graph.edges()) normalEdges.push(edge);

  const edgesByDown = new Map<number, NormalEdge[]>();
  const edgesByUp = new Map<number, NormalEdge[]>();
  for (const edge of normalEdges) {
    let list = edgesByDown.get(edge.down);
    if (list === undefined) edgesByDown.set(edge.down, (list = []));
    list.push(edge);
    let ups = edgesByUp.get(edge.up);
    if (ups === undefined) edgesByUp.set(edge.up, (ups = []));
    ups.push(edge);
  }

  const isLong = (edge: NormalEdge): boolean => edge.down - edge.up >= longEdgeSize;

  const isVisibleInRow = (edge: NormalEdge, row: number): boolean => {
    const span = edge.down - edge.up;
    if (span < longEdgeSize) return true;
    return Math.min(row - edge.up, edge.down - row) <= partSize;
  };

  const arrowType = (edge: NormalEdge, row: number): 'up' | 'down' | null => {
    const span = edge.down - edge.up;
    const upOffset = row - edge.up;
    const downOffset = edge.down - row;
    if (span >= longEdgeSize) {
      if (upOffset === partSize) return 'down';
      if (downOffset === partSize) return 'up';
    }
    if (span >= edgeWithArrowSize) {
      if (upOffset === 1) return 'down';
      if (downOffset === 1) return 'up';
    }
    return null;
  };

  // ---- build the sorted element list of every row -------------------------

  const upOf = (item: Item): number => {
    if (item.kind === 'node') return item.row;
    if (item.kind === 'edge') return item.up;
    return item.row;
  };

  const downOf = (item: Item): number => (item.kind === 'edge' ? item.down : -1);

  /** Same rule as `GraphElementComparatorByLayoutIndex.compare2`. */
  const compareEdgeToNode = (up: number, down: number, node: number): number => {
    const upColumn = columnOfRow(up);
    const downColumn = down >= 0 ? columnOfRow(down) : upColumn;
    const nodeColumn = columnOfRow(node);
    const maxColumn = Math.max(upColumn, downColumn);
    if (maxColumn !== nodeColumn) return maxColumn - nodeColumn;
    return up - node;
  };

  const compareItems = (a: Item, b: Item): number => {
    if (a.kind === 'node' && b.kind === 'node') return 0;
    if (a.kind === 'node') return -compareEdgeToNode(upOf(b), downOf(b), a.row);
    if (b.kind === 'node') return compareEdgeToNode(upOf(a), downOf(a), b.row);

    // Two edges. A special edge has no lower endpoint, so it compares by its node only.
    const aUp = upOf(a);
    const bUp = upOf(b);
    if (a.kind === 'special' || b.kind === 'special') {
      return compareEdgeToNode(aUp, downOf(a), bUp);
    }

    const aDown = a.down;
    const bDown = b.down;
    if (aUp === bUp) {
      if (aDown < bDown) return -compareEdgeToNode(bUp, bDown, aDown);
      return compareEdgeToNode(aUp, aDown, bDown);
    }
    if (aUp < bUp) return compareEdgeToNode(aUp, aDown, bUp);
    return -compareEdgeToNode(bUp, bDown, aUp);
  };

  const itemsByRow: Item[][] = Array.from({ length: rowsCount }, () => []);
  const nodePosition = new Int32Array(rowsCount);
  const edgePosition = new Map<string, number>();

  for (let row = 0; row < rowsCount; row++) {
    const items = itemsByRow[row];
    items.push({ kind: 'node', row });

    for (const edge of normalEdges) {
      if (edge.up < row && row < edge.down && isVisibleInRow(edge, row)) {
        items.push({ kind: 'edge', up: edge.up, down: edge.down });
      }
    }

    items.sort(compareItems);

    for (let position = 0; position < items.length; position++) {
      const item = items[position];
      if (item.kind === 'node') nodePosition[row] = position;
      if (item.kind === 'edge') edgePosition.set(`${row}:e${item.up}:${item.down}`, position);
    }
  }

  const edgeKeyOf = (edge: NormalEdge): string => `e${edge.up}:${edge.down}`;

  const positionInRow = (row: number, edge: NormalEdge, direction: 'up' | 'down'): number | null => {
    if (row < 0 || row >= rowsCount) return null;
    const direct = edgePosition.get(`${row}:${edgeKeyOf(edge)}`);
    if (direct !== undefined) return direct;
    const endpointRow = direction === 'down' ? edge.down : edge.up;
    if (endpointRow === row) return nodePosition[row];
    return null;
  };

  // ---- colors -------------------------------------------------------------

  const headOfCommit = (commitIndex: number): HeadInfo => {
    const order = input.headOrderOfCommit[commitIndex];
    return input.heads[order] ?? input.heads[0];
  };

  // GraphColorManagerImpl: the head column uses the hash of the head ref; every other
  // column uses its layout index as the color id.
  const defaultColorId = (commitIndex: number): number => {
    const head = headOfCommit(commitIndex);
    const column = layout.column[commitIndex];
    if (column !== head.column) return column;
    const ref = refsByCommit.get(head.commitIndex)?.[0];
    if (ref === undefined) return 0;
    if (typeof ref.color === 'number') return ref.color;
    return javaStringHash(ref.name);
  };

  const resolveColor = (
    kind: 'node' | 'edge',
    commitIndex: number,
    colorId: number,
  ): { colorId: number; color?: string } => {
    if (input.color === undefined) return { colorId };
    const result = input.color({
      kind,
      commitIndex,
      colorId,
      column: layout.column[commitIndex],
      head: headOfCommit(commitIndex),
      refs: refsByCommit.get(commitIndex) ?? [],
    });
    if (typeof result === 'string') return { colorId, color: result };
    if (typeof result === 'number') return { colorId: result };
    return { colorId };
  };

  const colorOfEdge = (edge: NormalEdge): { colorId: number; color?: string } => {
    const upCommit = commitOfRow[edge.up];
    const downCommit = commitOfRow[edge.down];
    const upColumn = layout.column[upCommit];
    const downColumn = layout.column[downCommit];
    const commitIndex = upColumn >= downColumn ? upCommit : downCommit;
    return resolveColor('edge', commitIndex, defaultColorId(commitIndex));
  };

  // ---- emit rows ----------------------------------------------------------

  const rows: GraphRow[] = [];
  const widthByRow: number[] = [];

  for (let row = 0; row < rowsCount; row++) {
    const commitIndex = commitOfRow[row];
    const commit = commits[commitIndex];
    const items = itemsByRow[row];
    const nodePositionInRow = nodePosition[row];
    const nodeColor = resolveColor('node', commitIndex, defaultColorId(commitIndex));
    const node: GraphNodeElement = {
      kind: 'node',
      row,
      position: nodePositionInRow,
      commitIndex,
      commit,
      column: layout.column[commitIndex],
      refs: refsByCommit.get(commitIndex) ?? [],
      isHead: layout.heads.includes(commitIndex),
      colorId: nodeColor.colorId,
      color: nodeColor.color,
      data: input.data?.(commit, commitIndex),
    };

    const elements: GraphEdgeElement[] = [];

    const emitFragments = (position: number, edge: NormalEdge): void => {
      const downPosition = positionInRow(row + 1, edge, 'down');
      const upPosition = positionInRow(row - 1, edge, 'up');
      const arrow = arrowType(edge, row);
      const color = colorOfEdge(edge);
      const from = commitOfRow[edge.up];
      const to = commitOfRow[edge.down];
      const data = input.data?.(commits[from], from);

      if (downPosition !== null) {
        elements.push({
          kind: 'edge',
          row,
          position,
          direction: 'down',
          otherRow: row + 1,
          otherPosition: downPosition,
          from,
          to,
          style: edge.dashed ? 'dashed' : 'solid',
          arrow: arrow === 'down',
          long: isLong(edge),
          colorId: color.colorId,
          color: color.color,
          data,
        });
      } else if (arrow === 'down') {
        elements.push({
          kind: 'edge',
          row,
          position,
          direction: 'down',
          otherRow: row + 1,
          otherPosition: position,
          from,
          to,
          style: edge.dashed ? 'dashed' : 'solid',
          arrow: true,
          long: isLong(edge),
          colorId: color.colorId,
          color: color.color,
          data,
        });
      }

      if (upPosition !== null) {
        elements.push({
          kind: 'edge',
          row,
          position,
          direction: 'up',
          otherRow: row - 1,
          otherPosition: upPosition,
          from,
          to,
          style: edge.dashed ? 'dashed' : 'solid',
          arrow: arrow === 'up',
          long: isLong(edge),
          colorId: color.colorId,
          color: color.color,
          data,
        });
      } else if (arrow === 'up') {
        elements.push({
          kind: 'edge',
          row,
          position,
          direction: 'up',
          otherRow: row - 1,
          otherPosition: position,
          from,
          to,
          style: edge.dashed ? 'dashed' : 'solid',
          arrow: true,
          long: isLong(edge),
          colorId: color.colorId,
          color: color.color,
          data,
        });
      }
    };

    for (let position = 0; position < items.length; position++) {
      const item = items[position];
      if (item.kind === 'edge') {
        emitFragments(position, { up: item.up, down: item.down, dashed: graph.isDashed(item.up, item.down) });
      } else if (item.kind === 'node') {
        for (const edge of edgesByUp.get(row) ?? []) emitFragments(position, edge);
        for (const edge of edgesByDown.get(row) ?? []) emitFragments(position, edge);
      } else {
        const color = resolveColor('edge', commitIndex, defaultColorId(commitIndex));
        elements.push({
          kind: 'edge',
          row,
          position,
          direction: 'down',
          otherRow: row + 1,
          otherPosition: position,
          from: commitIndex,
          to: -1,
          style: item.edge.type === 'not-loaded' ? 'solid' : 'dashed',
          arrow: true,
          long: false,
          colorId: color.colorId,
          color: color.color,
          data: input.data?.(commit, commitIndex),
        });
      }
    }

    // A missing parent or a collapsed chain ends with an arrow stub under the commit,
    // in the commit column.
    for (const special of graph.specialEdges(row)) {
      const color = resolveColor('edge', commitIndex, defaultColorId(commitIndex));
      elements.push({
        kind: 'edge',
        row,
        position: nodePosition[row],
        direction: 'down',
        otherRow: row + 1,
        otherPosition: nodePosition[row],
        from: commitIndex,
        to: -1,
        style: special.type === 'not-loaded' ? 'solid' : 'dashed',
        arrow: true,
        long: false,
        colorId: color.colorId,
        color: color.color,
        data: input.data?.(commit, commitIndex),
      });
    }

    const rowElements = [...elements, node];
    widthByRow[row] = Math.max(...rowElements.map((element) => element.position)) + 1;
    rows.push({ row, commitIndex, commit, node, elements: rowElements });
  }

  const edges: GraphEdge[] = normalEdges.map((edge) => {
    const upCommit = commitOfRow[edge.up];
    const downCommit = commitOfRow[edge.down];
    return {
      from: Math.min(upCommit, downCommit),
      to: Math.max(upCommit, downCommit),
      style: edge.dashed ? 'dashed' : 'solid',
      long: isLong(edge),
    };
  });

  return { rows, edges, width: widthByRow.length > 0 ? Math.max(...widthByRow) : 0 };
}
