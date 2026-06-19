# How CodeLens works

CodeLens is a **branch-aware local code knowledge retrieval engine**. It indexes
the current repo/branch into SQLite and lets coding agents ask "what code is
relevant to X?" via compact ranked handles — instead of grep/find/read flooding
their context window. No chat LLM is used anywhere in the core path.

## Architecture

```
Agent (Pi / Claude Code / Cursor / Gemini / opencode / Codex)
   │  MCP stdio
   ▼
CodeLens MCP server  ──▶  CLI (codelens <subcommand>)
   │
   ├── Git scope detector        (repo / worktree / branch / HEAD / dirty)
   ├── Index manager             (per-branch index identity)
   ├── File scanner              (.gitignore-aware, binary/size filters)
   ├── FTS5 indexer              (line-bounded chunks + content hash)
   ├── Tree-sitter symbol extractor (11 grammars, text fallback)
   ├── Source graph builder      (imports / defines / tests / belongs_to)
   ├── Graph query (recursive CTE + bounded BFS)
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
2. **FTS5 lexical**: line-bounded chunks (~2000 chars) with Porter-stemming;
   BM25 ranking. Chunks tagged `code` vs `prose`.
3. **Symbols** (tree-sitter): functions/classes/methods/types/exports/imports
   with line ranges + signatures + exported flag. 11 grammars shipped; unknown
   languages fall back to text-only FTS.
4. **Source graph**: edges `imports`, `defines`, `belongs_to`, `exports`,
   `tests` (filename heuristics). Resolution handles TS ESM `.js`→`.ts`
   substitution. Unresolved imports emit no edge (no wrong edges).
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

Before each `cl_search`, `ensureFreshIndex` runs:
1. Detect current git scope → activate/create the branch index.
2. Scan files, diff `mtime`+`size` vs indexed rows (fast); hash only
   changed/suspicious files.
3. Reindex changed/new files in per-file transactions; drop deleted.
4. Budget-bounded (default 500ms); if incomplete, surface
   `freshness:"partial"` + `pendingFiles`.

`cl_expand` **always reads current disk** (never stale stored text). A file
watcher (server mode) short-circuits the scan when nothing changed, with a 5s
periodic full-scan backstop.

**Edit behavior:** when the agent edits a file, the *next* `cl_search`
auto-refreshes and reindexes it (lazy, not eager at edit time). Demonstrated:
inject a new symbol → next search finds it.

## Ranking (hybrid)

`cl_search` fuses three signals with weights summing to 1:

```
score = fts×0.40 + symbol×0.22 + graph×0.28 + code×0.10
```

- `fts`: BM25 normalized.
- `symbol`: 1 if a symbol name matches a query term.
- `graph`: 1 if the file has graph edges (it's a connected node).
- `code`: 0.10 boost for `code` chunks over `prose` (docs), so code discovery
  isn't drowned out by markdown. Pass `contentType:"code"` to filter to source
  only.

`cl_related` runs a recursive-CTE BFS over the `edges` table (direction-aware,
cycle-guarded, depth-capped at 3).

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
Only `cl_search`/`cl_related` accrue savings. See
[`docs/usage-metrics.md`](usage-metrics.md).

## Distribution

Currently builds from source (Node ≥ 22.5) via `install.sh`/`install.ps1`,
which also wires agent configs + slash commands. A self-contained bundle
(vendored Node) like some other tools is future work once published. The `cl_*`
MCP tools are the same surface across every host.