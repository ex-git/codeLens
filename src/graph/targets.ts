import type Database from "better-sqlite3";

export interface GraphTarget { path: string; symbolId?: string; symbol?: string; lines?: string }

export interface IndexedSymbol {
  id: string;
  path: string;
  name: string;
  scope: string;
  kind: string;
  signature: string | null;
  start_line: number;
  end_line: number;
}

/** Exact bare or qualified names. Callers choose their existing candidate cap. */
export function resolveExactSymbols(db: Database.Database, indexId: string, symbol: string, path?: string, limit = 21): IndexedSymbol[] {
  return db.prepare(`SELECT id, path, name, scope, kind, signature, start_line, end_line FROM symbols
    WHERE index_id = ? AND (name = ? OR CASE WHEN scope = '' THEN name ELSE scope || '.' || name END = ?)
    ${path === undefined ? "" : "AND path = ?"} ORDER BY path, start_line, name LIMIT ?`).all(
    indexId, symbol, symbol, ...(path === undefined ? [] : [path]), limit,
  ) as IndexedSymbol[];
}

/** Exact indexed paths or unambiguous names. A path#Scope.name selects a symbol. */
export function resolveGraphTarget(db: Database.Database, indexId: string, input: string): GraphTarget[] {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "");
  const hash = normalized.indexOf("#");
  const path = hash >= 0 ? normalized.slice(0, hash) : undefined;
  const symbol = hash >= 0 ? normalized.slice(hash + 1) : normalized;
  if (hash < 0 && db.prepare("SELECT 1 FROM files WHERE index_id = ? AND path = ? AND deleted = 0").get(indexId, normalized)) return [{ path: normalized }];
  if (!symbol || path === "") return [];
  const rows = resolveExactSymbols(db, indexId, symbol, path);
  return rows.map(r => ({ path: r.path, symbolId: r.id, symbol: r.scope ? `${r.scope}.${r.name}` : r.name, lines: `${r.start_line}-${r.end_line}` }));
}
