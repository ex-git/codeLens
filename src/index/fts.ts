import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReal } from "../util/paths.js";
import { contentHash } from "../util/hash.js";
import type { ScannedFile } from "./scanner.js";
import { extractSymbols, type ExtractedSymbol } from "../graph/symbols.js";
import { extractEdges, insertEdges, type ExtractedEdge } from "../graph/edges.js";
import { parseFile } from "../graph/grammars.js";
import { isTestFile, resolveTestTargets } from "../graph/tests.js";
import { withIdentifierSubtokens } from "../search/identifiers.js";

/**
 * FTS5 chunk indexer (Step 7).
 *
 * Chunks a file into line-bounded slices (~500 "tokens" approximated as chars/4),
 * stores a files row + chunks rows + FTS5 rows. Per-file transactional. Symbols
 * and edges come in Steps 13-15.
 */

const CHUNK_CHARS = 2000; // ~500 tokens at ~4 chars/token
const DEFAULT_CHUNK_OVERLAP_CHARS = 100;
const STRUCTURAL_CHUNK_MAX_BYTES = 512 * 1024;

export const CHUNKER_VERSION = 2;
export const CHUNKER_NAMES = {
  line: "line",
  structural: "structural",
} as const;

export interface TextChunk {
  startLine: number;
  endLine: number;
  content: string;
}

export interface StructuredChunk extends TextChunk {
  symbolName?: string;
  symbolKind?: string;
  symbolRangeKey?: string;
}

export interface ChunkTextOptions {
  maxChars?: number;
  overlapChars?: number;
}

export interface ChunkStructuredOptions extends ChunkTextOptions {
  maxBytes?: number;
}

interface NormalizedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  rangeKey: string;
}

export interface IndexResult {
  fileId: string;
  chunkCount: number;
  contentHash: string;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

/** Read a file's text (UTF-8). Throws on read failure — caller handles. */
function readFileText(absPath: string): string {
  return readFileSync(absPath, "utf-8");
}

/** Split text into line-bounded chunks of roughly CHUNK_CHARS characters. */
export function chunkText(text: string, opts: ChunkTextOptions = {}): TextChunk[] {
  return chunkLines(text.split("\n"), 1, opts);
}

/**
 * Split code along outermost symbol ranges while preserving complete primary
 * line ownership. Parser/range failures are quality issues, never index blockers;
 * callers can fall back to chunkText when this returns null.
 */
export function chunkStructured(
  text: string,
  symbols: ExtractedSymbol[],
  opts: ChunkStructuredOptions = {},
): StructuredChunk[] | null {
  const maxBytes = opts.maxBytes ?? STRUCTURAL_CHUNK_MAX_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;

  if (symbols.length === 0) return chunkText(text, opts);

  const lines = text.split("\n");
  const normalized = normalizeSymbols(symbols, lines.length);
  if (normalized.length === 0) return chunkText(text, opts);

  const chunks: StructuredChunk[] = [];
  let cursor = 1;
  for (const sym of normalized) {
    let symbolStart = findLeadingCommentStart(lines, sym.startLine, cursor);
    if (symbolStart < cursor) symbolStart = cursor;

    if (cursor < symbolStart) {
      chunks.push(...chunkLineRange(lines, cursor, symbolStart - 1, opts));
    }

    const symbolChunks = chunkLineRange(lines, symbolStart, sym.endLine, opts).map((chunk) => ({
      ...chunk,
      symbolName: sym.name,
      symbolKind: sym.kind,
      symbolRangeKey: sym.rangeKey,
    }));
    chunks.push(...symbolChunks);
    cursor = sym.endLine + 1;
  }

  if (cursor <= lines.length) {
    chunks.push(...chunkLineRange(lines, cursor, lines.length, opts));
  }

  return rangesAreUnique(chunks) ? chunks : null;
}

function chunkLineRange(lines: string[], startLine: number, endLine: number, opts: ChunkTextOptions): TextChunk[] {
  if (startLine > endLine) return [];
  const slice = lines.slice(startLine - 1, endLine);
  return chunkLines(slice, startLine, opts);
}

function chunkLines(lines: string[], startLine: number, opts: ChunkTextOptions): TextChunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? CHUNK_CHARS);
  const overlapChars = Math.min(Math.max(0, opts.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS), Math.max(0, maxChars - 1));
  const chunks: TextChunk[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  let bufStartOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    buf.push(line);
    bufChars += line.length + 1;
    if (bufChars >= maxChars) {
      chunks.push({ startLine: startLine + bufStartOffset, endLine: startLine + i, content: buf.join("\n") });
      const keepFrom = overlapStartIndex(buf, overlapChars);
      buf = buf.slice(keepFrom);
      bufStartOffset += keepFrom;
      bufChars = charCount(buf);
    }
  }

  if (buf.length > 0) {
    const finalChunk = {
      startLine: startLine + bufStartOffset,
      endLine: startLine + lines.length - 1,
      content: buf.join("\n"),
    };
    const last = chunks[chunks.length - 1];
    if (!last || last.startLine !== finalChunk.startLine || last.endLine !== finalChunk.endLine) {
      chunks.push(finalChunk);
    }
  }

  return chunks;
}

