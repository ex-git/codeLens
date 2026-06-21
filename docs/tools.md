# Tool Reference — CodeLens

All tools are exposed via MCP. Inputs are validated with zod; outputs are
JSON-serialized text content.

## cl_current
- **Input**: none
- **Returns**: `{ repo, branch, headSha, indexId, status, dirtyFiles, lastIndexedAt, inGitRepo }`
- **Use**: first call to check index readiness.

## cl_refresh
- **Input**: none
- **Returns**: `{ indexId, branch, indexedFiles, totalChunks, skipped, status }`
- **Use**: build/update the current branch index.

## cl_search
- **Input**: `{ query: string, limit?: number=5, cursor?: string, contentType?: "code"|"prose", related?: boolean, snippet?: "none"|"headline"|"compact"|"full" }`
- **Returns**: `{ indexId, query, count, results:[{handle,path,lines,score,why,preview,stale?}], freshness, nextCursor?, pendingFiles?, related? }`
  - `lines` is `"start-end"`; `why` is a comma-joined signal string; `preview` is a short highlighted snippet (empty when `snippet:"none"`). Use `handle` with `cl_expand`/`cl_save`. Pagination uses the top-level `nextCursor` (no per-result cursor). If `stale:true`, read that file from disk (`cl_expand`/raw read) before relying on indexed content.
- **Use**: intent-level code discovery.
- **Identifier matching**: code identifiers are indexed with bounded subtokens (`validateSession` also matches `session`) in the match-only FTS text. Query expansion uses the same bounded splitter and preserves snippets/handles from stored chunk content.
- **`snippet` (preview verbosity)**: default is signature-first `headline` (richer `compact` for the top ~3 results), which keeps payloads small. `none` returns path+lines only (fetch with `cl_expand`); `compact`/`full` return larger code windows. Explicitly setting `snippet` applies that mode to all results.
- **`why` signals**: `fts|symbol|exact|graph|path|code` (exact = exact symbol-name match; path = query term in the file path). Ranking is deterministic with a stable tie-break.
- **Line-range format**: `cl_search` reports `lines` as a `"start-end"` string for compact display; `cl_map` and `cl_expand` use numeric `startLine`/`endLine` for programmatic use. This difference is intentional.

## cl_explore
- **Input**: `{ query: string, limit?: number=8, cursor?: string, contentType?: "code"|"prose", snippet?: "none"|"headline"|"compact"|"full", relatedDepth?: number=1 }`
- **Returns**: `{ indexId, query, count, files:[{path, stale?, results:[{handle,lines,score,why,preview,signature?,collapsed?,stale?}]}], related:[{sourcePath,path,edgeType,hops,confidence,stale?}], freshness, pendingFiles?, nextCursor? }`
- **Use**: broad orientation in one call — "how does X work?", "show the flow around Y", or surveying an unfamiliar area. It fuses `cl_search` + grouped previews + graph relationships; use `cl_search` when you only need to locate handles.

## cl_related
- **Input**: `{ path: string, types?: string[], depth?: number=2, direction?: "out"|"in"|"both" }`
- **Returns**: `{ indexId, results:[{handle,path,edgeType,hops,confidence,stale?}], freshness?, pendingFiles? }`
- **Edge types**: `imports|imported_by|tests|calls|references|defines|exports|belongs_to` (TS/JS populate `calls`/`references` and resolve dynamic `import()`).

## cl_impact
- **Input**: `{ symbol?: string, path?: string, depth?: number=2, includeTests?: boolean=true }`
- **Returns**: `{ indexId, target?, candidates?, callers, callees, affectedFiles, affectedTests, depth, confidenceNote, freshness?, pendingFiles? }`
- **Use**: before changing shared code. Pass `symbol` plus `path` when possible; if a symbol is ambiguous, CodeLens returns `candidates` instead of guessing. Impact is edge-derived and includes confidence/hop counts; use `cl_expand` to inspect exact current code before editing.

## cl_map
- **Input**: `{ path?: string, limit?: number=50, all?: boolean }`
- **Returns**: `{ indexId, files:[{path, stale?, symbols:[{name,kind,signature,startLine,endLine,exported}]}], fileCount, truncated, freshness?, pendingFiles? }`
- **Use**: outline / repo-map for orientation — per-file symbol signatures from the index (no file re-read). Defaults to exported symbols; pass `all:true` for everything. File-capped (default 50, max 200) with a `truncated` flag.

## Freshness and stale flags
Query tools perform a budget-bounded reconciliation before answering. If the response has `freshness:"partial"` and `pendingFiles > 0`, some changed files were not reindexed within the budget. Results/files with `stale:true` point at those known-stale paths; read them directly with `cl_expand` or a raw read before depending on indexed previews/edges.

## cl_expand
- **Input**: `{ path?: string, handle?: string, startLine?: number, endLine?: number, budget?: number=4000 }`
- **Returns**: `{ path, startLine, endLine, content, truncated, chars }`
- **Use**: read exact current file content (disk-backed, never stale). Rejects path traversal.

## cl_save
- **Input**: `{ name: string, items: [{handle?,path?,symbol_id?,chunk_id?}], notes?: string, pinned?: boolean }`
- **Returns**: `{ id, name, pinned, itemCount }`

## cl_load
- **Input**: `{ name: string }`
- **Returns**: `{ context, items }`

## cl_stats
- **Input**: none
- **Returns**: `{ active, indexId, branch, counts, backlog, lastIndexedAt, totalIndexes }`

## cl_doctor
- **Input**: none
- **Returns**: `{ nodeVersion, betterSqlite3, gitPresent, schemaVersion, integrityOk, walMode, inGitRepo, codeVersion }`

## cl_prune
- **Input**: none
- **Returns**: `{ deletedIndexes, skipped, bytesFreed }`

## cl_drop
- **Input**: `{ indexId?: string, branch?: string }`
- **Returns**: `{ deleted, indexId, reason? }` (refuses active/pinned)