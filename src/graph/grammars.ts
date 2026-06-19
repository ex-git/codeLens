import Parser from "tree-sitter";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Tree-sitter grammar registry (Design Decision #1: all grammars, graceful fallback).
 *
 * Maps language → tree-sitter Language object. Grammars are lazy-loaded so a
 * missing/failed grammar never breaks indexing (that language falls back to
 * text-only FTS). New grammars are added by extending GRAMMAR_LOADERS.
 */

type Language = unknown; // tree-sitter Language; typed loosely for portability

const GRAMMAR_LOADERS: Record<string, () => Language> = {
  typescript: () => _require("tree-sitter-typescript").typescript as Language,
  javascript: () => _require("tree-sitter-javascript") as Language,
  python: () => _require("tree-sitter-python") as Language,
  go: () => _require("tree-sitter-go") as Language,
  rust: () => _require("tree-sitter-rust") as Language,
  java: () => _require("tree-sitter-java") as Language,
  ruby: () => _require("tree-sitter-ruby") as Language,
  php: () => _require("tree-sitter-php").php as Language,
  c: () => _require("tree-sitter-c") as Language,
  cpp: () => _require("tree-sitter-cpp") as Language,
};

const cache = new Map<string, Language | null>();

/** Get the tree-sitter Language for a language name, or null if unavailable. */
export function loadGrammar(lang: string): Language | null {
  if (cache.has(lang)) return cache.get(lang) ?? null;
  const loader = GRAMMAR_LOADERS[lang];
  if (!loader) {
    cache.set(lang, null);
    return null;
  }
  try {
    const grammar = loader();
    cache.set(lang, grammar);
    return grammar;
  } catch {
    cache.set(lang, null);
    return null;
  }
}

/** Whether a language has a usable tree-sitter grammar. */
export function isSupported(lang: string | null | undefined): lang is string {
  if (!lang) return false;
  return loadGrammar(lang) !== null;
}

/** Create a configured Parser for a language, or null if unavailable. */
export function makeParser(lang: string): Parser | null {
  const grammar = loadGrammar(lang);
  if (!grammar) return null;
  try {
    const parser = new Parser();
    // setLanguage signature varies across bindings; the grammar object is the Language.
    (parser as unknown as { setLanguage: (l: unknown) => void }).setLanguage(grammar);
    return parser;
  } catch {
    return null;
  }
}