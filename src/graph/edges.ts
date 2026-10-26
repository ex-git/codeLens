import type Database from "better-sqlite3";
import type Parser from "tree-sitter";
import { parseFile } from "./grammars.js";
import { resolveImportFs, resolveImport, resolvePythonImport, resolvePythonImportFs } from "./resolve.js";
import { id } from "../util/id.js";
import { extractSymbols, type ExtractedSymbol } from "./symbols.js";
import { prepareIndexStatement } from "../db/queries.js";

export const GRAPH_VERSION = 4;

/**
 * Edge builder (Step 14).
 *
 * Emits structural file relationships and resolvable symbol identities from
 * tree-sitter nodes. The indexer adds ownership edges and links current IDs.
 * Unresolved imports emit no persisted edge (not a wrong edge).
 */

export interface ExtractedEdge {
  fromPath: string;
  toPath: string | null;     // null = unresolved import
  fromSymbol: string | null;
  toSymbol: string | null;
  type: string;              // imports|calls|references|inherits|defines|belongs_to|exports
  confidence: number;
  fromLine?: number;
  toLine?: number;
  sourceStartLine?: number;
  sourceEndLine?: number;
  method?: "ast" | "path-heuristic" | "explicit-reference";
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
  for (const c of node.namedChildren) yield* iterAll(c);
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}

