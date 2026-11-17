import type { CommitInput, GraphInput, RefInput } from './types';

/** A log filter, one per IntelliJ `VcsLogFilter` kind. */
export type Filter =
  | { readonly kind: 'text'; readonly text: string; readonly regex?: boolean; readonly matchCase?: boolean }
  | { readonly kind: 'hash'; readonly hashes: readonly string[] }
  | { readonly kind: 'user'; readonly users: readonly string[] }
  | { readonly kind: 'date'; readonly after?: number; readonly before?: number }
  | { readonly kind: 'branch'; readonly branches: readonly string[] }
  | { readonly kind: 'root'; readonly roots: readonly string[] }
  | { readonly kind: 'revision'; readonly commits: readonly string[] }
  | { readonly kind: 'range'; readonly ranges: readonly { readonly from?: string; readonly to: string }[] }
  | { readonly kind: 'parent'; readonly merges?: boolean }
  | { readonly kind: 'structure'; readonly paths: readonly string[] };

/** The result of {@link applyFilters}. */
export interface FilterResult {
  /** Commit index -> keep the commit. */
  readonly matched: readonly boolean[];
  /** Commit ids of the visible heads, or `null` when every head is visible. */
  readonly heads: readonly string[] | null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function pathMatches(file: string, pattern: string): boolean {
  const path = normalizePath(file);
  const wanted = normalizePath(pattern);
  if (wanted.includes('*')) {
    const regex = new RegExp(`^${wanted.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return regex.test(path);
  }
  return path === wanted || path.startsWith(`${wanted}/`);
}

function branchMatches(ref: RefInput, name: string): boolean {
  if (ref.name === name || ref.commit === name) return true;
  if (name.includes('/')) return false;
  const short = ref.name.split('/').pop();
  return short === name;
}

function textPredicate(filter: Extract<Filter, { kind: 'text' }>): (commit: CommitInput) => boolean {
  const fields = (commit: CommitInput): string[] => [
    commit.subject ?? '',
    commit.id,
    commit.author ?? '',
    commit.authorEmail ?? '',
  ];
  if (filter.regex === true) {
    let regex: RegExp;
    try {
      regex = new RegExp(filter.text, filter.matchCase === true ? '' : 'i');
    } catch {
      return () => false;
    }
    return (commit) => fields(commit).some((value) => regex.test(value));
  }
  const needle = filter.matchCase === true ? filter.text : filter.text.toLowerCase();
  return (commit) => fields(commit).some((value) => {
    const haystack = filter.matchCase === true ? value : value.toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Applies a set of filters to a history, like `VcsLogFiltererImpl`.
 *
 * Filters of different kinds are combined with AND; values inside one filter are
 * combined with OR. Branch, revision and range filters also restrict the visible heads.
 */
export function applyFilters(input: GraphInput, filters: readonly Filter[]): FilterResult {
  const commits = input.commits;
  const byId = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    if (!byId.has(commits[i].id)) byId.set(commits[i].id, i);
  }

  const parentIndexes = (index: number): number[] => {
    const result: number[] = [];
    for (const parent of commits[index].parents) {
      const parentIndex = byId.get(parent);
      if (parentIndex !== undefined) result.push(parentIndex);
    }
    return result;
  };

  const ancestors = (start: readonly number[]): Set<number> => {
    const seen = new Set<number>();
    const stack = [...start];
    while (stack.length > 0) {
      const index = stack.pop() as number;
      if (seen.has(index)) continue;
      seen.add(index);
      for (const parent of parentIndexes(index)) stack.push(parent);
    }
    return seen;
  };

  const predicates: Array<(commit: CommitInput, index: number) => boolean> = [];
  const ranges: Array<{ include: Set<number>; exclude: Set<number> }> = [];
  let heads: string[] | null = null;
  const addHeads = (ids: readonly string[]): void => {
    heads = [...(heads ?? []), ...ids];
  };

  for (const filter of filters) {
    switch (filter.kind) {
      case 'text':
        predicates.push(textPredicate(filter));
        break;
      case 'hash': {
        const needles = filter.hashes.map((hash) => hash.toLowerCase());
        predicates.push((commit) => needles.some((hash) => commit.id.toLowerCase().startsWith(hash)));
        break;
      }
      case 'user': {
        const users = filter.users.map((user) => user.toLowerCase());
        predicates.push((commit) => {
          const author = (commit.author ?? '').toLowerCase();
          const email = (commit.authorEmail ?? '').toLowerCase();
          return users.some((user) => author.includes(user) || email.includes(user));
        });
        break;
      }
      case 'date':
        predicates.push((commit) => {
          const time = commit.authorTime ?? commit.timestamp;
          if (filter.after !== undefined && time <= filter.after) return false;
          if (filter.before !== undefined && time >= filter.before) return false;
          return true;
        });
        break;
      case 'root':
        predicates.push((commit) => {
          const roots = commit.roots ?? [];
          return roots.some((root) => filter.roots.includes(root));
        });
        break;
      case 'structure':
        predicates.push((commit) => {
          const files = commit.files ?? [];
          return files.some((file) => filter.paths.some((path) => pathMatches(file, path)));
        });
        break;
      case 'parent':
        predicates.push((commit) => {
          const merges = commit.parents.length > 1;
          return filter.merges === undefined || merges === filter.merges;
        });
        break;
      case 'branch': {
        const ids: string[] = [];
        for (const branch of filter.branches) {
          for (const ref of input.refs ?? []) {
            if (branchMatches(ref, branch)) ids.push(ref.commit);
          }
          if (byId.has(branch)) ids.push(branch);
        }
        addHeads(ids);
        break;
      }
      case 'revision':
        addHeads(filter.commits);
        break;
      case 'range': {
        for (const range of filter.ranges) {
          const toIndex = byId.get(range.to);
          if (toIndex === undefined) continue;
          addHeads([range.to]);
          const include = ancestors([toIndex]);
          const exclude = range.from !== undefined && byId.has(range.from)
            ? ancestors([byId.get(range.from) as number])
            : new Set<number>();
          ranges.push({ include, exclude });
        }
        break;
      }
    }
  }

  const visible = heads === null ? null : ancestors((heads as string[]).map((id) => byId.get(id)).filter((index): index is number => index !== undefined));

  const matched = commits.map((commit, index) => {
    if (visible !== null && !visible.has(index)) return false;
    if (ranges.length > 0) {
      const inRange = ranges.some((range) => range.include.has(index) && !range.exclude.has(index));
      if (!inRange) return false;
    }
    return predicates.every((predicate) => predicate(commit, index));
  });

  if (heads !== null) {
    heads = (heads as string[]).filter((id, position, all) => byId.has(id) && all.indexOf(id) === position);
  }

  return { matched, heads };
}
