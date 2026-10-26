# How CodeLens works

CodeLens is a **branch-aware local code knowledge retrieval engine**. It indexes
the current repo/branch into SQLite and lets coding agents ask "what code is
relevant to X?" via compact ranked handles — instead of grep/find/read flooding
their context window. No chat LLM is used anywhere in the core path.

## Architecture

```
Agent (Pi / Claude Code / Cursor / Gemini / Kiro / opencode / Codex)
   │  MCP stdio
   ▼
CodeLens MCP server  ──▶  CLI (codelens <subcommand>)
   │
   ├── Git scope detector        (repo / worktree / branch / HEAD / dirty)
   ├── Index manager             (per-branch index identity)
   ├── File scanner              (.gitignore-aware, binary/size filters)
   ├── FTS5 indexer              (structure-aware chunks + content hash)
   ├── Tree-sitter symbol extractor (11 grammars, text fallback)
   ├── Source graph builder      (structural edges + explicit documentation links)
   ├── Graph query               (bounded evidence-bearing BFS)
   ├── Architecture summary      (dependency groups / hubs / bridges / SCCs)
   ├── Freshness checker          (mtime/size fast → hash on suspicion)
   ├── TTL pruner                (never-delete guards)
   ├── Saved-context store       (separate DB, survives rebuilds)
   └── Usage tracker             (global, actual-file-size savings)
   │
   ▼
SQLite
   ├── per-branch index DB  (~/.codelens/indexes/index-<repoId>.db)
   ├── saved-contexts DB   (~/.codelens/contexts/contexts-<repoId>.db)
   └── global usage DB     (~/.codelens/usage.db)
```

## The index layers

1. **Files**: path, language, size, mtime, content hash.
2. **FTS5 lexical**: structure-aware code chunks with line-based fallback and
   Porter-stemming/BM25 ranking. Code files with extractable symbols are chunked
   around outermost functions/classes/methods/types; oversized symbols and non-structural
   gaps (imports, top-level statements, inter-symbol regions) are line-chunked.
   Leading comment/decorator blocks are attached to the following symbol chunk.
   Line fallback uses small overlap to reduce boundary loss. Chunks carry
   `code` vs `prose`, `chunker`, `chunker_version`, and `symbol_id` when aligned
   to a symbol. The match-only FTS text preserves the original chunk and appends
   bounded, deduplicated identifier subtokens (for example `validateSession` →
   `validate session`) so code-identifier queries can match without changing
   snippets or `cl_expand` content.
3. **Symbols** (tree-sitter): functions/classes/methods/types/exports/imports
   with line ranges + signatures + exported flag. Parser-eligible files are
   parsed once and the same tree-sitter tree is reused for symbols and edges;
   structure-aware chunking consumes those extracted symbol ranges. 11 grammars
   shipped; unknown languages fall back to text-only FTS.
4. **Source graph**: edges `imports`, `calls`, `references`, `inherits`,
   `defines`, `belongs_to`, `exports`, `tests` (filename heuristics), and
   `documents` (explicit Markdown references). Edges retain endpoint identity,
   extraction method, and available source spans. Supported TS/JS and Python
   forms resolve calls to current symbols. Resolution handles TS ESM
   `.js`→`.ts` substitution plus exact repo-local Python modules/packages.
   Unresolved imports are omitted. Unsupported symbol forms remain file-level
   or unresolved; static edges do not establish runtime execution.
5. *(No vector/semantic layer — removed; ranking is FTS + symbol + graph.)*

## Branch isolation (the core idea)

Every index is scoped to `repoRoot + worktreePath + branch + HEAD`:

```
index_id = sha256(repoRoot | worktreePath | branch | headSha)
```

Every table row carries `index_id`; every query filters by it. So `git checkout`
activates/creates a different index automatically — results from `main` never
leak into `feature-b`. `cl_current` reports which index is active.

## Freshness (local files are source of truth)

Before query tools answer (`cl_search`, `cl_explore`, `cl_related`, `cl_impact`, `cl_map`, `cl_path`, `cl_overview`, `cl_diff`, `cl_tour`), `ensureFreshIndex` runs:
1. Detect current git scope → activate/create the branch index.
2. Scan files, diff `mtime`+`size` vs indexed rows (fast); hash only
   changed/suspicious files.
3. Reindex changed/new files in per-file transactions; drop deleted. Files with
   chunks from an older/unknown `chunker_version` are also treated as changed, so
   chunker improvements roll forward on the next refresh. A per-file
   `graph_version` also invalidates old extraction, including legacy indexes.
   Symbol endpoints are relinked after each full or incremental batch. Target
   edits clear obsolete IDs before relinking unchanged callers and documents.
   Inventory changes also refresh unchanged Markdown references; deferred
   documents remain pending until processed.
4. Budget-bounded (default 500ms); if incomplete, surface
   `freshness:"partial"` + `pendingFiles`. A chunker-version bump can require a
   full budget-bounded re-chunk over several refresh cycles.

`cl_expand` **always reads current disk** (never stale stored text). A file
watcher (server mode) short-circuits the scan when nothing changed, with a 5s
periodic full-scan backstop.

