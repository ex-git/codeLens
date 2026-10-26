import type Database from "better-sqlite3";
import { collectDiff, type DiffOptions } from "../git/diff.js";
import { detectScope, type GitScope } from "../git/scope.js";
import { computeIndexId } from "../index/identity.js";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, isStalePath } from "../index/staleness.js";
import { bounded } from "../graph/query.js";
import type { IndexedSymbol } from "../graph/targets.js";
import { GRAPH_VERSION } from "../graph/edges.js";
import { impactForTarget, type ImpactHandle, type ImpactTarget } from "./impact.js";

export interface DiffImpactOptions extends DiffOptions { depth?: number; limit?: number; maxTargets?: number }
export interface DiffTarget extends ImpactTarget { reason: "changed-lines" | "file-fallback" }
export interface DiffGap { path: string; reason: string }
export interface DiffImpactHandle extends ImpactHandle { causedBy: number[] }

/** Analyze only current graph evidence. Deleted ranges are not historical graph queries. */
export function ctxDiff(db: Database.Database, repoRoot: string, opts: DiffImpactOptions = {}, requestScope?: GitScope | null) {
  const indexId = requireActiveIndex(db), scope = requestScope === undefined ? detectScope(repoRoot) : requestScope;
  if (!scope || computeIndexId(scope) !== indexId) throw new Error("Active index does not match the current worktree; refresh first");
  const diff = collectDiff(scope.worktreePath, opts);
  const maxTargets = bounded(opts.maxTargets, 20, 50), limit = bounded(opts.limit, 20, 100), depth = bounded(opts.depth, 2, 3);
  const gaps: DiffGap[] = [], targets: DiffTarget[] = [];
  const symbols = new Map<string, IndexedSymbol>();
  let targetCount = 0, truncated = diff.omittedFiles > 0;
  const gap = (path: string, reason: string) => { if (!gaps.some(g => g.path === path && g.reason === reason)) gaps.push({ path, reason }); };
  const addTarget = (target: DiffTarget, symbol?: IndexedSymbol) => {
    targetCount++;
    if (targets.length >= maxTargets) { truncated = true; return; }
    targets.push(target);
    if (symbol) symbols.set(symbol.id, symbol);
  };
  for (const file of diff.files) {
    if (file.status === "deleted" || file.oldPath || file.ranges.some(r => r.oldCount > 0)) gap(file.oldPath ?? file.path, "historical-impact-unavailable");
    if (file.issue) { gap(file.path, file.issue); truncated = true; }
    if (file.status === "deleted") continue;
    if (file.status === "conflict") { gap(file.path, "unmerged-file"); continue; }
    const indexed = db.prepare("SELECT content_hash, graph_version FROM files WHERE index_id = ? AND path = ? AND deleted = 0").get(indexId, file.path) as { content_hash: string; graph_version: number | null } | undefined;
    if (!indexed) { gap(file.path, "not-indexed"); continue; }
    const stale = isStalePath(indexId, file.path) || indexed.content_hash !== file.contentHash || indexed.graph_version !== GRAPH_VERSION;
    if (stale) gap(file.path, "stale-index");
    const ranges = file.ranges.filter(r => r.newCount > 0);
    let matched: IndexedSymbol[] = [];
    if (!stale && !file.issue && ranges.length) {
      const rows = db.prepare("SELECT id, path, name, scope, kind, signature, start_line, end_line FROM symbols WHERE index_id = ? AND path = ? ORDER BY start_line, end_line, name LIMIT 1001").all(indexId, file.path) as IndexedSymbol[];
      if (rows.length > 1000) { gap(file.path, "symbol-limit"); truncated = true; }
      matched = rows.slice(0, 1000).filter(s => ranges.some(r => s.start_line <= r.newStart + r.newCount - 1 && s.end_line >= r.newStart));
      for (const symbol of matched) addTarget({ path: file.path, symbolId: symbol.id, symbol: symbol.scope ? `${symbol.scope}.${symbol.name}` : symbol.name,
        kind: symbol.kind, lines: `${symbol.start_line}-${symbol.end_line}`, reason: "changed-lines" }, symbol);
    }
    // A hunk can include module-level code as well as a function. Full containment
    // is required before omitting file-level context for that hunk.
    const outsideSymbol = ranges.some(r => !matched.some(s => s.start_line <= r.newStart && s.end_line >= r.newStart + r.newCount - 1));
    if (!matched.length || outsideSymbol || file.ranges.some(r => r.newCount === 0)) {
      addTarget({ path: file.path, reason: "file-fallback", ...(stale ? { stale: true } : {}) });
      gap(file.path, "file-level-context");
    }
  }
  const groups = {
    callers: new Map<string, DiffImpactHandle>(), dependencies: new Map<string, DiffImpactHandle>(),
    affectedTests: new Map<string, DiffImpactHandle>(), documents: new Map<string, DiffImpactHandle>(),
    fileFallback: new Map<string, DiffImpactHandle>(),
  };
  const merge = (group: Map<string, DiffImpactHandle>, values: ImpactHandle[], target: number) => {
    for (const item of values) {
      const key = `${item.path}\0${item.symbolId ?? ""}\0${item.edgeType}`;
      const old = group.get(key), causedBy = [...new Set([...(old?.causedBy ?? []), target])];
      const better = !old || item.hops < old.hops || item.hops === old.hops && item.confidence > old.confidence;
      const selected = better ? item : old;
      const stale = old?.stale || item.stale || targets[target]!.stale;
      group.set(key, { ...selected, causedBy, ...(stale ? { stale: true } : {}),
        chain: targets[target]!.stale ? selected.chain?.map(step => ({ ...step, stale: true })) : selected.chain });
    }
  };
  targets.forEach((target, i) => {
    const result = impactForTarget(db, indexId, target.path, target.symbolId ? symbols.get(target.symbolId) : undefined, {
      depth, maxNodes: 200, maxEdges: 1000, maxTestPaths: 10, limit,
    });
    truncated ||= Boolean(result.truncated);
    if (result.truncated) gap(target.path, "impact-limit");
    merge(target.symbolId ? groups.callers : groups.fileFallback, result.callers, i);
    merge(groups.dependencies, result.callees, i);
    merge(groups.affectedTests, result.affectedTests, i);
    merge(groups.documents, result.documents ?? [], i);
    merge(groups.fileFallback, result.fileFallback?.callers ?? [], i);
  });
  const omitted: Record<string, number> = { files: diff.omittedFiles, targets: Math.max(0, targetCount - maxTargets) };
  const output = Object.fromEntries(Object.entries(groups).map(([name, values]) => {
    const rows = [...values.values()].sort((a, b) => a.hops - b.hops || b.confidence - a.confidence || a.path.localeCompare(b.path) || (a.symbolId ?? "").localeCompare(b.symbolId ?? "") || a.edgeType.localeCompare(b.edgeType));
    omitted[name] = Math.max(0, rows.length - limit); truncated ||= rows.length > limit;
    return [name, rows.slice(0, limit)];
  })) as Record<keyof typeof groups, DiffImpactHandle[]>;
  const endScope = detectScope(repoRoot);
  if (!endScope || computeIndexId(endScope) !== indexId) throw new Error("Worktree scope changed during comparison; retry after refresh");
  const freshness = freshnessFromPending(indexId);
  return { indexId, base: diff.base, baseSha: diff.baseSha, comparison: diff.comparison, depth,
    files: diff.files.map(file => ({ ...file, ranges: file.ranges.slice(0, 20), omittedRanges: Math.max(0, file.ranges.length - 20) })),
    targets, ...output, gaps, omitted, truncated: truncated || diff.files.some(file => file.ranges.length > 20),
    ...freshness, freshness: gaps.some(g => g.reason === "stale-index" || g.reason === "not-indexed" || g.reason === "changed-during-read") ? "partial" as const : freshness.freshness,
    note: "Base commit to current working tree, not staged-only. Static current-symbol impact is separate from fileFallback. Deleted ranges and old rename paths have no historical caller analysis. Missing edges do not prove safety. Reads are bounded, not an atomic filesystem snapshot. causedBy contains zero-based indexes into targets; omitted counts cover known candidates only." };
}
