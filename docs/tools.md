# Tool Reference — CodeLens

All tools are exposed via MCP. Inputs are validated with zod; outputs are
JSON-serialized text content.

## cl_current
- **Input**: none
- **Returns**: `{ repo, branch, headSha, indexId, status, dirtyFiles, lastIndexedAt, indexingStartedAt, indexingAgeMs, inGitRepo }`
- **Use**: first call to check index readiness. `status` is `active`, `missing`, `stale`, or `indexing` (background auto-index in progress). When `indexing`, use `indexingStartedAt`/`indexingAgeMs` to decide whether to wait, retry, or investigate a stuck index.

## cl_refresh
- **Input**: none
- **Returns**: `{ indexId, branch, indexedFiles, totalChunks, skipped, status, indexingStartedAt?, indexingAgeMs? }`
- **Use**: build/update the current branch index. If background auto-index is already running, returns `status:"indexing"` instead of duplicating work.

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
- **Input**: `{ query: string, limit?: number=8, cursor?: string, contentType?: "code"|"prose", snippet?: "none"|"headline"|"compact"|"full", relatedDepth?: number=1, maxFiles?: number=6, maxResultsPerFile?: number=3, maxRelated?: number=20 }`
- **Returns**: `{ indexId, query, count, files:[{path, stale?, results:[{handle,lines,score,why,preview,signature?,collapsed?,stale?}]}], related:[{sourcePath,path,edgeType,hops,confidence,stale?}], freshness, pendingFiles?, nextCursor?, truncated? }`
- **Use**: broad orientation in one call — "how does X work?", "show the flow around Y", or surveying an unfamiliar area. It fuses `cl_search` + grouped previews + graph relationships; use `cl_search` when you only need to locate handles.

## cl_related
- **Input**: `{ path: string, types?: string[], depth?: number=2, direction?: "out"|"in"|"both" }`
- **Returns**: `{ indexId, results:[{handle,path,edgeType,hops,confidence,stale?}], freshness?, pendingFiles? }`
- **Edge types**: `imports|imported_by|tests|calls|references|inherits|defines|exports|belongs_to|documents` (TS/JS populate `calls`/`references` and resolve dynamic `import()`; Python populates repo-local `imports`/`calls`/`inherits`).

## cl_impact
- **Input**: `{ symbol?: string, path?: string, depth?: number=2, includeTests?: boolean=true }`
- **Returns**: `{ indexId, target?, candidates?, callers, callees, affectedFiles, affectedTests, documents?, resolution?, fileFallback?, truncated?, depth, summary?, confidenceNote, freshness?, pendingFiles? }`
- **Use**: before changing shared code. Pass `symbol` plus `path` when possible; if a symbol is ambiguous, CodeLens returns `candidates` instead of guessing. Impact is edge-derived and includes confidence/hop counts plus provenance labels (`graph` or conservative `path-heuristic`); use `cl_expand` to inspect exact current code before editing.

Symbol requests follow resolved static symbol calls/inheritance. `fileFallback`
contains broader file dependencies, not proven callers. Use a qualified name
such as `Left.run` when same-file names are ambiguous. Unsupported or unresolved
forms can be absent. `documents` is separate from impact dependencies.

## cl_diff
- **Input**: `{ base?: string="HEAD", depth?: number=2, limit?: number=20, maxFiles?: number=50, maxTargets?: number=20 }`
- **Returns**: `{ indexId, base, baseSha, comparison:"worktree", depth, files, targets, callers, dependencies, affectedTests, documents, fileFallback, gaps, omitted, truncated, freshness, pendingFiles?, note }`
- **Use**: review the combined effect of staged and unstaged edits against a base commit. Non-ignored untracked paths are included. The base is compared directly, not through a merge-base. Invalid or unborn base revisions return an error.
- **Mapping**: nonempty current hunk ranges intersect exact indexed symbol spans. File content and graph version must match before symbol mapping. Nested symbols can both intersect a changed range. Module-level changes and deletion-only hunks use separate file-level context.
- **Evidence**: `callers` contains current resolved-symbol impact. `fileFallback` contains broader incoming file dependencies. `dependencies` contains outgoing context, not affected callers. Each aggregate result has `causedBy`: zero-based indexes into `targets`. Tests and documentation are separate sections.
- **Unknowns**: removed ranges/files and old rename paths report `historical-impact-unavailable`. This includes replacements that remove old lines. No historical graph is built. Unindexed, stale, conflicted, binary, oversized, or unreadable files appear in `gaps`; empty results never prove safety. Git-recognized renames retain `oldPath`; other moves appear as deletion/addition. A staged-deleted file recreated on disk is reported as `untracked`, with `oldPath` recording its removed tracked path.
- **Bounds**: depth 1–3, result limit 1–100 per section, files 1–200, targets 1–50. Source inspection is capped at 512 KiB per file. Each Git command has a 5-second timeout and 2 MiB output cap. File analysis has a 10-second scheduling budget. Each impact walk is capped at 200 nodes/1000 edges, with at most 10 affected-file test lookups per target. At most 20 hunk ranges per file are returned; `omittedRanges` reports the rest. Aggregate omitted counts cover known candidates, not undiscovered graph nodes.
- **Safety**: no checkout, staging, external diff, or textconv. Reads are not an atomic filesystem snapshot. Normal query reconciliation can update the local CodeLens index, but not repository files or Git state.

