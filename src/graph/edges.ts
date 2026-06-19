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

/** Safe `childForFieldName` accessor (the tree-sitter type doesn't declare it). */
function childField(node: Parser.SyntaxNode, field: string): Parser.SyntaxNode | null {
  return (node as unknown as { childForFieldName?: (f: string) => Parser.SyntaxNode | null }).childForFieldName?.(field) ?? null;
}

/** First string literal inside a call's argument list (for dynamic import()). */
function firstStringArg(call: Parser.SyntaxNode): string | null {
  const scan = childField(call, "arguments") ?? call;
  for (const c of iterAll(scan)) {
    if (c.type === "string" || c.type === "string_fragment") return stripQuotes(c.text);
  }
  return null;
}

/** Local binding names introduced by an import statement (TS/JS). */
function importBindingNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (const c of iterAll(node)) {
    if (c.type === "identifier") names.push(c.text);
  }
  return names;
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
  const jsts = lang === "typescript" || lang === "javascript";

  // local import name -> resolved target file (TS/JS, for calls/references)
  const bindings = new Map<string, string>();
  const resolveSpec = (spec: string | null): string | null =>
    spec ? (resolveImportFs(repoRoot, path, spec) ?? resolveImport(path, spec, knownFiles)) : null;

  // Pass 1: imports (static + dynamic). Unresolved imports emit a 0-confidence
  // edge that insertEdges filters out (no edge beats a wrong edge).
  for (const node of iterAll(root)) {
    if (node.type === "import_statement" || node.type === "import_declaration" || node.type === "import_from_statement") {
      const target = resolveSpec(importSpec(node));
      out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: target ? 0.9 : 0.0 });
      if (jsts && target) for (const name of importBindingNames(node)) bindings.set(name, target);
    } else if (node.type === "call_expression") {
      const fn = childField(node, "function");
      if (fn && (fn.type === "import" || fn.text === "import")) {
        // dynamic import("…")
        const target = resolveSpec(firstStringArg(node));
        out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: target ? 0.9 : 0.0 });
      }
    }
  }

  // Pass 2 (TS/JS only): calls + references resolved THROUGH import bindings, so
  // every emitted edge points at a known file. Deduped per (target, type) to
  // keep the graph compact.
  if (jsts && bindings.size > 0) {
    const callsSeen = new Set<string>();
    const refsSeen = new Set<string>();
    for (const node of iterAll(root)) {
      if (node.type === "call_expression") {
        const fn = childField(node, "function");
        if (!fn) continue;
        let callee: string | null = null;
        if (fn.type === "identifier") callee = fn.text;
        else if (fn.type === "member_expression") {
          const obj = childField(fn, "object");
          if (obj && obj.type === "identifier") callee = obj.text; // ns.foo()
        }
        if (callee && bindings.has(callee) && !callsSeen.has(callee)) {
          callsSeen.add(callee);
          out.push({ fromPath: path, toPath: bindings.get(callee)!, fromSymbol: null, toSymbol: callee, type: "calls", confidence: 0.7 });
        }
      } else if (node.type === "member_expression") {
        const obj = childField(node, "object");
        if (obj && obj.type === "identifier" && bindings.has(obj.text) && !refsSeen.has(obj.text)) {
          refsSeen.add(obj.text);
          out.push({ fromPath: path, toPath: bindings.get(obj.text)!, fromSymbol: null, toSymbol: obj.text, type: "references", confidence: 0.6 });
        }
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