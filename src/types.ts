/**
 * Public types of the git commit graph layout library.
 *
 * The layout is a port of the IntelliJ Community Edition VCS log graph
 * (`platform/vcs-log/graph`, Apache-2.0): a permanent commit DAG, a column
 * layout, IntelliSort (Bek) row ordering, branch / commit filtering with
 * collapsed (dashed) edges, and per-row print elements.
 */

/** A commit of the input history. */
export interface CommitInput {
  /** Stable identifier, for example the commit hash. */
  readonly id: string;
  /** Parent identifiers. A parent that is not present in `commits` is treated as not loaded. */
  readonly parents: readonly string[];
  /** Optional commit subject. The layout ignores it; the filters and the demo use it. */
  readonly subject?: string;
  /** Commit timestamp. The unit must be consistent; milliseconds are recommended. */
  readonly timestamp: number;
  /** Author name, when the history provides it. */
  readonly author?: string;
  /** Author email, when the history provides it. */
  readonly authorEmail?: string;
  /** Author time in milliseconds. The date filter falls back to `timestamp`. */
  readonly authorTime?: number;
  /** Paths changed by the commit, for the structure filter. */
  readonly files?: readonly string[];
  /** Repository roots that contain the commit. The merger fills this field. */
  readonly roots?: readonly string[];
}

/** Kind of a ref. Affects the default head order and the default color. */
export type RefKind = 'local' | 'remote' | 'tag' | 'head' | 'other';

/** A ref that points to a commit. */
export interface RefInput {
  /** Short name: `main`, `origin/main`, `v1.0`, `HEAD`. */
  readonly name: string;
  /** Identifier of the pointed commit. */
  readonly commit: string;
  readonly kind?: RefKind;
  /**
   * Explicit color of the ref. Accepts a CSS color or a color id.
   * When omitted, the library computes the color id from the ref name.
   */
  readonly color?: string | number;
  /** Repository root of the ref, when the input merges several repositories. */
  readonly root?: string;
}

/** One repository of a merged history. */
export interface RepositoryInput {
  /** Stable root identifier, for example the repository path. */
  readonly root: string;
  readonly commits: readonly CommitInput[];
  readonly refs?: readonly RefInput[];
}

/** The input history. */
export interface GraphInput {
  /**
   * Commits in topological order: a parent appears after its children.
   * Use {@link sortTopologicallyByDate} when the order is unknown.
   */
  readonly commits: readonly CommitInput[];
  readonly refs?: readonly RefInput[];
  /** Repository roots, filled by {@link mergeRepositories}. */
  readonly roots?: readonly string[];
}

/** A head of the column layout, together with its refs. */
export interface HeadInfo {
  /** Commit index in `GraphInput.commits`. */
  readonly commitIndex: number;
  readonly commit: CommitInput;
  /** Layout column of the head. */
  readonly column: number;
  /** All refs that point to this commit. */
  readonly refs: readonly RefInput[];
  /** Order of the head in the layout, from left to right. */
  readonly order: number;
}

/** Context of a custom sort. */
export interface SortContext {
  readonly commits: readonly CommitInput[];
  /** Layout column per commit index. */
  readonly column: Int32Array;
  /** Commit indexes of the layout heads, left to right. */
  readonly heads: readonly number[];
  /** Parent commit indexes per commit index. Missing parents are negative. */
  readonly parents: readonly (readonly number[])[];
  readonly timestamps: Float64Array;
  /** Sorted index of a commit index, after the sort that runs now (identity before the sort). */
  readonly sortedIndex: (commitIndex: number) => number;
}

/**
 * Order of the rows.
 * - `intellisort`: IntelliSort (Bek): incoming commits of a merge go right below it.
 * - `input`: keep the input order, which must be topological.
 * - `first-parent`: keep the input order and hide all non-first-parent edges.
 * - a function: a custom order. It receives {@link SortContext} and returns the usual
 *   commit index of every sorted row, top to bottom.
 */
export type SortMode =
  'intellisort' | 'input' | 'first-parent' | ((context: SortContext) => readonly number[] | Int32Array);

/** Context of a custom color resolver. */
export interface ColorContext {
  readonly kind: 'node' | 'edge';
  /** Commit index in `GraphInput.commits`. */
  readonly commitIndex: number;
  /** Default color id, computed by the library. */
  readonly colorId: number;
  /** Column of the commit. */
  readonly column: number;
  /** Head that owns the column of the commit. */
  readonly head: HeadInfo;
  readonly refs: readonly RefInput[];
}

/**
 * Resolves a color for a node or an edge.
 * Return a number for a color id, or a string for a CSS color.
 */
export type ColorResolver = (context: ColorContext) => number | string | undefined;

