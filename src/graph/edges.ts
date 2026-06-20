import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type Parser from "tree-sitter";
import { makeParser } from "./grammars.js";
import { resolveImportFs, resolveImport, resolveGodotPath } from "./resolve.js";

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
  type: string;              // imports|defines|belongs_to|exports|calls|references
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
  const gd = lang === "gdscript";

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

  // GDScript-specific edge extraction
  if (gd) {
    extractGDScriptEdges(root, path, repoRoot, knownFiles, out);
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

/**
 * GDScript-specific edge extraction.
 *
 * Handles:
 * - `extends "res://..."` or `extends ClassName` → imports edge
 * - `preload("res://...")` / `load("res://...")` → imports edge
 * - `call` nodes → calls edge for local function definitions
 * - `attribute_call` on known local vars → calls edge
 */
function extractGDScriptEdges(root: Parser.SyntaxNode, path: string, repoRoot: string, knownFiles: Set<string>, out: ExtractedEdge[]): void {
  const gdResolve = (spec: string | null): string | null =>
    spec ? (resolveGodotPath(spec, repoRoot, knownFiles) ?? resolveImport(path, spec, knownFiles)) : null;

  // Collect locally-defined function names for call resolution
  const localFuncs = new Set<string>();
  for (const node of iterAll(root)) {
    if (node.type === "function_definition") {
      const nameNode = childField(node, "name");
      if (nameNode) localFuncs.add(nameNode.text);
    }
  }

  // Collect local variable bindings (var/const name → preload target)
  const varBindings = new Map<string, string>();

  const callsSeen = new Set<string>();
  const importsSeen = new Set<string>();

  // Pass 1: collect preload/load var bindings (must happen before call analysis)
  for (const node of iterAll(root)) {
    if (node.type === "call") {
      const fnNode = node.children[0];
      if (fnNode && fnNode.type === "identifier" && (fnNode.text === "preload" || fnNode.text === "load")) {
        const arg = firstStringArg(node);
        if (arg) {
          const target = gdResolve(arg);
          if (target) {
            const parent = findParent(root, node);
            if (parent && (parent.type === "const_statement" || parent.type === "variable_statement")) {
              const nameNode = childField(parent, "name");
              if (nameNode) varBindings.set(nameNode.text, target);
            }
          }
        }
      }
    }
  }

  // Pass 2: emit edges
  for (const node of iterAll(root)) {
    // extends "res://..." or extends ClassName
    if (node.type === "extends_statement") {
      // Case 1: extends "res://..." → child is a string
      const stringChild = node.children.find((c) => c.type === "string");
      if (stringChild) {
        const extText = stripQuotes(stringChild.text);
        const target = gdResolve(extText);
        if (target && !importsSeen.has(target)) {
          importsSeen.add(target);
          out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 });
        }
      } else {
        // Case 2: extends ClassName → child is type → identifier
        const typeNode = childField(node, "type");
        if (typeNode) {
          const extText = stripQuotes(typeNode.text);
          const target = gdResolve(extText);
          if (target && !importsSeen.has(target)) {
            importsSeen.add(target);
            out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 });
          }
        }
      }
    }

    // preload("res://...") and load("res://...") → imports edge
    if (node.type === "call") {
      const fnNode = node.children[0];
      if (fnNode && fnNode.type === "identifier" && (fnNode.text === "preload" || fnNode.text === "load")) {
        const arg = firstStringArg(node);
        if (arg) {
          const target = gdResolve(arg);
          if (target && !importsSeen.has(target)) {
            importsSeen.add(target);
            out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 });
          }
        }
      }
    }

    // Direct function calls: `func_name(...)` → calls edge if func is locally defined
    if (node.type === "call") {
      const fnNode = node.children[0];
      if (fnNode && fnNode.type === "identifier") {
        const callee = fnNode.text;
        // Skip preload/load — handled above
        if (callee === "preload" || callee === "load") continue;
        if (localFuncs.has(callee) && !callsSeen.has(callee)) {
          callsSeen.add(callee);
          out.push({ fromPath: path, toPath: path, fromSymbol: null, toSymbol: callee, type: "calls", confidence: 0.8 });
        }
      }
    }

    // Method calls on known preload'd vars: `weapon.attack()`
    if (node.type === "attribute_call") {
      const parent = findParent(root, node);
      if (parent && parent.type === "attribute") {
        const objNode = parent.children[0];
        if (objNode && objNode.type === "identifier" && varBindings.has(objNode.text)) {
          const targetPath = varBindings.get(objNode.text)!;
          const methodName = node.children[0]; // identifier child of attribute_call
          if (methodName && methodName.type === "identifier" && !callsSeen.has(`${objNode.text}.${methodName.text}`)) {
            callsSeen.add(`${objNode.text}.${methodName.text}`);
            out.push({ fromPath: path, toPath: targetPath, fromSymbol: null, toSymbol: methodName.text, type: "calls", confidence: 0.6 });
          }
        }
      }
    }
  }
}

/** Find the parent of a node by walking the tree. Returns null if not found. */
function findParent(root: Parser.SyntaxNode, target: Parser.SyntaxNode): Parser.SyntaxNode | null {
  function search(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    for (const child of node.children) {
      if (child === target) return node;
      const found = search(child);
      if (found) return found;
    }
    return null;
  }
  return search(root);
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