Normal MCP request setup resolves Git scope once and passes a copied request
context to the tool handler. Scope is not cached across requests or stored on
the shared daemon context. Standalone callers still resolve scope when needed.
Git status runs with `GIT_OPTIONAL_LOCKS=0`, so status observation does not
refresh the Git index and create false watcher events. Real edits and checkouts
still reach the watcher. Startup root validation and deliberate safety checks,
such as the final diff scope check, remain separate.

**Edit behavior:** when the agent edits a file, the *next query tool call*
auto-refreshes and reindexes it (lazy, not eager at edit time). If the refresh
budget is exhausted, known-stale paths are surfaced with `stale:true` and
`freshness:"partial"` so the agent can read those files directly.

## Ranking (hybrid)

`cl_search` fuses lexical, structural, graph, path, and code/prose signals with
weights from `src/search/rank.ts`:

```
score = fts×0.34 + symbol×0.18 + graph×0.22 + code×0.08 + path×0.08 + exact×0.10
```

- `fts`: BM25 normalized. Queries are expanded with the same bounded identifier
  splitter used at index time, then quoted through the FTS path; expansion is
  capped to avoid broadening queries or hurting latency.
- `symbol`: full signal when the chunk's `symbol_id` name partially matches a
  query term; lower-strength file-level symbol match is kept as fallback.
- `exact`: full signal when the chunk's `symbol_id` name exactly matches a query
  term; lower-strength file-level exact match is kept as fallback.
- `graph`: 1 if the file is graph-proximate to top lexical results.
- `path`: query term appears in the file path/name.
- `code`: modest boost for `code` chunks over `prose` (docs), so code discovery
  isn't drowned out by markdown. Pass `contentType:"code"` to filter to source
  only.

`cl_related` uses indexed adjacency queries and a bounded BFS over `edges`.
Traversal is direction-aware, cycle-guarded, and depth-capped at 3. Each result
includes a selected shortest evidence chain. Equal-length ties prefer greater
minimum edge confidence. Scores are heuristics, not probabilities. Stale
intermediates mark the complete chain stale. Node/edge caps report truncation.

## Static paths and architecture summaries

`cl_path` reuses the traversal for two file targets or two resolved symbol
targets. Qualified names use `path#Scope.name`. It returns explicit unresolved,
mixed-granularity, and not-found-within-limits statuses rather than guessing.

`cl_overview` loads a bounded structural file graph on demand. Deterministic
label propagation yields navigation groups. Dependency degrees identify hubs;
cross-group edges supply bridge evidence. Iterative strongly connected
components identify cycles without recursive call-stack risk. Groups are
heuristic. Truncation and convergence fields describe incomplete analysis.

`documents` links do not become callers or architecture dependencies. Local
Markdown links, reference-style links, and inline-code file references are
resolved against the scanned code inventory with repository path guards.
Symbol fragments must resolve uniquely. Fenced examples and external URLs are
excluded. No LLM or network service is involved. Document extraction shares the
512 KiB structural limit; larger documents retain text search.

## Diff impact and reading tours

`cl_diff` resolves a base commit and reads bounded Git path records and hunks.
The comparison is against the working tree, including untracked files. Current
content hashes and graph versions guard line-to-symbol mapping. Exact symbol
IDs feed the existing impact analysis; file context remains separate. Deleted
ranges and old rename paths have no historical graph evidence. Coverage gaps
and work/output limits remain explicit. External diff and textconv are disabled.

`cl_tour` selects representative roots from the existing bounded overview, or
uses a supplied indexed file. Existing bounded traversal supplies dependency
chains. Indexed symbols provide source locations; test and document edges add
reading context. Roots are separate sections. No semantic summaries or runtime
entrypoints are inferred. Both tools reuse the current branch index without a
new graph store, schema, dependency, or LLM.

## Concurrency & recovery

- **WAL mode** + a single-writer queue + a cross-process advisory lease
  (`index_locks`) so two agent processes on the same repo never corrupt rows;
  readers see the prior committed snapshot.
- **Corruption recovery:** `PRAGMA quick_check` on startup + on query error →
  rebuild the core index. Saved contexts live in a **separate DB** and survive.
- **Schema versioning:** version guard refuses a newer-than-code DB; migrations
  are transactional with a pre-migration backup.

## TTL

Inactive indexes are pruned automatically (startup + periodic): inactive branch
14d, detached 3d, worktree 48h. **Never** deletes the active index, pinned
indexes, locked indexes, or recently-accessed ones. `cl_prune` (manual),
`cl_drop` (explicit, refuses active/pinned).

## Saved contexts

`cl_save`/`cl_load` persist named handle sets + notes in a **separate**
contexts DB (`~/.codelens/contexts/`), keyed by repo. They survive core-index
rebuilds. Items reference path+symbol (stable across reindex), not chunk ids.
Pin to prevent TTL deletion.

## Usage tracking

Global (`~/.codelens/usage.db`): per-tool calls, bytes served, and an estimated
context saving computed from **actual indexed file sizes** of the result files.
Discovery tools (`cl_search`, `cl_explore`, `cl_related`, `cl_impact`) accrue savings. See
[`docs/usage-metrics.md`](usage-metrics.md).

## Distribution

Currently builds from source (Node ≥ 22.5) via `install.sh`/`install.ps1`,
which also wires agent configs + slash commands. A self-contained bundle
(vendored Node) like some other tools is future work once published. The `cl_*`
MCP tools are the same surface across every host.
