import type Parser from "tree-sitter";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Tree-sitter grammar registry (Design Decision #1: all grammars, graceful fallback).
 *
 * Maps language → tree-sitter Language object. Grammars are lazy-loaded so a
 * missing/failed grammar never breaks indexing (that language falls back to
 * text-only FTS). New grammars are added by extending GRAMMARS.
 */

type Language = unknown; // tree-sitter Language; typed loosely for portability

export const GRAMMARS: Record<string, { package: string; exportName?: string; sample: string }> = {
  typescript: { package: "tree-sitter-typescript", exportName: "typescript", sample: "export const value: number = 1;" },
  javascript: { package: "tree-sitter-javascript", sample: "export const value = 1;" },
  python: { package: "tree-sitter-python", sample: "def value():\n    return 1\n" },
  go: { package: "tree-sitter-go", sample: "package main\nfunc main() {}\n" },
  rust: { package: "tree-sitter-rust", sample: "fn main() {}" },
  java: { package: "tree-sitter-java", sample: "class Example {}" },
  ruby: { package: "tree-sitter-ruby", sample: "def value\n  1\nend\n" },
  php: { package: "tree-sitter-php", exportName: "php", sample: "<?php function value() { return 1; }" },
  c: { package: "tree-sitter-c", sample: "int main(void) { return 0; }" },
  cpp: { package: "tree-sitter-cpp", sample: "int main() { return 0; }" },
};

const cache = new Map<string, Language | null>();
let parserClass: typeof Parser | null | undefined;

function warnFallback(pkg: string, error: unknown): void {
  console.error(`codelens: ${pkg} unavailable; using text-only search without symbols/graph extraction for affected languages. ${error instanceof Error ? error.message : String(error)}. Run codelens --check-install for recovery steps.`);
}

function getParserClass(): typeof Parser | null {
  if (parserClass !== undefined) return parserClass;
  try {
    parserClass = _require("tree-sitter") as typeof Parser;
    return parserClass;
  } catch (error) {
    parserClass = null;
    warnFallback("tree-sitter", error);
    return null;
  }
}

/** Get the tree-sitter Language for a language name, or null if unavailable. */
export function loadGrammar(lang: string): Language | null {
  if (cache.has(lang)) return cache.get(lang) ?? null;
  const spec = Object.hasOwn(GRAMMARS, lang) ? GRAMMARS[lang] : undefined;
  const ParserClass = spec ? getParserClass() : null;
  if (!spec || !ParserClass) {
    cache.set(lang, null);
    return null;
  }
  try {
    const loaded = _require(spec.package);
    const grammar = (spec.exportName ? loaded[spec.exportName] : loaded) as Language;
    // A successful require does not prove compatibility with the parser ABI.
    const parser = new ParserClass();
    (parser as unknown as { setLanguage: (l: unknown) => void }).setLanguage(grammar);
    cache.set(lang, grammar);
    return grammar;
  } catch (error) {
    cache.set(lang, null);
    warnFallback(spec.package, error);
    return null;
  }
}

/** Whether a language has a usable tree-sitter grammar. */
export function isSupported(lang: string | null | undefined): lang is string {
  if (!lang) return false;
  return loadGrammar(lang) !== null;
}

/** Whether a language's chunks should be indexed as `content_type = "code"`.
 *  Single source of truth: any language with a registered tree-sitter grammar
 *  is "code". Adding a grammar therefore automatically classifies its chunks
 *  as code (previously a separate hardcoded 8-language list had to be kept in
 *  sync, which silently mislabeled ruby/php as prose). */
export function isCodeLanguage(lang: string | null | undefined): boolean {
  return isSupported(lang);
}

/** Create a configured Parser for a language, or null if unavailable. */
export function makeParser(lang: string): Parser | null {
  const grammar = loadGrammar(lang);
  if (!grammar) return null;
  try {
    const ParserClass = getParserClass();
    if (!ParserClass) return null;
    const parser = new ParserClass();
    // setLanguage signature varies across bindings; the grammar object is the Language.
    (parser as unknown as { setLanguage: (l: unknown) => void }).setLanguage(grammar);
    return parser;
  } catch {
    return null;
  }
}

/** Parse source once for a language, or null on unsupported grammar / parse failure. */
export function parseFile(lang: string, source: string): Parser.Tree | null {
  const parser = makeParser(lang);
  if (!parser) return null;
  try {
    return parser.parse(source);
  } catch {
    return null;
  }
}
