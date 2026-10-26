import type Database from "better-sqlite3";
import { isCodeLanguage } from "./grammars.js";
import { bounded, edgeEvidence, STRUCTURAL_TYPES, type EdgeRow } from "./query.js";
import { isStalePath } from "../index/staleness.js";

export interface OverviewOptions { maxNodes?: number; maxEdges?: number; limit?: number }

/** Iterative Kosaraju avoids call-stack limits on long dependency chains. */
function components(nodes: string[], outgoing: Map<string, Set<string>>, incoming: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>(), order: string[] = [];
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const stack: Array<[string, Iterator<string>]> = [[node, outgoing.get(node)!.values()]];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = top[1].next();
      if (next.done) { order.push(top[0]); stack.pop(); }
      else if (!seen.has(next.value)) { seen.add(next.value); stack.push([next.value, outgoing.get(next.value)!.values()]); }
    }
  }
  seen.clear();
  const result: string[][] = [];
  for (const node of order.reverse()) {
    if (seen.has(node)) continue;
    const group: string[] = [], stack = [node]; seen.add(node);
    while (stack.length) {
      const current = stack.pop()!; group.push(current);
      for (const next of incoming.get(current)!) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    result.push(group.sort());
  }
  return result;
}

export function analyzeOverview(db: Database.Database, indexId: string, opts: OverviewOptions = {}) {
  const maxNodes = bounded(opts.maxNodes, 1000, 5000), maxEdges = bounded(opts.maxEdges, 5000, 20000);
  const limit = bounded(opts.limit, 10, 50);
  const files = db.prepare("SELECT path, language FROM files WHERE index_id = ? AND deleted = 0 ORDER BY path LIMIT ?")
    .all(indexId, maxNodes + 1) as Array<{ path: string; language: string | null }>;
  const paths = files.slice(0, maxNodes).filter(f => isCodeLanguage(f.language)).map(f => f.path);
  const selected = new Set(paths);
  const rows = db.prepare(`SELECT * FROM edges WHERE index_id = ? AND type IN (${STRUCTURAL_TYPES.map(() => "?").join(",")})
    AND from_path != to_path ORDER BY from_path, to_path, type, source_start_line LIMIT ?`)
    .all(indexId, ...STRUCTURAL_TYPES, maxEdges + 1) as EdgeRow[];
  const unique = new Map<string, EdgeRow>();
  for (const row of rows.slice(0, maxEdges)) {
    if (!selected.has(row.from_path) || !selected.has(row.to_path)) continue;
    const key = `${row.from_path}\0${row.to_path}`;
    const old = unique.get(key);
    if (!old || row.confidence > old.confidence) unique.set(key, row);
  }
  const edges = [...unique.values()];
  const outgoing = new Map(paths.map(p => [p, new Set<string>()]));
  const incoming = new Map(paths.map(p => [p, new Set<string>()]));
  const adjacent = new Map(paths.map(p => [p, new Set<string>()]));
  for (const row of edges) {
    outgoing.get(row.from_path)!.add(row.to_path); incoming.get(row.to_path)!.add(row.from_path);
    adjacent.get(row.from_path)!.add(row.to_path); adjacent.get(row.to_path)!.add(row.from_path);
  }
  const labels = new Map(paths.map(p => [p, p]));
  // Resolve local neighborhoods before bridge hubs. In-place updates avoid
  // synchronous label swapping on pairs and other bipartite graphs.
  const labelOrder = [...paths].sort((a, b) => adjacent.get(a)!.size - adjacent.get(b)!.size || a.localeCompare(b));
  let converged = false;
  for (let iteration = 0; iteration < 20; iteration++) {
    let changed = false;
    for (const path of labelOrder) {
      const votes = new Map<string, number>();
      for (const next of adjacent.get(path)!) { const label = labels.get(next)!; votes.set(label, (votes.get(label) ?? 0) + 1); }
      if (!votes.size) continue;
      const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const current = labels.get(path)!;
      const winner = votes.get(current) === ranked[0]![1] ? current : ranked[0]![0];
      if (winner !== current) { labels.set(path, winner); changed = true; }
    }
    if (!changed) { converged = true; break; }
  }
  const grouped = new Map<string, string[]>();
  for (const path of paths) { const label = labels.get(path)!; const members = grouped.get(label) ?? []; members.push(path); grouped.set(label, members); }
  const stamp = (path: string) => ({ path, ...(isStalePath(indexId, path) ? { stale: true } : {}) });
  const communities = [...grouped.values()].map(members => {
    const memberSet = new Set(members);
    let internal = 0, external = 0;
    for (const path of members) for (const next of adjacent.get(path)!) { if (memberSet.has(next)) internal++; else external++; }
    return { id: members[0]!, size: members.length, members: members.slice(0, 10).map(stamp), omittedMembers: Math.max(0, members.length - 10),
      cohesion: internal + external ? internal / (internal + external) : 0 };
  }).sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  const hubs = paths.map(path => ({ ...stamp(path), inDegree: incoming.get(path)!.size, outDegree: outgoing.get(path)!.size }))
    .sort((a, b) => b.inDegree - a.inDegree || b.outDegree - a.outDegree || a.path.localeCompare(b.path));
  const bridges = edges.filter(e => labels.get(e.from_path) !== labels.get(e.to_path)).map(e => edgeEvidence(indexId, e));
  const cycles = components(paths, outgoing, incoming).filter(c => c.length > 1).sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
    .map(members => ({ size: members.length, members: members.slice(0, 20).map(stamp), omittedMembers: Math.max(0, members.length - 20) }));
  const omitted = { communities: Math.max(0, communities.length - limit), hubs: Math.max(0, hubs.length - limit), bridges: Math.max(0, bridges.length - limit), cycles: Math.max(0, cycles.length - limit) };
  const inputTruncated = files.length > maxNodes || rows.length > maxEdges;
  return { counts: { scannedFiles: Math.min(files.length, maxNodes), nodes: paths.length, edges: edges.length, communities: communities.length, cycles: cycles.length },
    communities: communities.slice(0, limit), hubs: hubs.slice(0, limit), bridges: bridges.slice(0, limit), cycles: cycles.slice(0, limit),
    omitted, inputTruncated, communitiesConverged: converged,
    truncated: inputTruncated || Object.values(omitted).some(n => n > 0) || communities.some(c => c.omittedMembers) || cycles.some(c => c.omittedMembers),
    note: "Heuristic groups from bounded static dependencies, not authoritative architecture. Bridges are cross-group edges, not graph-theoretic cut edges. Cycles are strongly connected components, not enumerated execution paths. Documents and unsupported code grammars are excluded. Missing cycles are not proof of acyclicity when input is truncated." };
}
