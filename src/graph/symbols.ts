import type Parser from "tree-sitter";
import { parseFile } from "./grammars.js";

/**
 * Symbol extractor (Step 13).
 *
 * Walks a tree-sitter AST to find function/class/method/type/constant/import/
 * export declarations with line ranges + signatures. Node types vary per
 * grammar; SYMBOL_TYPES maps the common ones. Unsupported languages return [].
 */

export interface ExtractedSymbol {
  name: string;
  kind: string;        // function|class|method|type|interface|constant|import|export
  startLine: number;   // 1-indexed
  endLine: number;
  signature?: string;
  exported: boolean;
  doc?: string;
}

// Node types → symbol kind. Covers TS/JS/Python/Go/Rust/Java/Ruby/PHP/C/C++.
const SYMBOL_TYPES: Record<string, string> = {
  function_declaration: "function",
  function_definition: "function",
  method_definition: "method",
  method_declaration: "method",
  function_signature: "function",
  class_declaration: "class",
  class_definition: "class",
  interface_declaration: "interface",
  interface_statement: "interface",
  type_alias_declaration: "type",
  type_definition: "type",
  enum_declaration: "type",
  enum_statement: "type",
  lexical_declaration: "constant",
  variable_declaration: "constant",
  import_statement: "import",
  import_declaration: "import",
  import_from_statement: "import",
  export_statement: "export",
  export_declaration: "export",
};

// Node types that indicate an export (TS/JS).
const EXPORT_WRAPPERS = new Set(["export_statement", "export_declaration"]);

export function extractSymbols(path: string, lang: string, source: string, parsedTree?: Parser.Tree | null): ExtractedSymbol[] {
  const tree = parsedTree ?? parseFile(lang, source);
  if (!tree) return [];
  const out: ExtractedSymbol[] = [];
  const root = tree.rootNode;

  function nodeName(node: Parser.SyntaxNode): string | null {
    const nameNode = (node as unknown as { childForFieldName?: (f: string) => Parser.SyntaxNode | null }).childForFieldName?.("name");
    if (nameNode) return nameNode.text;
    for (const c of node.namedChildren) {
      if (c.type === "identifier" || c.type === "property_identifier") return c.text;
    }
    return null;
  }

  function isExported(node: Parser.SyntaxNode): boolean {
    if (EXPORT_WRAPPERS.has(node.type)) return true;
    if (node.parent && EXPORT_WRAPPERS.has(node.parent.type)) return true;
    const text = node.text;
    const name = nodeName(node) ?? "";
    const head = text.slice(0, text.indexOf(name));
    return /\bexport\b/.test(head);
  }

  function walk(node: Parser.SyntaxNode) {
    const kind = SYMBOL_TYPES[node.type];
    if (kind && kind !== "import" && kind !== "export") {
      const name = nodeName(node);
      if (name) {
        out.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: firstLine(node.text),
          exported: isExported(node),
        });
      }
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(root);
  return out;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}