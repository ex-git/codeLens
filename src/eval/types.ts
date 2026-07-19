export type EvalTaskType = "locate" | "callers" | "tests" | "history";
export type EvalArmName = "full" | "lexical" | "fts" | "rg";
export type EvalProgressStatus = "start" | "progress" | "complete" | "skipped" | "error";

export interface EvalProgressEvent {
  phase: string;
  status: EvalProgressStatus;
  message: string;
  elapsedMs: number;
  scale?: string;
  current?: number;
  total?: number;
}

export type EvalProgressCallback = (event: EvalProgressEvent) => void;

export interface EvalTask {
  id: string;
  type: EvalTaskType;
  query: string;
  expectedPaths: string[];
  confidence: number;
  symbol?: string;
  sourcePath?: string;
  origin: string;
}

export interface EvalObservation {
  foundPaths: string[];
  toolCalls: number;
  bytesServed: number;
  bytesRead: number;
  elapsedMs: number;
  error?: string;
}

export interface EvalTaskRun {
  taskId: string;
  arm: EvalArmName;
  foundPaths: string[];
  recallAtK: number;
  reciprocalRank: number;
  precisionAtK: number;
  success: boolean;
  toolCalls: number;
  bytesServed: number;
  bytesRead: number;
  elapsedMs: number;
  error?: string;
}

export interface EvalAggregate {
  taskCount: number;
  successRate: number;
  recallAtK: number;
  mrr: number;
  precisionAtK: number;
  medianElapsedMs: number;
  p95ElapsedMs: number;
  totalToolCalls: number;
  totalBytesServed: number;
  totalBytesRead: number;
}

export interface EvalThresholds {
  minRecallAtK: number;
  minMrr: number;
  minSuccessRate: number;
}

export interface EvalScaleResult {
  label: string;
  requestedFiles: number | "all";
  indexedFiles: number;
  totalChunks: number;
  skippedFiles: number;
  indexMs: number;
  dbBytes: number;
  tasks: EvalTask[];
  runs: EvalTaskRun[];
  aggregates: Partial<Record<EvalArmName, EvalAggregate>>;
}

export interface EvalFreshnessResult {
  enabled: boolean;
  attempted: boolean;
  passed: boolean;
  modifiedVisible?: boolean;
  deletedRemoved?: boolean;
  elapsedMs?: number;
  skippedReason?: string;
  error?: string;
}

export interface EvalOptions {
  repoRoot: string;
  taskLimit: number;
  seed: number;
  repeats: number;
  resultLimit: number;
  scales: Array<number | "all">;
  outputDir?: string;
  quick: boolean;
  freshness: boolean;
  thresholds: EvalThresholds;
  onProgress?: EvalProgressCallback;
}

export interface EvalResult {
  version: 1;
  repository: {
    root: string;
    branch: string;
    headSha: string;
    dirtyFiles: number;
    totalFiles: number;
  };
  options: Omit<EvalOptions, "repoRoot" | "outputDir" | "onProgress">;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pass: boolean;
  thresholdFailures: string[];
  skipped: string[];
  scales: EvalScaleResult[];
  freshness: EvalFreshnessResult;
  artifacts: {
    directory: string;
    resultsJson: string;
    reportMarkdown: string;
    tasksJson: string;
  };
}

export interface EvalArtifacts {
  directory: string;
  resultsJson: string;
  reportMarkdown: string;
  tasksJson: string;
}
