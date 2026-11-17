declare global {
  interface Window {
    GitGraph: typeof import('../dist/index');
  }

  type CommitInput = import('../dist/index').CommitInput;
  type RefInput = import('../dist/index').RefInput;
  type GraphResult = import('../dist/index').GraphResult;
  type GraphRow = import('../dist/index').GraphRow;
  type GraphNodeElement = import('../dist/index').GraphNodeElement;
  type GraphEdgeElement = import('../dist/index').GraphEdgeElement;
  type ColorResolver = import('../dist/index').ColorResolver;
  type ColorContext = import('../dist/index').ColorContext;
  type GraphOptions = import('../dist/index').GraphOptions;
  type SortMode = import('../dist/index').SortMode;
  type HeadInfo = import('../dist/index').HeadInfo;
}

export {};
