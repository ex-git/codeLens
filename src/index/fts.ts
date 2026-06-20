import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReal } from "../util/paths.js";
import { contentHash } from "../util/hash.js";
import type { ScannedFile } from "./scanner.js";
import { extractSymbols, type ExtractedSymbol } from "../graph/symbols.js";
import { extractEdges, insertEdges, type ExtractedEdge } from "../graph/edges.js";
import { isTestFile, resolveTestTargets } from "../graph/tests.js";

/**
 * FTS5 chunk indexer (Step 7).
 *
 * Chunks a file into line-bounded slices (~500 "tokens" approximated as chars/4),
 * stores a files row + chunks rows + FTS5 rows. Per-file transactional. Symbols
 * and edges come in Steps 13-15.
 */

const CHUNK_CHARS = 2000; // ~500 tokens at ~4 chars/token

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
export function chunkText(text: string): { startLine: number; endLine: number; content: string }[] {
  const lines = text.split("\n");
  const chunks: { startLine: number; endLine: number; content: string }[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  let startLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    buf.push(line);
    bufChars += line.length + 1;
    if (bufChars >= CHUNK_CHARS) {
      chunks.push({ startLine, endLine: i + 1, content: buf.join("\n") });
      buf = [];
      bufChars = 0;
      startLine = i + 2;
    }
  }
  if (buf.length > 0) {
    chunks.push({ startLine, endLine: lines.length, content: buf.join("\n") });
  }
  return chunks;
}

/**
 * Index a single file into files + chunks + chunks_fts. Transactional.
 * Caller must pass the active indexId and the scanned file metadata.
 */
export function indexFile(db: Database.Database, indexId: string, repoRoot: string, file: ScannedFile, knownFiles: Set<string> = new Set(), classNameMap?: Map<string, string>): IndexResult {
  const root = resolveReal(repoRoot);
  const abs = join(root, file.path);
  const text = readFileText(abs);
  const hash = contentHash(text);
  const fileId = "file_" + randomUUID();

  const chunks = chunkText(text);
  const symbols = extractSymbols(file.path, file.language ?? "", text);
  const edges = extractEdges(file.path, file.language ?? "", text, root, knownFiles, classNameMap);

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
      `INSERT INTO chunks (id, index_id, file_id, symbol_id, path, start_line, end_line, content, content_hash, content_type)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO chunks_fts (content, path, index_id, chunk_id) VALUES (?, ?, ?, ?)`,
    );
    for (const c of chunks) {
      const chunkId = "chk_" + randomUUID();
      const cHash = contentHash(c.content);
      const ctype = file.language && ["typescript", "javascript", "python", "go", "rust", "java", "c", "cpp", "gdscript"].includes(file.language)
        ? "code"
        : "prose";
      insertChunk.run(chunkId, indexId, fileId, file.path, c.startLine, c.endLine, c.content, cHash, ctype);
      insertFts.run(c.content, file.path, indexId, chunkId);
    }

    // Symbols (Step 13)
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (id, index_id, file_id, path, name, kind, signature, start_line, end_line, exported, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const sym of symbols) {
      insertSymbol.run(
        "sym_" + randomUUID(), indexId, fileId, file.path,
        sym.name, sym.kind, sym.signature ?? null, sym.startLine, sym.endLine,
        sym.exported ? 1 : 0,
      );
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