function overlapStartIndex(lines: string[], overlapChars: number): number {
  if (overlapChars <= 0) return lines.length;
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    chars += lines[i]!.length + 1;
    if (chars >= overlapChars) return i;
  }
  return 0;
}

function charCount(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function normalizeSymbols(symbols: ExtractedSymbol[], lineCount: number): NormalizedSymbol[] {
  const candidates = symbols
    .map((sym) => {
      if (sym.startLine <= 0 || sym.endLine <= 0 || sym.startLine > lineCount) return null;
      const startLine = sym.startLine;
      const endLine = Math.min(sym.endLine, lineCount);
      if (endLine < startLine) return null;
      return {
        name: sym.name,
        kind: sym.kind,
        startLine,
        endLine,
        rangeKey: chunkSymbolRangeKey({ ...sym, startLine, endLine }),
      } satisfies NormalizedSymbol;
    })
    .filter((sym): sym is NormalizedSymbol => sym !== null)
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine || a.name.localeCompare(b.name));

  const kept: NormalizedSymbol[] = [];
  for (const sym of candidates) {
    if (kept.some((prior) => prior.startLine <= sym.startLine && prior.endLine >= sym.endLine)) continue;
    if (kept.some((prior) => rangesOverlap(prior, sym))) continue;
    kept.push(sym);
  }
  return kept;
}

export function chunkSymbolRangeKey(sym: Pick<ExtractedSymbol, "name" | "kind" | "startLine" | "endLine">, lineCount?: number): string {
  const endLine = lineCount ? Math.min(sym.endLine, lineCount) : sym.endLine;
  return `${sym.startLine}:${endLine}:${sym.kind}:${sym.name}`;
}

