import type { CommitInput } from './types';

/** Index of every commit id; the first occurrence wins. */
export function indexCommits(commits: readonly CommitInput[]): Map<string, number> {
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