function groupByName<T>(items: T[], name: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = name(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
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

interface JsBinding { target: string; imported: string | null; namespace: boolean }

function jsImportBindings(node: Parser.SyntaxNode, target: string): Array<[string, JsBinding]> {
  const result: Array<[string, JsBinding]> = [];
  for (const child of iterAll(node)) {
    if (child.type === "import_specifier") {
      const name = childField(child, "name")?.text;
      const alias = childField(child, "alias")?.text ?? name;
      if (name && alias) result.push([alias, { target, imported: name, namespace: false }]);
    } else if (child.type === "namespace_import") {
      const name = child.namedChildren.find(c => c.type === "identifier")?.text;
      if (name) result.push([name, { target, imported: null, namespace: true }]);
    } else if (child.type === "identifier" && child.parent?.type === "import_clause") {
      // A default export's declaration name need not equal the local binding.
      result.push([child.text, { target, imported: null, namespace: false }]);
    }
  }
  return result;
}

function bindingNames(node: Parser.SyntaxNode | null): string[] {
  if (!node) return [];
  if (["identifier", "shorthand_property_identifier_pattern"].includes(node.type)) return [node.text];
  if (["object_pattern", "array_pattern", "rest_pattern"].includes(node.type)) return node.namedChildren.flatMap(bindingNames);
  if (["pair_pattern", "assignment_pattern", "object_assignment_pattern"].includes(node.type)) {
    return bindingNames(childField(node, "value") ?? childField(node, "left"));
  }
  return [];
}

/** Conservative lexical claims. Unknown rebinding suppresses a precise edge. */
function jsShadows(root: Parser.SyntaxNode, nodes: Parser.SyntaxNode[]): Array<{ name: string; scope: Parser.SyntaxNode; declaration: Parser.SyntaxNode }> {
  const result: Array<{ name: string; scope: Parser.SyntaxNode; declaration: Parser.SyntaxNode }> = [];
  const block = (node: Parser.SyntaxNode, hoisted = node.type === "variable_declarator" && node.parent?.type === "variable_declaration"): Parser.SyntaxNode => {
    for (let p = node.parent; p; p = p.parent) {
      if (hoisted ? ["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function", "generator_function_declaration", "program"].includes(p.type)
        : ["statement_block", "for_statement", "for_in_statement", "catch_clause", "program", "class_body"].includes(p.type)) return p;
    }
    return root;
  };
  for (const node of nodes) {
    const parameters = childField(node, "parameters");
    if (parameters) {
      for (const p of parameters.namedChildren) {
        for (const name of bindingNames(childField(p, "pattern") ?? childField(p, "name") ?? p)) result.push({ name, scope: node, declaration: p });
      }
    }
    if (node.type === "arrow_function" && childField(node, "parameter")) {
      for (const name of bindingNames(childField(node, "parameter"))) result.push({ name, scope: node, declaration: node });
    }
    if (node.type === "for_in_statement") {
      const kind = childField(node, "kind")?.text;
      const scope = kind === "var" ? block(node, true) : kind ? node : root;
      for (const name of bindingNames(childField(node, "left"))) result.push({ name, scope, declaration: node });
    }
    if (["variable_declarator", "function_declaration", "class_declaration", "catch_clause"].includes(node.type)) {
      for (const name of bindingNames(childField(node, "name") ?? childField(node, "parameter"))) result.push({ name, scope: block(node), declaration: node });
    }
    if (["assignment_expression", "augmented_assignment_expression", "update_expression"].includes(node.type)) {
      for (const name of bindingNames(childField(node, "left") ?? childField(node, "argument"))) result.push({ name, scope: root, declaration: node });
    }
  }
  return result;
}

interface PythonBinding {
  local: string;
  target: string;
  imported: string;
  accessPath: string[];
  declaredAt: number;
  scopeKey: string;
  namespace: boolean;
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

/** Class bodies do not enclose the lexical scopes of methods or comprehensions. */
function* pythonLexicalScopes(scope: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  for (let current: Parser.SyntaxNode | null = scope; current; current = pythonScope(current.parent)) {
    if (current.id === scope.id || current.type !== "class_definition") yield current;
  }
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

  const scopeClaimsName = [...pythonLexicalScopes(scope)].some(enclosing => {
    const key = pythonScopeKey(enclosing);
    return key !== moduleScopeKey && (bindings.some(binding => binding.scopeKey === key && binding.local === local)
      || shadows.some(shadow => shadow.scopeKey === key && shadow.local === local));
  });
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
export function extractEdges(path: string, lang: string, source: string, repoRoot: string, knownFiles: Set<string>, parsedTree?: Parser.Tree | null, parsedSymbols?: ExtractedSymbol[]): ExtractedEdge[] {
  const tree = parsedTree ?? parseFile(lang, source);
  if (!tree) return [];
  const out: ExtractedEdge[] = [];
  const root = tree.rootNode;
  const jsts = lang === "typescript" || lang === "javascript";
  const python = lang === "python";

  const nodes = [...iterAll(root)];
  const symbols = parsedSymbols ?? extractSymbols(path, lang, source, tree);
  const symbolsByRange = new Map(symbols.map(s => [`${s.startLine}:${s.endLine}:${s.name}`, s]));
  const callerCache = new Map<number, ExtractedSymbol | undefined>();
  const caller = (node: Parser.SyntaxNode): ExtractedSymbol | undefined => {
    if (callerCache.has(node.id)) return callerCache.get(node.id);
    for (let parent: Parser.SyntaxNode | null = node; parent; parent = parent.parent) {
      const lexical = ["lexical_declaration", "variable_declaration"].includes(parent.type);
      const declaration = lexical ? parent.namedChildren.find(c => c.type === "variable_declarator") : parent;
      const value = lexical && declaration ? childField(declaration, "value") : null;
      const callableInitializer = value && ["arrow_function", "function_expression", "generator_function"].includes(value.type)
        && node.startIndex >= value.startIndex && node.endIndex <= value.endIndex;
      const callableDeclaration = ["function_declaration", "function_definition", "method_definition", "method_declaration"].includes(parent.type);
      const ownClass = parent.id === node.id && ["class_definition", "class_declaration"].includes(parent.type);
      if (!callableDeclaration && !callableInitializer && !ownClass) continue;
      const name = declaration && childField(declaration, "name")?.text;
      const match = symbolsByRange.get(`${parent.startPosition.row + 1}:${parent.endPosition.row + 1}:${name}`);
      if (match) { callerCache.set(node.id, match); return match; }
    }
    callerCache.set(node.id, undefined);
    return undefined;
  };
  const callerKey = (node: Parser.SyntaxNode): string => {
    const from = caller(node);
    return from ? `${from.scope}:${from.name}:${from.startLine}:${from.endLine}` : "file";
  };
  const emit = (edge: ExtractedEdge, node: Parser.SyntaxNode) => {
    const from = caller(node);
    out.push({ ...edge, fromSymbol: edge.fromSymbol ?? from?.name ?? null, fromLine: from?.startLine,
      sourceStartLine: node.startPosition.row + 1, sourceEndLine: node.endPosition.row + 1, method: "ast" });
  };
  const shadows = groupByName(jsts ? jsShadows(root, nodes) : [], s => s.name);
  const shadowed = (node: Parser.SyntaxNode, name: string, allowed?: Parser.SyntaxNode): boolean => (shadows.get(name) ?? []).some(s =>
    s.declaration.id !== allowed?.id && node.startIndex >= s.scope.startIndex && node.endIndex <= s.scope.endIndex);
  const bindings = new Map<string, JsBinding>();
  const pythonBindings: PythonBinding[] = [];
  const pythonShadows: PythonShadow[] = [];
  const moduleScopeKey = pythonScopeKey(root);
  const resolveSpec = (spec: string | null): string | null =>
    spec ? (resolveImportFs(repoRoot, path, spec) ?? resolveImport(path, spec, knownFiles)) : null;
  const resolvePythonSpec = (spec: string): string | null =>
    resolvePythonImportFs(repoRoot, path, spec) ?? resolvePythonImport(path, spec, knownFiles);

  // Pass 1: imports (static + dynamic). Unresolved imports emit a 0-confidence
  // edge that insertEdges filters out (no edge beats a wrong edge).
  for (const node of nodes) {
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
            namespace: node.type === "import_statement",
          });
        }
        if (group.bindings.length === 0 && moduleTarget) targets.add(moduleTarget);
        if (targets.size === 0) {
          emit({ fromPath: path, toPath: null, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.0 }, node);
        } else {
          for (const target of targets) {
            emit({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 }, node);
          }
        }
      }
    } else if (node.type === "import_statement" || node.type === "import_declaration" || node.type === "import_from_statement") {
      const target = resolveSpec(importSpec(node));
      emit({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: target ? 0.9 : 0.0 }, node);
      if (jsts && target) for (const [name, binding] of jsImportBindings(node, target)) bindings.set(name, binding);
    } else if (node.type === "call_expression") {
      const fn = childField(node, "function");
      if (fn && (fn.type === "import" || fn.text === "import")) {
        const target = resolveSpec(firstStringArg(node));
        emit({ fromPath: path, toPath: target, fromSymbol: null, toSymbol: null, type: "imports", confidence: target ? 0.9 : 0.0 }, node);
      }
    }
  }

  const pythonBindingsByName = groupByName(pythonBindings, b => b.local);
  const pythonShadowsByName = groupByName(pythonShadows, s => s.local);
  const pythonBinding = (node: Parser.SyntaxNode | null, scope?: Parser.SyntaxNode | null) => {
    const local = pythonReferenceParts(node)?.[0] ?? "";
    return pythonBindingFor(node, pythonBindingsByName.get(local) ?? [], pythonShadowsByName.get(local) ?? [], moduleScopeKey, scope);
  };

  // Pass 2 (TS/JS): calls + references resolved through import bindings.
  if (jsts && bindings.size > 0) {
    const callsSeen = new Set<string>();
    const refsSeen = new Set<string>();
    for (const node of nodes) {
      if (node.type === "call_expression") {
        const fn = childField(node, "function");
        if (!fn) continue;
        let callee: string | null = null;
        if (fn.type === "identifier") callee = fn.text;
        else if (fn.type === "member_expression") {
          const obj = childField(fn, "object");
          if (obj && obj.type === "identifier") callee = obj.text;
        }
        const binding = callee ? bindings.get(callee) : undefined;
        const key = `${callee}:${callerKey(node)}:${fn.text}`;
        if (callee && binding && !shadowed(node, callee) && !callsSeen.has(key)) {
          callsSeen.add(key);
          const targetName = fn.type === "identifier" ? binding.imported
            : binding.namespace ? childField(fn, "property")?.text ?? null : null;
          emit({ fromPath: path, toPath: binding.target, fromSymbol: null, toSymbol: targetName, type: "calls", confidence: 0.7 }, node);
        }
      } else if (node.type === "member_expression") {
        const obj = childField(node, "object");
        if (obj && obj.type === "identifier" && bindings.has(obj.text) && !shadowed(node, obj.text) && !refsSeen.has(obj.text)) {
          refsSeen.add(obj.text);
          // Non-call references remain file-level; member access is not a call.
          emit({ fromPath: path, toPath: bindings.get(obj.text)!.target, fromSymbol: null, toSymbol: null, type: "references", confidence: 0.6 }, node);
        }
      }
    }
  }

  // Pass 2 (Python): calls and imported-base inheritance. Retain caller/callee
  // identities; the indexer links current symbol IDs after the batch.
  if (python && pythonBindings.length > 0) {
    const callsSeen = new Set<string>();
    const inheritsSeen = new Set<string>();
    for (const node of nodes) {
      if (node.type === "call") {
        const fn = childField(node, "function");
        const binding = pythonBinding(fn);
        const key = `${binding?.target}:${callerKey(node)}:${fn?.text}`;
        if (fn && binding && !callsSeen.has(key)) {
          callsSeen.add(key);
          const parts = pythonReferenceParts(fn)!;
          const precise = binding.namespace ? parts.length === binding.accessPath.length + 1 : parts.length === binding.accessPath.length;
          emit({
            fromPath: path,
            toPath: binding.target,
            fromSymbol: null,
            toSymbol: precise ? referencedSymbol(fn, binding) : null,
            type: "calls",
            confidence: 0.7,
          }, node);
        }
      } else if (node.type === "class_definition") {
        const className = childField(node, "name")?.text ?? null;
        const superclasses = childField(node, "superclasses");
        for (const base of superclasses?.namedChildren ?? []) {
          const binding = pythonBinding(base, pythonScope(node.parent));
          if (!binding) continue;
          const key = `${callerKey(node)}:${binding.target}:${referencedSymbol(base, binding)}`;
          if (inheritsSeen.has(key)) continue;
          inheritsSeen.add(key);
          emit({
            fromPath: path,
            toPath: binding.target,
            fromSymbol: className,
            toSymbol: referencedSymbol(base, binding),
            type: "inherits",
            confidence: 0.8,
          }, node);
        }
      }
    }
  }

  // Local direct calls are precise only for unique module-level declarations.
  if (jsts || python) {
    const locals = groupByName(symbols.filter(s => s.scope === "" && s.kind === "function"), s => s.name);
    const declarations = new Map<string, Parser.SyntaxNode>();
    for (const node of nodes) {
      const name = childField(node, "name")?.text;
      if (name) declarations.set(`${name}:${node.startPosition.row + 1}`, node);
    }
    for (const node of nodes) {
      if (node.type !== (python ? "call" : "call_expression")) continue;
      const fn = childField(node, "function");
      if (fn?.type !== "identifier" || bindings.has(fn.text) || pythonBindingsByName.has(fn.text)) continue;
      const matches = locals.get(fn.text);
      if (matches?.length !== 1) continue;
      const target = matches[0]!;
      const declaration = declarations.get(`${target.name}:${target.startLine}`);
      const pyScopes = python ? new Set([...pythonLexicalScopes(pythonScope(node) ?? root)].map(pythonScopeKey)) : null;
      const pyShadow = python && (pythonShadowsByName.get(fn.text) ?? []).some(s => pyScopes!.has(s.scopeKey)
        && (s.scopeKey !== moduleScopeKey || s.declaredAt !== declaration?.startIndex));
      if (shadowed(node, fn.text, declaration) || pyShadow) continue;
      emit({ fromPath: path, toPath: path, fromSymbol: null, toSymbol: target.name, toLine: target.startLine, type: "calls", confidence: 0.8 }, node);
    }
  }
  return out;
}

