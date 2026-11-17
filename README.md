# intellij-community-git-graph

[![CI](https://github.com/dynastxu/intellij-community-git-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/dynastxu/intellij-community-git-graph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dynastxu/intellij-community-git-graph.svg)](https://www.npmjs.com/package/@dynastxu/intellij-community-git-graph)

A TypeScript port of the IntelliJ Community Edition VCS log commit graph.

Input: a commit history (`id`, `parents`, `timestamp`) and refs.
Output: drawable rows with nodes and edge fragments.
The caller decides the paint colors, the stroke widths, and the rendering library.

The port follows `platform/vcs-log/graph` of [intellij-community](https://github.com/JetBrains/intellij-community)
(Apache-2.0). It is not an official JetBrains project.

## Status

- Pure functions. No framework, no DOM, no Node API.
- Deterministic output.
- Tested with golden cases, with property tests on random DAGs, and with a jsdom test of the demo page.

## Install and build

The package manager is pnpm. The demo is a private workspace package in `packages/demo`.

```sh
pnpm install
pnpm run build
pnpm test
```

The published package is `@dynastxu/intellij-community-git-graph`:

```sh
pnpm add @dynastxu/intellij-community-git-graph
```

## Quick start

```ts
import { buildGraph, colorFromId, sortTopologicallyByDate } from '@dynastxu/intellij-community-git-graph';

const input = {
  commits: sortTopologicallyByDate([
    { id: 'c0', parents: [], timestamp: 1 },
    { id: 'c1', parents: ['c0'], timestamp: 2 },
    { id: 'c2', parents: ['c1'], timestamp: 3 },
    { id: 'm', parents: ['c2', 'c0'], timestamp: 4 },
  ]),
  refs: [
    { name: 'main', commit: 'm', kind: 'local' },
    { name: 'origin/main', commit: 'm', kind: 'remote' },
  ],
};

const graph = buildGraph(input);

for (const row of graph.rows) {
  for (const element of row.elements) {
    if (element.kind === 'node') {
      drawCircle(element.position, element.row, element.color ?? colorFromId(element.colorId));
    } else {
      drawFragment(element.position, element.row, element.otherPosition, element.otherRow, {
        stroke: element.color ?? colorFromId(element.colorId),
        dashed: element.style === 'dashed',
        width: element.long ? 3 : 1,
      });
    }
  }
}
```

`packages/demo/index.html` is a live demo. It draws the model in the browser and lets you
change the sort, the filters, the colors, and the row height. It can also read the
history of a folder on this machine.

## Live demo

```sh
ppnpm run demo
```

The command builds the library and the demo, starts a local server, prints the URL, and
opens the browser:

```
  Git graph demo: http://127.0.0.1:4173/
  Use "Open a git folder..." in the page to read a repository.
  Press Ctrl+C to stop.
```

If the port is busy, the server takes the next free port. If the browser does not open,
copy the printed URL. Stop the server with `Ctrl+C`.

`pnpm run serve:demo` starts the server without a rebuild. `node packages/demo/build/server.js serve --port 8080`
sets another port. `node packages/demo/build/server.js bundle` only rebuilds the browser bundle.

The page also works from `file://` without a server: open `packages/demo/index.html` directly
after `pnpm run build`. In that mode the folder picker is disabled, because a browser
cannot read `.git`.

### The demo is TypeScript

All demo code is TypeScript, next to the library:

| File                                                           | Role                                                                          | Output                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| [`packages/demo/page.ts`](packages/demo/page.ts)               | page logic: model building, canvas painting, controls, filters, folder dialog | `packages/demo/build/page.js`   |
| [`packages/demo/server.ts`](packages/demo/server.ts)           | static server, folder listing, git reading, browser bundle                    | `packages/demo/build/server.js` |
| [`packages/demo/git-graph.d.ts`](packages/demo/git-graph.d.ts) | ambient type of the `window.GitGraph` bundle                                  | types only                      |
| [`packages/demo/index.html`](packages/demo/index.html)         | markup and CSS; loads two compiled scripts                                    | page shell                      |

Build steps:

```sh
pnpm run build:lib     # src -> dist
pnpm run build:demo    # demo/*.ts -> packages/demo/build/*.js
pnpm run bundle        # dist -> packages/demo/build/git-graph.js
pnpm run build         # all three
```

`tsconfig.demo.json` uses `moduleDetection: legacy`, so `page.ts` compiles to a classic
script. The page loads it with a plain `<script src>` tag.

### Read a real repository

Click **Open a git folder…** in the page. The dialog lists the folders of this
machine. A **git** badge means that the folder contains a repository. Click the badge
to load the history.

The page reads the repository through the local server:

- `GET /api/browse?path=…` lists the subfolders and marks the repositories;
- `POST /api/pick` opens the system folder dialog and returns the chosen path;
- `GET /api/git?path=…&limit=…` runs `git log` and `git for-each-ref`, then returns
  commits and refs in the shape of `GraphInput`.

**Browse… (system dialog)** calls the native folder picker of the operating system:

| System  | Command                                                   |
| ------- | --------------------------------------------------------- |
| Windows | PowerShell and `System.Windows.Forms.FolderBrowserDialog` |
| macOS   | `osascript` and `choose folder`                           |
| Linux   | `zenity --file-selection --directory`, then `kdialog`     |

The dialog opens on the desktop of the user who runs `ppnpm run demo`. A cancelled
dialog returns `null` and changes nothing. If no system dialog is available (headless
session, no Zenity), the page shows an error and the in-page folder list still works.
In that case, type the path in the dialog and press **Go**.

The dialog sets the commit limit. A truncated history shows terminal arrows for the
missing parents.

### Why a local server

A page in a browser cannot read `.git`: the objects are compressed and packed, and a
folder picker does not expose an absolute path. The demo therefore needs a local
helper, and the library needs a browser bundle. Both come from `packages/demo/server.ts`:

| Part               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `buildBundle`      | wraps `dist` into `packages/demo/build/git-graph.js` (`window.GitGraph`) |
| `readGitHistory`   | calls `git log` and `git for-each-ref`                                   |
| `browseDirectory`  | lists folders for the dialog                                             |
| `createDemoServer` | serves the page and the two API endpoints                                |
| `main`             | the command line: `bundle` or `serve`                                    |

The demo has no dependencies beyond Node.js and `git`. The page logic is compiled from
TypeScript, not written in JavaScript by hand.

The demo shows:

- the input JSON, which you can edit and apply;
- several repositories in one graph; open a folder again to add another one;
- text, hash, user, branch, date, path, revision, range, merge and repository filters;
- IntelliJ Normal order (default), IntelliSort, first-parent mode;
- commit subjects and refs in a text column right of the graph;
- three color modes and a row height control;
- straight edge segments with sharp corners, no smooth curves;
- one canvas row per commit, painted with the IntelliJ cell painter rules;
- refs and the commit subject start right after the graph of their row, so text never
  crosses a line;
- the exact `buildGraph()` output, which you can copy as JSON;
- a real repository from the folder picker.

The demo package has its own lint and format scripts:

```sh
pnpm run lint          # eslint on packages/demo
pnpm run format        # prettier --write on packages/demo
```

## Input

```ts
interface CommitInput {
  id: string;
  parents: string[]; // a parent that is not in the input is treated as not loaded
  subject?: string; // optional; the filters and the demo use it
  timestamp: number; // any unit; keep it consistent
  author?: string;
  authorEmail?: string;
  authorTime?: number; // the date filter falls back to timestamp
  files?: string[]; // changed paths, for the structure filter
  roots?: string[]; // filled by mergeRepositories
}

interface GraphInput {
  commits: CommitInput[]; // topological order: a parent appears after its children
  refs?: RefInput[];
  roots?: string[];
}

interface RefInput {
  name: string; // main, origin/main, v1.0, HEAD
  commit: string;
  kind?: 'local' | 'remote' | 'tag' | 'head' | 'other';
  color?: string | number; // optional explicit color
}
```

Use `sortTopologicallyByDate(commits)` when the input order is unknown.
`buildGraph` throws when a parent is not below its child.

## Output

```ts
graph.rows: GraphRow[]       // visible rows, top to bottom
graph.edges: GraphEdge[]     // commit-to-commit edges
graph.layout: GraphLayout    // column per commit, heads, width
graph.width: number          // maximum element position plus one
```

Every row has one node and a list of elements:

- `GraphNodeElement`: `row`, `position`, `commitIndex`, `column`, `refs`, `isHead`, `colorId`, `color`, `data`.
- `GraphEdgeElement`: `row`, `position`, `direction` (`up` to the row above, `down` to the row below),
  `otherRow`, `otherPosition`, `from`, `to`, `style` (`solid` / `dashed`), `arrow`, `long`,
  `colorId`, `color`, `data`.

A commit-to-commit edge is split into fragments, one per row band. Draw a fragment
from `(position, row)` to `(otherPosition, otherRow)`. Draw the node at
`(position, row)`.

`position` and `otherPosition` are the IntelliJ element slots of a row: the index of
an element in the row, not a layout column. IntelliJ paints the slot positions with
straight lines and sharp corners (`SimpleGraphCellPainter`), and so does the demo.

Special values:

- `to === -1`: the edge ends at a commit that is not loaded. `arrow` is `true`.
- `long === true`: the edge is at least 30 rows long. Its middle rows carry no fragment.
- `style === 'dashed'`: the edge passed at least one hidden commit.

## Multiple repositories

`mergeRepositories` combines `RepositoryInput[]` into one `GraphInput`:

```ts
import { buildGraph, mergeRepositories } from '@dynastxu/intellij-community-git-graph';

const input = mergeRepositories([
  { root: '/work/repo-a', commits: commitsA, refs: refsA },
  { root: '/work/repo-b', commits: commitsB, refs: refsB },
]);
const graph = buildGraph(input);
```

The same commit in two repositories becomes one commit: parents and files unite,
`commit.roots` records both roots, and refs keep `ref.root`.

## Filters

`applyFilters` follows `VcsLogFiltererImpl`: filters of different kinds combine with
AND, values inside one filter with OR. Branch, revision and range filters also restrict
the visible heads.

```ts
import { applyFilters, buildGraph } from '@dynastxu/intellij-community-git-graph';

const result = applyFilters(input, [
  { kind: 'text', text: 'fix' },
  { kind: 'branch', branches: ['main'] },
  { kind: 'date', after: Date.parse('2025-01-01') },
  { kind: 'structure', paths: ['src'] },
]);
const graph = buildGraph(input, {
  visibleCommits: (_commit, index) => result.matched[index],
  visibleHeads: result.heads ?? undefined,
});
```

Filter kinds: `text` (subject, id, author; `regex` and `matchCase` options), `hash`
(prefixes), `user` (name or email), `date`, `branch`, `root`, `revision`, `range`
(`from..to`), `parent` (merges), `structure` (paths, `*` wildcard).

## Customization

### Row order

```ts
buildGraph(input, { sort: 'input' }); // default: IntelliJ Normal (topological graph order)
buildGraph(input, { sort: 'intellisort' }); // IntelliSort (Bek)
buildGraph(input, { sort: (ctx) => order }); // order is commitIndex per sorted row
```

A custom order is checked. `buildGraph` throws when an edge points upwards.
`SortContext` exposes `commits`, `column`, `heads`, `parents`, and `timestamps`.

### Filtering

```ts
buildGraph(input, {
  visibleCommits: (commit, index) => !commit.id.startsWith('wip/'),
  visibleHeads: ['main'],
});
```

Hidden commits are removed from the rows and contracted into dashed edges.
A hidden chain that ends at a not loaded commit becomes a dashed terminal arrow.

```ts
buildGraph(input, { firstParent: true });
```

First-parent mode hides every edge except the first-parent edge.
The heads of the visible branches stay visible, as in IntelliJ.

### Colors

The default color id follows `GraphColorManagerImpl`:

- a commit in the column of its layout head gets the Java `String.hashCode` of the first
  ref name of that head, or `0` when the head has no ref;
- a commit in any other column gets its layout index as the color id.

`colorFromId(id)` turns a color id into a color with the `DefaultColorGenerator` formula.

Replace the default with a resolver:

```ts
buildGraph(input, {
  color: ({ kind, commitIndex, colorId, column, head, refs }) => {
    if (kind === 'node') return refs[0]?.color ?? palette[column % palette.length];
    return colorId;
  },
});
```

The resolver returns a number (a color id) or a string (a CSS color).
The edge color is the color of the endpoint with the larger layout column, as in
`PrintElementPresentationManagerImpl`.

### Widths and other paint attributes

The model stores geometry and style hints, not paint sizes. The renderer maps
`style`, `long`, and `arrow` to stroke width and dash patterns.
`data` attaches caller payload to a node and to the edges that start at the commit:

```ts
buildGraph(input, { data: (commit) => ({ highlighted: commit.id === 'abc1234' }) });
```

### Head order

```ts
buildGraph(input, {
  headComparator: (a, b) => a.refs[0].name.localeCompare(b.refs[0].name),
});
```

Negative means that `a` is laid out more to the left.

## Mapping to IntelliJ

| This library                           | IntelliJ                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `buildPermanentData`, `PermanentGraph` | `PermanentLinearGraphBuilder`, `PermanentLinearGraphImpl`                                 |
| `buildLayout`                          | `GraphLayoutBuilder`, `GraphLayoutImpl`                                                   |
| `intelliSort`                          | `BekSorter`, `BekBranchCreator`, `BekBranchMerger`, `BekEdgeRestrictions`                 |
| `filterGraph`, `VisibleLinearGraph`    | `FilteredController`, `FirstParentController`, `DottedFilterEdgesGenerator`               |
| `buildPrintModel`                      | `PrintElementGeneratorImpl`, `EdgesInRowGenerator`, `GraphElementComparatorByLayoutIndex` |
| `colorFromId`                          | `DefaultColorGenerator`                                                                   |

## Differences from IntelliJ

- One-shot build. There are no interactive actions: collapse, expand, cursor, and selection.
- Hidden commits are contracted in one pass. IntelliJ keeps a mutable collapsed graph.
- Long-edge thresholds are options. IntelliJ uses fixed constants.
- The element positions are recomputed for every row. IntelliJ caches them per block.
- The demo uses the gitnut canvas painter: a row is a clipped cell, diagonal edges are
  drawn to the neighbour row centre and clipped, vertical edges stop at the cell border.
  This is the same geometry as `SimpleGraphCellPainter`.
- `GraphEdgeElement.from` and `to` are commit indexes. IntelliJ uses vertex ids.

## Release

CI runs on every push to `main` and on every pull request: lint, format check,
typecheck, tests, and a `dist` artifact. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Publishing runs for a `vX.Y.Z` tag or from the manual workflow:

```sh
git tag v0.1.0
git push origin main v0.1.0
```

The publish workflow sends the package to npm and to GitHub Packages. The npm job uses
[trusted publishing](https://docs.npmjs.com/trusted-publishers): configure the
`@dynastxu/intellij-community-git-graph` package on npmjs.com with this repository and
the `publish.yml` workflow. GitHub Packages uses the workflow `GITHUB_TOKEN`.
See [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## License and attribution

The original library code is Copyright JetBrains s.r.o. and the IntelliJ
contributors, licensed under Apache-2.0. This port keeps the same license. See `NOTICE`.

The demo canvas painter is adapted from **GitNut by Flying Art**
(https://github.com/flyingart/gitnut), Apache-2.0, which ports IntelliJ's
`SimpleGraphCellPainter`. `NOTICE` lists the copied files. Redistribution must keep the
Apache-2.0 license text, the `NOTICE` file, and the GitNut credit.

No code from Lanes was copied; it was read for comparison only.