## Relationship evidence

Graph results add a `chain` of edges. Each edge carries `fromPath`, `toPath`,
`edgeType`, `reversed`, `confidence`, `method`, and endpoint `resolution`
(`symbol` or `file`). Resolved symbol IDs/names and a source line range are
included when available. `method` is `ast`, `path-heuristic`,
`explicit-reference`, or `unavailable` for legacy evidence.

Confidence is the minimum heuristic score across the selected chain, not a
probability. The selected chain is shortest; ties prefer greater confidence.
An intermediate stale file marks the chain stale. Work bounds are 1000 nodes
and 5000 scanned edges by default. Check `truncated` (`relatedTruncated` for
search; `truncated.graph` for exploration). Depth remains capped at 3 for
related/impact queries. `imported_by` is the incoming view of `imports`.

`documents` edges come from explicit local Markdown links, reference-style
links, and inline-code paths. A `path#Scope.name` fragment must resolve uniquely;
GitHub-style line fragments remain file references. Links use source-document
line evidence. No URLs are fetched. Fenced examples, repository escapes, and
unsupported code grammars are excluded. Documents above 512 KiB remain text-only.

## cl_path
- **Input**: `{ from: string, to: string, direction?: "out"|"in"|"both"="out", types?: string[], depth?: number=6, maxNodes?: number=1000, maxEdges?: number=5000 }`
- **Targets**: two indexed file paths or two symbols (`path#Scope.name` or an unambiguous exact name). Mixed file/symbol targets are rejected.
- **Returns**: `{ indexId, found, status, from?, to?, candidates?, chain, confidence?, truncated, visited, depth, stale?, freshness, pendingFiles?, note }`
- **Status**: `found`, `unresolved`, `incompatible-targets`, or `not-found-within-limits`. A negative result is not proof that no relationship exists.
- **Bounds**: depth 1–12, nodes 1–5000, scanned edges 1–20000. Default edge types are structural; request `documents` explicitly for document paths.
- **Use**: explain a static connection. This is not a runtime execution trace. `reversed:true` marks a hop traversed against the stored edge direction.

## cl_overview
- **Input**: `{ limit?: number=10, maxNodes?: number=1000, maxEdges?: number=5000 }`
- **Returns**: `{ indexId, counts, communities, hubs, bridges, cycles, omitted, inputTruncated, communitiesConverged, truncated, freshness, pendingFiles?, note }`
- **Bounds**: 1–50 items per section, at most 5000 scanned files and 20000 scanned structural edges. Community members are capped at 10; cycle members at 20.
- **Use**: orient in a repository. Groups use deterministic label propagation with at most 20 rounds. Hubs use dependency degrees. Bridges are cross-group edges, not cut-edge proofs. Cycles are strongly connected components, not enumerated paths.
- **Caveats**: groups are heuristic, not architecture boundaries. Check convergence and all truncation fields. Documents, self-file edges, and unsupported code grammars are excluded. Analysis runs on demand, not on every search.

## cl_tour
- **Input**: `{ start?: string, limit?: number=8 }`
- **Returns**: `{ indexId, status, stops, omittedStops, truncated, freshness, pendingFiles?, note }`
- **Status**: `ready`, `empty`, or `unresolved-start`.
- **Use**: obtain a short reading sequence. Omit `start` for a repository tour, or pass an indexed code-file path for a focused tour. Symbols are not accepted as starting targets.
- **Stops**: each stop has `path`, `kind`, `source`, up to three indexed `symbols`, `omittedSymbols`, `reason`, and a `chain`. Relationship reasons name their `anchor`; the chain does not necessarily start at the preceding stop. Root reasons have no connecting chain and start separate reading sections. Test/document stops provide context, not proof of test coverage.
- **Bounds**: 1–20 stops. Repository selection reuses the bounded overview; each dependency walk has depth 3 and caps of 200 nodes/1000 edges. Candidate storage is capped at 200 paths. Test/document lookups are bounded. Check `truncated`, `omittedStops`, and stale evidence; omission counts cover discovered candidates only.
- **Caveat**: this is a deterministic reading aid, not an execution trace or authoritative architecture. Source locations are indexed; use `cl_expand` to inspect current content.

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