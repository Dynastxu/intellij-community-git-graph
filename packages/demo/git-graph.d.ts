declare global {
  interface Window {
    GitGraph: typeof import('@dynastxu/intellij-community-git-graph');
  }

  type CommitInput = import('@dynastxu/intellij-community-git-graph').CommitInput;
  type RefInput = import('@dynastxu/intellij-community-git-graph').RefInput;
  type GraphResult = import('@dynastxu/intellij-community-git-graph').GraphResult;
  type GraphRow = import('@dynastxu/intellij-community-git-graph').GraphRow;
  type GraphNodeElement = import('@dynastxu/intellij-community-git-graph').GraphNodeElement;
  type GraphEdgeElement = import('@dynastxu/intellij-community-git-graph').GraphEdgeElement;
  type ColorResolver = import('@dynastxu/intellij-community-git-graph').ColorResolver;
  type ColorContext = import('@dynastxu/intellij-community-git-graph').ColorContext;
  type GraphOptions = import('@dynastxu/intellij-community-git-graph').GraphOptions;
  type SortMode = import('@dynastxu/intellij-community-git-graph').SortMode;
  type HeadInfo = import('@dynastxu/intellij-community-git-graph').HeadInfo;
  type Filter = import('@dynastxu/intellij-community-git-graph').Filter;
  type GraphInput = import('@dynastxu/intellij-community-git-graph').GraphInput;
  type RepositoryInput = import('@dynastxu/intellij-community-git-graph').RepositoryInput;
}

export {};
