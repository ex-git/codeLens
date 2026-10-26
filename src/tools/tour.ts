import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, isStalePath } from "../index/staleness.js";
import { analyzeOverview } from "../graph/overview.js";
import { isCodeLanguage } from "../graph/grammars.js";
import { bounded, documentsFor, STRUCTURAL_TYPES, walkGraph, type GraphStep } from "../graph/query.js";
import { isTestPath } from "./impact.js";

export interface TourOptions { start?: string; limit?: number }
export interface TourReason {
  kind: "selected-start" | "community-root" | "dependency" | "test" | "documentation";
  text: string; anchor?: string;
}
interface Candidate { path: string; kind: "code" | "test" | "document"; reason: TourReason; chain: GraphStep[]; stale?: boolean; confidence?: number }
export interface TourStop extends Candidate {
  source: { path: string; startLine: number; endLine: number };
  symbols: Array<{ name: string; lines: string }>;
  omittedSymbols: boolean;
}

/** A reading order, not an execution trace or an inferred architectural model. */
export function ctxTour(db: Database.Database, opts: TourOptions = {}) {
  const indexId = requireActiveIndex(db), limit = bounded(opts.limit, 8, 20);
  let truncated = false;
  const files = new Map<string, { language: string | null } | undefined>();
  const file = (path: string) => {
    if (!files.has(path)) files.set(path, db.prepare("SELECT language FROM files WHERE index_id = ? AND path = ? AND deleted = 0").get(indexId, path) as { language: string | null } | undefined);
    return files.get(path);
  };
  const finish = (status: "ready" | "empty" | "unresolved-start", stops: TourStop[], omittedStops = 0) => ({
    indexId, status, stops, omittedStops, truncated: truncated || omittedStops > 0,
    ...freshnessFromPending(indexId),
    note: "Deterministic file-level reading order from bounded static evidence, not a runtime trace or authoritative architecture. Roots start separate sections; dependency chains are anchored to reason.anchor, not necessarily the preceding stop. Tests and documents provide reading context, not proof of coverage. Source locations come from the index. Omitted counts cover discovered candidates only; source text is available through cl_expand.",
  });
  const roots: Candidate[] = [];
  if (opts.start !== undefined) {
    const path = opts.start.replace(/^\.\//, "");
    const row = file(path);
    if (!row || !isCodeLanguage(row.language)) return finish("unresolved-start", []);
    roots.push({ path, kind: isTestPath(path) ? "test" : "code", reason: { kind: "selected-start", text: "User-selected indexed starting file." }, chain: [] });
  } else {
    const overview = analyzeOverview(db, indexId, { limit: 20 });
    truncated ||= overview.truncated;
    const degrees = new Map(overview.hubs.map(h => [h.path, h]));
    for (const group of overview.communities) {
      const members = group.members.filter(m => !isTestPath(m.path));
      const ranked = (members.length ? members : group.members).slice().sort((a, b) => {
        const left = degrees.get(a.path), right = degrees.get(b.path);
        return (left?.inDegree ?? Infinity) - (right?.inDegree ?? Infinity) || (right?.outDegree ?? 0) - (left?.outDegree ?? 0) || a.path.localeCompare(b.path);
      });
      if (ranked[0]) roots.push({ path: ranked[0].path, kind: isTestPath(ranked[0].path) ? "test" : "code",
        reason: { kind: "community-root", text: `Representative of a sampled ${group.size}-file navigation community; starts a separate reading section.` }, chain: [] });
    }
  }
  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate) => {
    if (candidates.has(candidate.path)) return;
    if (candidates.size >= 200) { truncated = true; return; }
    if (!file(candidate.path)) return;
    candidates.set(candidate.path, { ...candidate, ...(candidate.stale || isStalePath(indexId, candidate.path) ? { stale: true } : {}) });
  };
  for (const root of roots) {
    if (candidates.has(root.path)) continue;
    add(root);
    const walk = walkGraph(db, indexId, root.path, { types: STRUCTURAL_TYPES, direction: "out", depth: 3, maxNodes: 200, maxEdges: 1000 });
    truncated ||= walk.truncated;
    for (const next of walk.results) {
      if (isTestPath(next.path) || !isCodeLanguage(file(next.path)?.language ?? null)) continue;
      add({ path: next.path, kind: "code", reason: { kind: "dependency", text: `Static dependency reached in ${next.hops} hop(s).`, anchor: root.path },
        chain: next.chain ?? [], stale: next.stale, confidence: next.confidence });
    }
  }
  const core = [...candidates.values()];
  const coreLimit = limit >= 4 ? limit - 2 : limit;
  const selected = core.slice(0, coreLimit);
  const contextual: Candidate[] = [];
  for (const anchor of selected) {
    const docs = documentsFor(db, indexId, anchor.path, undefined, 20);
    const tests = walkGraph(db, indexId, anchor.path, { types: ["tests"], direction: "in", depth: 1, maxNodes: 20, maxEdges: 100 });
    truncated ||= docs.truncated || tests.truncated;
    for (const [kind, neighbors] of [["document", docs.results], ["test", tests.results]] as const) {
      for (const next of neighbors) {
        const candidate: Candidate = { path: next.path, kind, reason: { kind: kind === "document" ? "documentation" : "test",
          text: kind === "document" ? "Explicit documentation link to an earlier reading stop." : "Indexed test relationship to an earlier reading stop.", anchor: anchor.path },
          chain: next.chain ?? [], confidence: next.confidence, stale: next.stale || anchor.stale };
        if (!candidates.has(candidate.path)) { add(candidate); if (candidates.has(candidate.path)) contextual.push(candidate); }
      }
    }
  }
  // Prefer one document and one test before filling spare slots with other code.
  const firstDoc = contextual.find(c => c.kind === "document"), firstTest = contextual.find(c => c.kind === "test");
  const ordered = [...selected, ...[firstDoc, firstTest].filter((c): c is Candidate => Boolean(c)), ...core.slice(coreLimit), ...contextual];
  const unique = [...new Map(ordered.map(c => [c.path, candidates.get(c.path)!])).values()];
  const stops: TourStop[] = unique.slice(0, limit).map(candidate => {
    const symbols = db.prepare("SELECT name, scope, start_line, end_line FROM symbols WHERE index_id = ? AND path = ? ORDER BY exported DESC, start_line, end_line, name LIMIT 4").all(indexId, candidate.path) as Array<{ name: string; scope: string; start_line: number; end_line: number }>;
    const location = symbols[0] ?? db.prepare("SELECT start_line, end_line FROM chunks WHERE index_id = ? AND path = ? ORDER BY start_line LIMIT 1").get(indexId, candidate.path) as { start_line: number; end_line: number } | undefined;
    return { ...candidate, source: { path: candidate.path, startLine: location?.start_line ?? 1, endLine: location?.end_line ?? 1 },
      symbols: symbols.slice(0, 3).map(s => ({ name: s.scope ? `${s.scope}.${s.name}` : s.name, lines: `${s.start_line}-${s.end_line}` })), omittedSymbols: symbols.length > 3 };
  });
  return finish(stops.length ? "ready" : "empty", stops, Math.max(0, candidates.size - stops.length));
}
