import type Database from "better-sqlite3";
import type Parser from "tree-sitter";
import { parseFile } from "./grammars.js";
import { resolveImportFs, resolveImport, resolvePythonImport, resolvePythonImportFs } from "./resolve.js";
import { id } from "../util/id.js";

/**
 * Edge builder (Step 14).
 *
 * Emits file-level imports, calls, references, and inheritance edges from
 * tree-sitter nodes. Defines/belongs_to/exports are added by the indexer.
 * Unresolved imports emit no persisted edge (not a wrong edge).
 */

export interface ExtractedEdge {
  fromPath: string;
  toPath: string | null;     // null = unresolved import
  fromSymbol: string | null;
  toSymbol: string | null;
  type: string;              // imports|calls|references|inherits|defines|belongs_to|exports
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

interface PythonBinding {
  local: string;
  target: string;
  imported: string;
  accessPath: string[];
  declaredAt: number;
  scopeKey: string;
}

interface PythonShadow {
  local: string;
  declaredAt: number;
  scopeKey: string;
}

interface PythonImportGroup {
  spec: string;
  bindings: Array<{ local: string; imported: string; accessPath: string[] }>;
}

/** Direct children attached to a repeated tree-sitter field. */
function fieldChildren(node: Parser.SyntaxNode, field: string): Parser.SyntaxNode[] {
  const fieldNameForChild = (node as unknown as { fieldNameForChild?: (i: number) => string | null }).fieldNameForChild;
  if (!fieldNameForChild) return [];
  return node.children.filter((_child, i) => fieldNameForChild.call(node, i) === field);
}

function pythonImportName(node: Parser.SyntaxNode): { source: string; alias: string | null } {
  if (node.type !== "aliased_import") return { source: node.text, alias: null };
  return {
    source: childField(node, "name")?.text ?? node.text,
    alias: childField(node, "alias")?.text ?? null,
  };
}

/** Python import modules and the local names each statement introduces. */
function pythonImportGroups(node: Parser.SyntaxNode): PythonImportGroup[] {
  const names = fieldChildren(node, "name");
  if (node.type === "import_statement") {
    return names.map((nameNode) => {
      const { source, alias } = pythonImportName(nameNode);
      const sourceParts = source.split(".");
      const local = alias ?? sourceParts[0]!;
      return {
        spec: source,
        bindings: [{ local, imported: sourceParts.at(-1)!, accessPath: alias ? [alias] : sourceParts }],
      };
    });
  }

  const spec = childField(node, "module_name")?.text;
  if (!spec) return [];
  const bindings = names
    .filter((nameNode) => nameNode.type !== "wildcard_import")
    .map((nameNode) => {
      const { source, alias } = pythonImportName(nameNode);
      const imported = source.split(".").at(-1)!;
      const local = alias ?? imported;
      return { local, imported, accessPath: [local] };
    });
  return [{ spec, bindings }];
}

function pythonReferenceParts(node: Parser.SyntaxNode | null): string[] | null {
  if (!node) return null;
  if (node.type === "identifier") return [node.text];
  if (node.type === "attribute") {
    const objectParts = pythonReferenceParts(childField(node, "object"));
    const attribute = childField(node, "attribute")?.text;
    return objectParts && attribute ? [...objectParts, attribute] : null;
  }
  if (node.type === "subscript") return pythonReferenceParts(childField(node, "value"));
  return null;
}

const PYTHON_SCOPE_TYPES = new Set([
  "module",
  "function_definition",
  "lambda",
  "class_definition",
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

function pythonScope(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (PYTHON_SCOPE_TYPES.has(current.type)) return current;
  }
  return null;
}

function pythonScopeKey(node: Parser.SyntaxNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function pythonBoundNames(node: Parser.SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type === "attribute" || node.type === "subscript") return [];
  if (!node.type.includes("pattern") && node.type !== "list" && node.type !== "tuple") return [];
  return node.namedChildren.flatMap((child) => pythonBoundNames(child));
}

function pythonParameterNames(node: Parser.SyntaxNode): string[] {
  const parameters = childField(node, "parameters");
  if (!parameters) return [];
  return parameters.namedChildren.flatMap((parameter) => {
    if (parameter.type === "identifier") return [parameter.text];
    const name = childField(parameter, "name");
    if (name?.type === "identifier") return [name.text];
    const identifier = parameter.namedChildren.find((child) => child.type === "identifier");
    return identifier ? [identifier.text] : [];
  });
}

function pythonBindingFor(
  node: Parser.SyntaxNode | null,
  bindings: PythonBinding[],
  shadows: PythonShadow[],
  moduleScopeKey: string,
  scopeOverride?: Parser.SyntaxNode | null,
): PythonBinding | null {
  const parts = pythonReferenceParts(node);
  const scope = scopeOverride ?? pythonScope(node);
  if (!parts || !scope) return null;
  const local = parts[0]!;
  const scopeKey = pythonScopeKey(scope);
  const accessMatches = (binding: PythonBinding): boolean =>
    binding.local === local && binding.accessPath.every((part, i) => parts[i] === part);
  const select = (key: string, before: number): PythonBinding | null => {
    const lastShadow = shadows
      .filter((shadow) => shadow.scopeKey === key && shadow.local === local && shadow.declaredAt < before)
      .reduce((latest, shadow) => Math.max(latest, shadow.declaredAt), -1);
    return bindings
      .filter((binding) => binding.scopeKey === key && binding.declaredAt < before && binding.declaredAt > lastShadow && accessMatches(binding))
      .sort((a, b) => b.accessPath.length - a.accessPath.length || b.declaredAt - a.declaredAt)[0] ?? null;
  };

  const localBinding = select(scopeKey, node?.startIndex ?? scope.endIndex);
  if (localBinding || scopeKey === moduleScopeKey) return localBinding;

  const scopeClaimsName = bindings.some((binding) => binding.scopeKey === scopeKey && binding.local === local)
    || shadows.some((shadow) => shadow.scopeKey === scopeKey && shadow.local === local);
  if (scopeClaimsName) return null;

  // A nested scope can safely use a module import only when the relevant
  // module binding is established before the scope and not changed later.
  const scopeStart = scope.startIndex;
  const changedLater = bindings.some((binding) => binding.scopeKey === moduleScopeKey && binding.declaredAt >= scopeStart && accessMatches(binding))
    || shadows.some((shadow) => shadow.scopeKey === moduleScopeKey && shadow.local === local && shadow.declaredAt >= scopeStart);
  return changedLater ? null : select(moduleScopeKey, scopeStart);
}

function referencedSymbol(node: Parser.SyntaxNode, binding: PythonBinding): string {
  const parts = pythonReferenceParts(node);
  return parts && parts.length > binding.accessPath.length ? parts.at(-1)! : binding.imported;
}

/**
 * Extract edges for a single file. `knownFiles` (repo-relative POSIX set) is
 * used to resolve imports to indexed files; falls back to the filesystem.
 */
export function extractEdges(path: string, lang: string, source: string, repoRoot: string, knownFiles: Set<string>, parsedTree?: Parser.Tree | null): ExtractedEdge[] {
  const tree = parsedTree ?? parseFile(lang, source);
  if (!tree) return [];
  const out: ExtractedEdge[] = [];
  const root = tree.rootNode;
  const jsts = lang === "typescript" || lang === "javascript";
  const python = lang === "python";

  const bindings = new Map<string, string>();
  const pythonBindings: PythonBinding[] = [];
  const pythonShadows: PythonShadow[] = [];
  const moduleScopeKey = pythonScopeKey(root);
  const resolveSpec = (spec: string | null): string | null =>
    spec ? (resolveImportFs(repoRoot, path, spec) ?? resolveImport(path, spec, knownFiles)) : null;
  const resolvePythonSpec = (spec: string): string | null =>
    resolvePythonImportFs(repoRoot, path, spec) ?? resolvePythonImport(path, spec, knownFiles);

  // Pass 1: imports (static + dynamic). Unresolved imports emit a 0-confidence
  // edge that insertEdges filters out (no edge beats a wrong edge).
  for (const node of iterAll(root)) {
    if (python) {
      if (node.type === "function_definition" || node.type === "lambda") {
        const ownScopeKey = pythonScopeKey(node);
        for (const local of pythonParameterNames(node)) {
          pythonShadows.push({ local, declaredAt: node.startIndex, scopeKey: ownScopeKey });
        }
      }
      if (node.type === "function_definition" || node.type === "class_definition") {
        const enclosingScope = pythonScope(node.parent);
        const local = childField(node, "name")?.text;
        if (enclosingScope && local) {
          pythonShadows.push({ local, declaredAt: node.startIndex, scopeKey: pythonScopeKey(enclosingScope) });
        }
      } else if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression" || node.type === "for_statement" || node.type === "for_in_clause") {
        const scope = pythonScope(node);
        if (scope) {
          for (const local of pythonBoundNames(childField(node, "left"))) {
            pythonShadows.push({ local, declaredAt: node.startIndex, scopeKey: pythonScopeKey(scope) });
          }
        }
      } else if (node.type === "with_item" || node.type === "except_clause") {
        const scope = pythonScope(node);
        const asPattern = childField(node, "value");
        const alias = asPattern?.type === "as_pattern" ? childField(asPattern, "alias") : null;
        if (scope) {
          for (const local of pythonBoundNames(alias)) {
            pythonShadows.push({ local, declaredAt: node.startIndex, scopeKey: pythonScopeKey(scope) });
          }
        }
      }
    }

    if (python && (node.type === "import_statement" || node.type === "import_from_statement")) {
      for (const group of pythonImportGroups(node)) {
        const moduleTarget = resolvePythonSpec(group.spec);
        const moduleIsPackage = moduleTarget?.endsWith("/__init__.py") || moduleTarget === "__init__.py";
        const scope = pythonScope(node);
        const targets = new Set<string>();
        for (const binding of group.bindings) {
          const importedSpec = /^\.+$/.test(group.spec)
            ? group.spec + binding.imported
            : `${group.spec}.${binding.imported}`;
          const memberTarget = node.type === "import_from_statement" && moduleIsPackage
            ? resolvePythonSpec(importedSpec)
            : null;
          if (!scope) continue;
          if (!moduleTarget || memberTarget) {
            // An unresolved import, or a package attribute with a same-named
            // submodule, cannot safely preserve/choose a binding.
            pythonShadows.push({
              local: binding.local,
              declaredAt: node.startIndex,
              scopeKey: pythonScopeKey(scope),
            });
            if (moduleTarget) targets.add(moduleTarget);
            continue;
          }
          targets.add(moduleTarget);
          pythonBindings.push({
            local: binding.local,
            target: moduleTarget,
            imported: binding.imported,
            accessPath: binding.accessPath,
            declaredAt: node.startIndex,
            scopeKey: pythonScopeKey(scope),
          });
        }
        if (group.bindings.length === 0 && moduleTarget) targets.add(moduleTarget);
        if (targets.size === 0) {
          out.push({ fromPath: path, toPath: null, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.0 });
        } else {
          for (const target of targets) {
            out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 });
          }
        }
      }
    } else if (node.type === "import_statement" || node.type === "import_declaration" || node.type === "import_from_statement") {
      const target = resolveSpec(importSpec(node));
      out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: target ? 0.9 : 0.0 });
      if (jsts && target) for (const name of importBindingNames(node)) bindings.set(name, target);
    } else if (node.type === "call_expression") {
      const fn = childField(node, "function");
      if (fn && (fn.type === "import" || fn.text === "import")) {
        const target = resolveSpec(firstStringArg(node));
        out.push({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: target ? 0.9 : 0.0 });
      }
    }
  }

  // Pass 2 (TS/JS): calls + references resolved through import bindings.
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
          if (obj && obj.type === "identifier") callee = obj.text;
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

  // Pass 2 (Python): calls and imported-base inheritance. File-level edges are
  // deduped by target because persisted symbol endpoints are not yet available.
  if (python && pythonBindings.length > 0) {
    const callsSeen = new Set<string>();
    const inheritsSeen = new Set<string>();
    for (const node of iterAll(root)) {
      if (node.type === "call") {
        const fn = childField(node, "function");
        const binding = pythonBindingFor(fn, pythonBindings, pythonShadows, moduleScopeKey);
        if (fn && binding && !callsSeen.has(binding.target)) {
          callsSeen.add(binding.target);
          out.push({
            fromPath: path,
            toPath: binding.target,
            fromSymbol: null,
            toSymbol: referencedSymbol(fn, binding),
            type: "calls",
            confidence: 0.7,
          });
        }
      } else if (node.type === "class_definition") {
        const className = childField(node, "name")?.text ?? null;
        const superclasses = childField(node, "superclasses");
        for (const base of superclasses?.namedChildren ?? []) {
          const binding = pythonBindingFor(
            base,
            pythonBindings,
            pythonShadows,
            moduleScopeKey,
            pythonScope(node.parent),
          );
          if (!binding || inheritsSeen.has(binding.target)) continue;
          inheritsSeen.add(binding.target);
          out.push({
            fromPath: path,
            toPath: binding.target,
            fromSymbol: className,
            toSymbol: referencedSymbol(base, binding),
            type: "inherits",
            confidence: 0.8,
          });
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
    stmt.run(id("edge_"), indexId, e.fromPath, e.toPath, e.type, e.confidence);
  }
}