/** Options of {@link buildGraph}. */
export interface GraphOptions {
  /** Default: `input`, the IntelliJ Normal sort. */
  readonly sort?: SortMode;
  /** Hide all edges that are not first-parent edges. Implies `sort: 'first-parent'` when `sort` is not set. */
  readonly firstParent?: boolean;
  /** Commit ids of the visible heads. Commits that are not their ancestors are hidden. */
  readonly visibleHeads?: readonly string[];
  /** Extra commit filter. Return `true` to keep a commit. */
  readonly visibleCommits?: (commit: CommitInput, commitIndex: number) => boolean;
  /** Show long edges in full instead of arrows near their ends. Default: `false`. */
  readonly showLongEdges?: boolean;
  /** Order of the layout heads, left to right. Negative means `a` goes first. */
  readonly headComparator?: (a: HeadInfo, b: HeadInfo) => number;
  /** Custom color id / CSS color for nodes and edges. */
  readonly color?: ColorResolver;
  /** Custom per-element payload, copied to nodes and to edges that start at the commit. */
  readonly data?: (commit: CommitInput, commitIndex: number) => unknown;
}

/** A drawable node. */
export interface GraphNodeElement {
  readonly kind: 'node';
  /** Visible row of the node. */
  readonly row: number;
  /** Column of the node in its row. */
  readonly position: number;
  /** Commit index in `GraphInput.commits`. */
  readonly commitIndex: number;
  readonly commit: CommitInput;
  /** Layout column of the commit. */
  readonly column: number;
  readonly refs: readonly RefInput[];
  /** `true` when the commit is a layout head. */
  readonly isHead: boolean;
  readonly colorId: number;
  /** CSS color, when the resolver returned a string. */
  readonly color?: string;
  readonly data?: unknown;
}

/** A drawable edge fragment. One commit-to-commit edge is split into several fragments. */
export interface GraphEdgeElement {
  readonly kind: 'edge';
  /** Row of the fragment. */
  readonly row: number;
  /** Column of the fragment in its row. */
  readonly position: number;
  /**
   * Direction of the fragment:
   * `down` goes to row + 1, `up` goes to row - 1.
   */
  readonly direction: 'up' | 'down';
  /** Row of the other end of the fragment. */
  readonly otherRow: number;
  /** Column of the other end of the fragment. */
  readonly otherPosition: number;
  /** Commit index of the upper endpoint of the whole edge. */
  readonly from: number;
  /** Commit index of the lower endpoint of the whole edge. Missing endpoints are `-1`. */
  readonly to: number;
  /** `dashed` for collapsed hidden commits and not loaded commits. */
  readonly style: 'solid' | 'dashed';
  /** `true` when the fragment ends with a terminal arrow. */
  readonly arrow: boolean;
  /** `true` when the whole edge is longer than `longEdgeSize`. */
  readonly long: boolean;
  readonly colorId: number;
  readonly color?: string;
  /** Data of the commit of `from`. */
  readonly data?: unknown;
}

export type GraphElement = GraphNodeElement | GraphEdgeElement;

/** One visible row of the graph. */
export interface GraphRow {
  readonly row: number;
  readonly commitIndex: number;
  readonly commit: CommitInput;
  readonly node: GraphNodeElement;
  /**
   * Elements of the row, in drawing order: edges first, the node last.
   * A renderer draws each edge fragment from `(position, row)` to `(otherPosition, otherRow)`
   * and each node at `(position, row)`.
   */
  readonly elements: readonly GraphElement[];
}

/** A commit-to-commit edge of the visible graph. */
export interface GraphEdge {
  /** Commit index of the upper endpoint. */
  readonly from: number;
  /** Commit index of the lower endpoint. `-1` for a not loaded commit. */
  readonly to: number;
  readonly style: 'solid' | 'dashed';
  readonly long: boolean;
}

/** Layout data of the visible graph. */
export interface GraphLayout {
  /** Layout column per commit index (input order). */
  readonly column: Int32Array;
  /** Head commit indexes, left to right. */
  readonly heads: readonly HeadInfo[];
  /** Head order per commit index. */
  readonly headOrder: Int32Array;
  /** Number of columns. */
  readonly width: number;
}

/** Result of {@link buildGraph}. */
export interface GraphResult {
  readonly rows: readonly GraphRow[];
  readonly edges: readonly GraphEdge[];
  readonly layout: GraphLayout;
  /** Number of rows. */
  readonly rowCount: number;
  /** Maximum element position plus one. */
  readonly width: number;
  /** Refs grouped by commit index. */
  readonly refsByCommit: ReadonlyMap<number, readonly RefInput[]>;
}