function rangesOverlap(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function findLeadingCommentStart(lines: string[], symbolStartLine: number, lowerBound: number): number {
  let lineNo = symbolStartLine - 1;
  let start = symbolStartLine;
  while (lineNo >= lowerBound) {
    const text = lines[lineNo - 1]!.trim();
    if (text === "") break;
    if (text.endsWith("*/")) {
      start = lineNo;
      lineNo--;
      while (lineNo >= lowerBound) {
        start = lineNo;
        const inner = lines[lineNo - 1]!.trim();
        if (inner.includes("/*")) {
          lineNo--;
          break;
        }
        lineNo--;
      }
      continue;
    }
    if (isLeadingCommentOrDecorator(text)) {
      start = lineNo;
      lineNo--;
      continue;
    }
    break;
  }
  return start;
}

function isLeadingCommentOrDecorator(trimmedLine: string): boolean {
  return trimmedLine.startsWith("//") ||
    trimmedLine.startsWith("#") ||
    trimmedLine.startsWith("*") ||
    trimmedLine.startsWith("/*") ||
    trimmedLine.startsWith("<!--") ||
    trimmedLine.startsWith("@") ||
    trimmedLine.startsWith("\"\"\"") ||
    trimmedLine.startsWith("'''");
}

function rangesAreUnique(chunks: TextChunk[]): boolean {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const key = `${chunk.startLine}:${chunk.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Index a single file into files + chunks + chunks_fts. Transactional.
 * Caller must pass the active indexId and the scanned file metadata.
 */
export function indexFile(db: Database.Database, indexId: string, repoRoot: string, file: ScannedFile, knownFiles: Set<string> = new Set()): IndexResult {
  const root = resolveReal(repoRoot);
  const abs = join(root, file.path);
  const text = readFileText(abs);
  const hash = contentHash(text);
  const fileId = "file_" + randomUUID();

  const parserEligible = Buffer.byteLength(text, "utf8") <= STRUCTURAL_CHUNK_MAX_BYTES;
  const lang = file.language ?? "";
  const tree = parserEligible ? parseFile(lang, text) : null;
  const symbols = tree ? extractSymbols(file.path, lang, text, tree) : [];
  const edges = tree ? extractEdges(file.path, lang, text, root, knownFiles, tree) : [];
  const lineCount = text.split("\n").length;
  const symbolRows = symbols.map((sym) => ({
    id: "sym_" + randomUUID(),
    sym,
    rangeKey: chunkSymbolRangeKey(sym, lineCount),
  }));
  const symbolIdByRange = new Map<string, string>();
  for (const row of symbolRows) {
    if (!symbolIdByRange.has(row.rangeKey)) symbolIdByRange.set(row.rangeKey, row.id);
  }
  const structured = parserEligible && symbols.length > 0 ? chunkStructured(text, symbols) : null;
  const chunks: StructuredChunk[] = structured && structured.length > 0 ? structured : chunkText(text);

  const tx = db.transaction(() => {
    // Remove ALL prior rows for this path+index so reindexing a changed file
    // does not leave stale symbols/edges. Without this, incremental reindex
    // would accumulate duplicate symbols + stale graph edges.
    db.prepare("DELETE FROM chunks_fts WHERE index_id = ? AND path = ?").run(indexId, file.path);
    db.prepare("DELETE FROM chunks WHERE index_id = ? AND path = ?").run(indexId, file.path);
    db.prepare("DELETE FROM symbols WHERE index_id = ? AND path = ?").run(indexId, file.path);
    // Only clear THIS file's outbound edges (from_path = file.path). Inbound edges
    // from other files (e.g. Y imports X) stay valid since X still exists; they
    // are only removed when X is deleted (deleteFileFromIndex uses from OR to).
    db.prepare("DELETE FROM edges WHERE index_id = ? AND from_path = ?").run(indexId, file.path);
    db.prepare("DELETE FROM files WHERE index_id = ? AND path = ?").run(indexId, file.path);

    db.prepare(
      `INSERT INTO files (id, index_id, path, language, size, mtime_ms, content_hash, git_blob_sha, deleted, last_indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
    ).run(fileId, indexId, file.path, file.language, file.size, file.mtimeMs, hash, Date.now());

    const insertChunk = db.prepare(
      `INSERT INTO chunks (id, index_id, file_id, symbol_id, path, start_line, end_line, content, content_hash, content_type, chunker, chunker_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO chunks_fts (content, path, index_id, chunk_id) VALUES (?, ?, ?, ?)`,
    );
    // Symbols (Step 13) — insert before chunks so chunks can reference symbol_id.
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (id, index_id, file_id, path, name, kind, signature, start_line, end_line, exported, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const row of symbolRows) {
      const sym = row.sym;
      insertSymbol.run(
        row.id, indexId, fileId, file.path,
        sym.name, sym.kind, sym.signature ?? null, sym.startLine, sym.endLine,
        sym.exported ? 1 : 0,
      );
    }

    for (const c of chunks) {
      const chunkId = "chk_" + randomUUID();
      const cHash = contentHash(c.content);
      const ctype = file.language && ["typescript", "javascript", "python", "go", "rust", "java", "c", "cpp"].includes(file.language)
        ? "code"
        : "prose";
      const symbolId = c.symbolRangeKey ? symbolIdByRange.get(c.symbolRangeKey) ?? null : null;
      const chunker = symbolId ? CHUNKER_NAMES.structural : CHUNKER_NAMES.line;
      insertChunk.run(chunkId, indexId, fileId, symbolId, file.path, c.startLine, c.endLine, c.content, cHash, ctype, chunker, CHUNKER_VERSION);
      insertFts.run(withIdentifierSubtokens(c.content), file.path, indexId, chunkId);
    }

    // Edges: imports (file→file) from extractEdges; defines/belongs_to
    // (file↔symbol); exports (file→exported symbol).
    insertEdges(db, indexId, edges);
    const insertEdge = db.prepare(
      `INSERT INTO edges (id, index_id, from_id, to_id, from_path, to_path, type, confidence) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)`,
    );
    for (const sym of symbols) {
      // file defines symbol (file→symbol via path; symbol_id kept NULL for path-based edges)
      insertEdge.run("edge_" + randomUUID(), indexId, file.path, file.path, "defines", 1.0);
      // symbol belongs_to file
      insertEdge.run("edge_" + randomUUID(), indexId, file.path, file.path, "belongs_to", 1.0);
      if (sym.exported) {
        insertEdge.run("edge_" + randomUUID(), indexId, file.path, file.path, "exports", 1.0);
      }
    }

    // Test edges (Step 15): if this file is a test, emit `tests` edges to
    // resolved source files present in the index.
    if (isTestFile(file.path)) {
      const targets = resolveTestTargets(file.path, knownFiles);
      for (const t of targets) {
        insertEdge.run("edge_" + randomUUID(), indexId, file.path, t, "tests", 0.8);
      }
    }
  });
  tx();
  return { fileId, chunkCount: chunks.length, contentHash: hash, symbols, edges };
}

/** Mark a file as deleted (remove its rows) for an index. Transactional. */
export function deleteFileFromIndex(db: Database.Database, indexId: string, path: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM chunks_fts WHERE index_id = ? AND path = ?").run(indexId, path);
    db.prepare("DELETE FROM chunks WHERE index_id = ? AND path = ?").run(indexId, path);
    db.prepare("DELETE FROM symbols WHERE index_id = ? AND path = ?").run(indexId, path);
    db.prepare("DELETE FROM edges WHERE index_id = ? AND (from_path = ? OR to_path = ?)").run(indexId, path, path);
    db.prepare("DELETE FROM files WHERE index_id = ? AND path = ?").run(indexId, path);
  });
  tx();
}