/** Link current symbols. Incremental batches restrict updates to touched endpoints. */
export function relinkEdges(db: Database.Database, indexId: string, paths?: Iterable<string>): void {
  const update = `UPDATE edges SET
    from_id = (SELECT MIN(s.id) FROM symbols s WHERE s.index_id = edges.index_id
      AND s.path = edges.from_path AND s.name = edges.from_symbol AND s.start_line = edges.from_line HAVING COUNT(*) = 1),
    to_id = (SELECT MIN(s.id) FROM symbols s WHERE s.index_id = edges.index_id
      AND s.path = edges.to_path
      AND (s.name = edges.to_symbol OR edges.method = 'explicit-reference' AND CASE WHEN s.scope = '' THEN s.name ELSE s.scope || '.' || s.name END = edges.to_symbol)
      AND (edges.to_line IS NOT NULL AND s.start_line = edges.to_line OR edges.to_line IS NULL AND (s.scope = '' OR edges.method = 'explicit-reference'))
      AND (edges.to_line IS NOT NULL OR edges.method = 'explicit-reference' OR s.exported = 1
        OR EXISTS (SELECT 1 FROM files f WHERE f.index_id = s.index_id AND f.path = s.path AND f.language = 'python')) HAVING COUNT(*) = 1)
    WHERE index_id = ? AND (from_symbol IS NOT NULL OR to_symbol IS NOT NULL)`;
  if (paths === undefined) {
    db.prepare(update).run(indexId);
    return;
  }
  // Separate predicates use the existing source/target path indexes. Fixed-size
  // statements also avoid SQLite's variable limit on large refresh batches.
  db.transaction(() => {
    const outgoing = db.prepare(`${update} AND from_path = ?`);
    const incoming = db.prepare(`${update} AND to_path = ? AND from_path != ?`);
    for (const path of new Set(paths)) {
      outgoing.run(indexId, path);
      incoming.run(indexId, path, path);
    }
  })();
}

/** Insert extracted edges into the edges table (skips unresolved imports). */
export function insertEdges(db: Database.Database, indexId: string, edges: ExtractedEdge[]): void {
  const stmt = prepareIndexStatement(db,
    `INSERT INTO edges (id, index_id, from_path, to_path, type, confidence, from_symbol, to_symbol, from_line, to_line, source_start_line, source_end_line, method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  );
  for (const e of edges) {
    if (e.type === "imports" && !e.toPath) continue; // unresolved → no edge
    stmt.run(id("edge_"), indexId, e.fromPath, e.toPath, e.type, e.confidence,
      e.fromSymbol, e.toSymbol, e.fromLine ?? null, e.toLine ?? null,
      e.sourceStartLine ?? null, e.sourceEndLine ?? null, e.method ?? null);
  }
}