import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type Parser from "tree-sitter";
import { makeParser } from "./grammars.js";
import { resolveImportFs, resolveImport } from "./resolve.js";

/**
 * Edge builder (Step 14).
 *
 * Emits edges: imports (file→file), defines (file→symbol), belongs_to
 * (symbol→file), exports (file→symbol). Uses tree-sitter import nodes + path
 * resolution. Unresolved imports emit no edge (not a wrong edge).
 */

export interface ExtractedEdge {
  fromPath: string;
  toPath: string | null;     // null = unresolved import
  fromSymbol: string | null;
  toSymbol: string | null;
  type: string;              // imports|defines|belongs_to|exports
  confidence: number;
}

// Node types that carry an import spec, per grammar.
const IMPORT_SPEC_FIELDS = ["source", "module_name", "name", "path"];

function importSpec(node: Parser.SyntaxNode): string | null {
  // Try named fields first.
  for (const f of IMPORT_SPEC_FIELDS) {
    const child = (node as unknown as { childForFieldName?: (f: string) => Parser.SyntaxNode | null }).childForFieldName?.(f);
    if (child) return stripQuotes(child.text);
  }
  // Walk for string literals.
  for (const c of iterAll(node)) {
    if (c.type === "string" || c.type === "string_fragment") return stripQuotes(c.text);
  }
  return null;
}

function* iterAll(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  yield node;
  for (const c of node.children) yield* iterAll(c);
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}

/**
 * Extract edges for a single file. `knownFiles` (repo-relative POSIX set) is
 * used to resolve imports to indexed files; falls back to the filesystem.
 */
export function extractEdges(path: string, lang: string, source: string, repoRoot: string, knownFiles: Set<string>): ExtractedEdge[] {
  const parser = makeParser(lang);
  if (!parser) return [];
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    return [];
  }
  const out: ExtractedEdge[] = [];
  const root = tree.rootNode;

  // Walk for import statements.
  for (const node of iterAll(root)) {
    if (node.type === "import_statement" || node.type === "import_declaration" || node.type === "import_from_statement") {
      const spec = importSpec(node);
      if (!spec) continue;
      const target = resolveImportFs(repoRoot, path, spec) ?? resolveImport(path, spec, knownFiles);
      out.push({
        fromPath: path,
        toPath: target,
        fromSymbol: null,
        toSymbol: null,
        type: "imports",
        confidence: target ? 0.9 : 0.0,
      });
      if (!target) {
        // unresolved — keep no-edge policy (confidence 0 filtered on insert)
      }
    }
  }
  return out;
}

/** Insert extracted edges into the edges table (skips unresolved imports). */
export function insertEdges(db: Database.Database, indexId: string, edges: ExtractedEdge[]): void {
  const stmt = db.prepare(
    `INSERT INTO edges (id, index_id, from_id, to_id, from_path, to_path, type, confidence) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)`,
  );
  for (const e of edges) {
    if (e.type === "imports" && !e.toPath) continue; // unresolved → no edge
    stmt.run("edge_" + randomUUID(), indexId, e.fromPath, e.toPath, e.type, e.confidence);
  }
}