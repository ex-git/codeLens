/**
 * Hybrid ranking.
 *
 * Combines lexical FTS, symbol name match, graph proximity, exact symbol /
 * path matches, and recency into one ranked list via deterministic weighted
 * fusion (tunable later). Ranking is pure and stable (deterministic tie-break
 * on path then start line).
 *
 * Default weights (sum to 1):
 *   FTS 0.34 / symbol 0.18 / graph 0.22 / code 0.08 / path 0.08 / exact 0.10
 * (recency 0 — reserved for future use; weight stays in the schema but unused
 * until a recency signal is populated.)
 */

export interface SignalScore {
  path: string;
  startLine: number;
  endLine: number;
  chunkId?: string;
  fts?: number;      // 0-1 (higher better)
  symbol?: number;   // 0-1
  graph?: number;    // 0-1 (1 = direct neighbor)
  code?: number;     // 0-1 (1 = code chunk, 0 = prose/docs)
  pathHit?: number;  // 0-1 (1 = query term appears in the file path)
  exact?: number;    // 0-1 (1 = exact symbol-name match for a query term)
  recency?: number;  // 0-1 (reserved)
}

export const DEFAULT_WEIGHTS = {
  fts: 0.34,
  symbol: 0.18,
  graph: 0.22,
  code: 0.08,   // modest code-over-prose boost for code-discovery queries
  pathHit: 0.08, // query term in the file path/name
  exact: 0.10,  // exact symbol-name hit beats a substring match
  recency: 0.0,
};

export interface RankedResult {
  path: string;
  startLine: number;
  endLine: number;
  chunkId?: string;
  score: number;
  why: string[];
}

/** Normalize a raw score to 0-1 using a min-max against the batch (or clamp). */
export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Fuse signal scores into ranked results. Missing signals (undefined) are
 * treated as 0. Weights for absent signals are redistributed proportionally
 * across the present ones so the active weights always sum to 1.
 */
export function rank(signals: SignalScore[], weights = DEFAULT_WEIGHTS): RankedResult[] {
  if (signals.length === 0) return [];

  const present = (["fts", "symbol", "graph", "code", "pathHit", "exact", "recency"] as const).filter((k) =>
    signals.some((s) => s[k] !== undefined),
  );
  const w = { ...weights };
  const absent = (["fts", "symbol", "graph", "code", "pathHit", "exact", "recency"] as const).filter((k) => !present.includes(k));
  const presentTotal = present.reduce((sum, k) => sum + w[k], 0);
  if (absent.length > 0 && presentTotal > 0) {
    const absentTotal = absent.reduce((sum, k) => sum + w[k], 0);
    for (const k of present) w[k] = w[k] + (absentTotal * (w[k] / presentTotal));
    for (const k of absent) w[k] = 0;
  }

  const fused = signals.map((s) => {
    const score =
      (s.fts ?? 0) * w.fts +
      (s.symbol ?? 0) * w.symbol +
      (s.graph ?? 0) * w.graph +
      (s.code ?? 0) * w.code +
      (s.pathHit ?? 0) * w.pathHit +
      (s.exact ?? 0) * w.exact +
      (s.recency ?? 0) * w.recency;
    const why: string[] = [];
    if (s.fts) why.push("fts");
    if (s.symbol) why.push("symbol");
    if (s.exact) why.push("exact");
    if (s.graph) why.push("graph");
    if (s.pathHit) why.push("path");
    if (s.code) why.push("code");
    if (s.recency) why.push("recency");
    return { path: s.path, startLine: s.startLine, endLine: s.endLine, chunkId: s.chunkId, score, why };
  });

  // Deterministic ordering: score desc, then stable tie-break on path + line.
  fused.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return fused;
}