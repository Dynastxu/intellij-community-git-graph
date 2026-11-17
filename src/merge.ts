import { sortTopologicallyByDate } from './topo';
import type { CommitInput, GraphInput, RefInput, RepositoryInput } from './types';

/** A commit that is present in several repositories, collected before the merge. */
interface CollectedCommit {
  commit: CommitInput;
  parents: string[];
  roots: string[];
  files: string[];
}

/**
 * Merges the histories of several repositories into one input.
 *
 * A commit with the same id in several repositories becomes one commit: the parents and
 * the changed files are united, and the commit records every root. Refs keep their root.
 */
export function mergeRepositories(repositories: readonly RepositoryInput[]): GraphInput {
  const commits = new Map<string, CollectedCommit>();
  const roots: string[] = [];
  const refs: RefInput[] = [];

  for (const repository of repositories) {
    const root = repository.root;
    if (!roots.includes(root)) roots.push(root);

    for (const commit of repository.commits) {
      const existing = commits.get(commit.id);
      if (existing === undefined) {
        commits.set(commit.id, {
          commit,
          parents: [...commit.parents],
          roots: [root],
          files: [...(commit.files ?? [])],
        });
      } else {
        for (const parent of commit.parents) {
          if (!existing.parents.includes(parent)) existing.parents.push(parent);
        }
        for (const file of commit.files ?? []) {
          if (!existing.files.includes(file)) existing.files.push(file);
        }
        if (!existing.roots.includes(root)) existing.roots.push(root);
        if (existing.commit.subject === undefined && commit.subject !== undefined) {
          existing.commit = { ...existing.commit, subject: commit.subject };
        }
      }
    }

    for (const ref of repository.refs ?? []) {
      refs.push({ ...ref, root });
    }
  }

  const merged: CommitInput[] = [];
  for (const collected of commits.values()) {
    merged.push({
      ...collected.commit,
      parents: collected.parents,
      roots: collected.roots,
      files: collected.files.length > 0 ? collected.files : undefined,
    });
  }

  return { commits: sortTopologicallyByDate(merged), refs, roots };
}
