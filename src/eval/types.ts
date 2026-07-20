export type EvalSuiteName = "retrieval" | "graph" | "freshness";
export type EvalTaskType = "locate" | "history" | "callers" | "tests";
export type EvalRetrievalTaskType = Extract<EvalTaskType, "locate" | "history">;
export type EvalGraphTaskType = Extract<EvalTaskType, "callers" | "tests">;
export type EvalRetrievalArmName = "full" | "lexical" | "fts" | "rg";
export type EvalArmName = EvalRetrievalArmName | "graph";
export type EvalProgressStatus = "start" | "progress" | "complete" | "skipped" | "error";
export type EvalGroundTruthKind = "auto-index" | "git-history" | "frozen-reviewed" | "frozen-unreviewed";

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

export interface EvalGroundTruth {
  kind: EvalGroundTruthKind;
  independent: boolean;
}

export interface EvalTask {
  id: string;
  suite: Exclude<EvalSuiteName, "freshness">;
  type: EvalTaskType;
  query: string;
  targetPath?: string;
  expectedPaths: string[];
  confidence: number;
  contributesToThresholds: boolean;
  origin: string;
  groundTruth: EvalGroundTruth;
  symbol?: string;
}

export interface EvalTaskFile {
  version: 1;
  source?: string;
  independentGroundTruth: boolean;
  tasks: Array<{
    id: string;
    suite: Exclude<EvalSuiteName, "freshness">;
    type: EvalTaskType;
    query: string;
    targetPath?: string;
    expectedPaths: string[];
    confidence?: number;
    contributesToThresholds?: boolean;
    origin?: string;
  }>;
}

export interface EvalTaskSource {
  kind: "automatic-self-evaluation" | "frozen-task-file" | "none";
  independentGroundTruth: boolean;
  source?: string;
}

export interface EvalObservation {
  foundPaths: string[];
  toolCalls: number;
  bytesServed: number;
  elapsedMs: number;
  error?: string;
}

export interface EvalTaskRun {
  taskId: string;
  arm: EvalArmName;
  repeat: number;
  order: number;
  foundPaths: string[];
  recallAtK: number;
  reciprocalRank: number;
  precisionAtK: number;
  success: boolean;
  toolCalls: number;
  bytesServed: number;
  elapsedMs: number;
  error?: string;
}

export interface EvalConfidenceInterval {
  low: number;
  high: number;
}

export interface EvalAggregate {
  taskCount: number;
  sampleCount: number;
  successRate: number;
  recallAtK: number;
  mrr: number;
  precisionAtK: number;
  confidence95: {
    successRate: EvalConfidenceInterval;
    recallAtK: EvalConfidenceInterval;
    mrr: EvalConfidenceInterval;
    precisionAtK: EvalConfidenceInterval;
  };
  medianElapsedMs: number;
  p95ElapsedMs: number;
  totalToolCalls: number;
  totalBytesServed: number;
}

export interface EvalThresholds {
  minRecallAtK: number;
  minMrr: number;
  minSuccessRate: number;
  minGraphPrecision: number;
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
  retrieval: Partial<Record<EvalRetrievalTaskType, Partial<Record<EvalRetrievalArmName, EvalAggregate>>>>;
  graph: Partial<Record<EvalGraphTaskType, EvalAggregate>>;
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
  suites: EvalSuiteName[];
  taskFile?: string;
  outputDir?: string;
  quick: boolean;
  thresholds: EvalThresholds;
  onProgress?: EvalProgressCallback;
}

export interface EvalResult {
  version: 2;
  methodology: {
    taskSource: EvalTaskSource;
    taskSetDigest: string;
    retrievalComparable: true;
    graphIndependentGroundTruth: boolean;
    repeatsAreTimingSamples: true;
    scaleTasksFrozen: true;
    notes: string[];
  };
  repository: {
    root: string;
    branch: string;
    headSha: string;
    dirtyFiles: number;
    totalFiles: number;
  };
  options: {
    taskLimit: number;
    seed: number;
    repeats: number;
    resultLimit: number;
    scales: Array<number | "all">;
    suites: EvalSuiteName[];
    quick: boolean;
    thresholds: EvalThresholds;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pass: boolean;
  thresholdFailures: string[];
  skipped: string[];
  scales: EvalScaleResult[];
  freshness: EvalFreshnessResult;
  artifacts: EvalArtifacts;
}

export interface EvalArtifacts {
  directory: string;
  resultsJson: string;
  reportMarkdown: string;
  tasksJson: string;
}
